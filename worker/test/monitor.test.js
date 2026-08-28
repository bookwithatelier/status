/**
 * Tests for the parts of the monitor that make judgements.
 *
 * Run with `npm test` (node --test, no dependencies, no Workers runtime).
 *
 * The escalation logic is the part worth testing, because both of its failure
 * modes are silent. Alert too eagerly and every blip pages somebody, which
 * ends with the alerts being filtered — and a filtered alert is exactly how
 * the 2026-08-28 outage ran for four and a half hours with a working detector
 * already printing "FRONT DOOR DOWN". Alert too reluctantly and there is no
 * detection at all. Neither shows up as a crash.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { reconcile } from '../src/state.js';
import { dueTargets, privateTargets, TIERS } from '../src/targets.js';
import { NORMALISERS, VENDORS, vendorSummary } from '../src/vendors.js';
import { humanDuration, smsBody } from '../src/alerts.js';

const NOW = 1_800_000_000;
const tenant = TIERS.tenant;

const fail = (reasons = ['env_file_unreadable']) => ({
  status: 'fail',
  code: 503,
  ms: 40,
  reasons,
  site: 'timberlodgeparlor.com',
  frontDoor: 503,
});
const ok = () => ({ status: 'ok', code: 200, ms: 30, reasons: [], site: 'x', frontDoor: null });
const degraded = () => ({
  status: 'degraded',
  code: 200,
  ms: 30,
  reasons: ['cron_stale'],
  site: 'x',
  frontDoor: null,
});

test('a healthy site says nothing and writes nothing', () => {
  const previous = { status: 'ok', since: NOW - 5000, alertedAt: 0, code: 200, reasons: [] };
  const { alert, changed } = reconcile(previous, ok(), tenant, NOW);
  assert.equal(alert, null);
  assert.equal(changed, false, 'a steady green tick must not spend a KV write');
});

test('the first bad tick is not an alert', () => {
  const { alert, entry } = reconcile(null, fail(), tenant, NOW);
  assert.equal(alert, null, 'one bad response is a blip, not an outage');
  assert.equal(entry.status, 'fail');
  assert.equal(entry.since, NOW);
});

test('a failure that persists past the debounce alerts exactly once', () => {
  const started = { status: 'fail', since: NOW - tenant.failAfter - 1, alertedAt: 0, code: 503, reasons: [] };

  const first = reconcile(started, fail(), tenant, NOW);
  assert.equal(first.alert.kind, 'down');
  assert.ok(first.alert.forSeconds >= tenant.failAfter);

  // Same outage, one minute later: still down, already announced, not due for
  // a repeat. Silence, and no write.
  const second = reconcile(first.entry, fail(), tenant, NOW + 60);
  assert.equal(second.alert, null);
  assert.equal(second.changed, false);
});

test('a long outage is repeated on the renotify interval, not every tick', () => {
  const alerted = {
    status: 'fail',
    since: NOW - 7200,
    alertedAt: NOW - tenant.renotifySeconds - 1,
    code: 503,
    reasons: [],
  };
  const { alert, entry } = reconcile(alerted, fail(), tenant, NOW);
  assert.equal(alert.kind, 'still-down');
  assert.equal(entry.alertedAt, NOW);
});

test('recovery is announced only when the problem was announced', () => {
  const announced = { status: 'fail', since: NOW - 3600, alertedAt: NOW - 3000, code: 503, reasons: [] };
  const recovered = reconcile(announced, ok(), tenant, NOW);
  assert.equal(recovered.alert.kind, 'recovered');
  assert.equal(recovered.alert.from, 'fail');

  // A blip that never reached the threshold has no all-clear to give — nobody
  // was ever told there was a problem.
  const quiet = { status: 'fail', since: NOW - 30, alertedAt: 0, code: 503, reasons: [] };
  assert.equal(reconcile(quiet, ok(), tenant, NOW).alert, null);
});

test('recovery carries the status it is recovering from, so the all-clear is not louder than the alarm', () => {
  const announced = { status: 'degraded', since: NOW - 3600, alertedAt: NOW - 3000, code: 200, reasons: [] };
  const { alert } = reconcile(announced, ok(), tenant, NOW);
  assert.equal(alert.from, 'degraded', 'a degraded recovery must not be routed to SMS');
});

test('degraded waits far longer than a hard failure', () => {
  const justDegraded = { status: 'degraded', since: NOW - tenant.failAfter - 1, alertedAt: 0, code: 200, reasons: [] };
  assert.equal(
    reconcile(justDegraded, degraded(), tenant, NOW).alert,
    null,
    'stale cron at 90 seconds is a slow tick, not a fault'
  );

  const longDegraded = { status: 'degraded', since: NOW - tenant.degradedAfter - 1, alertedAt: 0, code: 200, reasons: [] };
  assert.equal(reconcile(longDegraded, degraded(), tenant, NOW).alert.kind, 'degraded');
});

test('a tier with no channel for a severity never alerts on it', () => {
  const prospect = TIERS.prospect;
  const stuck = { status: 'degraded', since: NOW - 999999, alertedAt: 0, code: 200, reasons: [] };
  assert.equal(
    reconcile(stuck, degraded(), prospect, NOW).alert,
    null,
    'nobody is acting at 3am on a stale cron for a site whose owner does not know it exists'
  );
});

test('a status change is always written, even inside the debounce', () => {
  const healthy = { status: 'ok', since: NOW - 5000, alertedAt: 0, code: 200, reasons: [] };
  const { changed, entry } = reconcile(healthy, fail(), tenant, NOW);
  assert.equal(changed, true, 'losing the start time would restart the debounce every tick');
  assert.equal(entry.since, NOW);
});

test('the tenant is checked every minute and the rest are dealt across their interval', () => {
  const targets = [
    { id: 'tlp', tier: 'tenant', url: 'https://a' },
    { id: 'bwa', tier: 'platform', url: 'https://b' },
    { id: 'studio', tier: 'platform', url: 'https://c' },
    ...Array.from({ length: 30 }, (_, i) => ({ id: `p${i}`, tier: 'prospect', url: `https://p${i}` })),
  ];

  for (let minute = 0; minute < 60; minute++) {
    const due = dueTargets(targets, minute);
    assert.ok(
      due.some((t) => t.id === 'tlp'),
      `the one real tenant must be checked at minute ${minute}`
    );
    assert.ok(
      due.length <= 6,
      `minute ${minute} queued ${due.length} checks; the free plan allows 50 subrequests per invocation and each check can make two`
    );
  }

  // Over any fifteen consecutive minutes every prospect comes up exactly once.
  const seen = new Map();
  for (let minute = 0; minute < 15; minute++) {
    for (const t of dueTargets(targets, minute)) {
      if (t.tier === 'prospect') {
        seen.set(t.id, (seen.get(t.id) || 0) + 1);
      }
    }
  }
  assert.equal(seen.size, 30);
  assert.ok([...seen.values()].every((n) => n === 1));
});

test('a malformed private target list never stops the tenant check', () => {
  assert.deepEqual(privateTargets({ PRIVATE_TARGETS: 'not json' }), []);
  assert.deepEqual(privateTargets({ PRIVATE_TARGETS: '{"nope":1}' }), []);
  assert.deepEqual(privateTargets({}), []);

  const good = privateTargets({
    PRIVATE_TARGETS: JSON.stringify([
      { id: 'a', name: 'A', url: 'https://a.example/', tier: 'prospect' },
      { id: 'b', url: 'https://b.example' },
      { url: 'https://no-id.example' },
      null,
    ]),
  });
  assert.equal(good.length, 2);
  assert.equal(good[0].url, 'https://a.example', 'trailing slash stripped so /health.php concatenates cleanly');
  assert.equal(good[1].tier, 'prospect', 'an unknown or missing tier falls back to the quietest one');
  assert.equal(good[1].name, 'b');
});

test('vendor status is summarised only when a vendor is actually unhappy', () => {
  assert.equal(
    vendorSummary({
      twilio: { name: 'Twilio', indicator: 'none' },
      stripe: { name: 'Stripe', indicator: 'unknown' },
    }),
    '',
    'an all-clear must not append "vendors: ..." to every message'
  );

  assert.equal(
    vendorSummary({
      twilio: { name: 'Twilio', indicator: 'major' },
      stripe: { name: 'Stripe', indicator: 'none' },
    }),
    'Twilio: major'
  );
});

test('the SMS leads with what broke', () => {
  const body = smsBody(
    { name: 'Timberlodge Parlor', url: 'https://timberlodgeparlor.com', tier: 'tenant' },
    fail(['env_file_unreadable']),
    { kind: 'down', forSeconds: 150 },
    'Twilio: minor'
  );

  assert.match(body, /Timberlodge Parlor/);
  assert.match(body, /DOWN/);
  assert.match(body, /env_file_unreadable/, 'the reason is the entire value of the message');
  assert.match(body, /3m/);
  assert.match(body, /Twilio: minor/);
  assert.ok(body.length < 320, 'has to survive being read on a lock screen');
});

test('duration reads naturally at every scale', () => {
  assert.equal(humanDuration(45), '45s');
  assert.equal(humanDuration(150), '3m');
  assert.equal(humanDuration(3600), '1h');
  assert.equal(humanDuration(16_200), '4h30m');
});

// ---------------------------------------------------------------------------
// Vendor status parsing.
//
// Added after the live endpoints proved the original assumption wrong: three
// of these five vendors publish three different shapes, and two of them 404
// on the Statuspage path we were using. That failure was invisible — an
// unreachable vendor and a wrong URL both degrade to 'unknown', so the
// monitor reported Stripe and Postmark as unknown indefinitely and nothing
// ever complained.
// ---------------------------------------------------------------------------

test('each vendor shape normalises into Statuspage vocabulary', () => {
  assert.equal(
    NORMALISERS.statuspage({ status: { indicator: 'major', description: 'Partial Outage' } }).indicator,
    'major'
  );
  assert.equal(NORMALISERS.stripe({ largestatus: 'up', message: 'All systems' }).indicator, 'none');
  assert.equal(NORMALISERS.stripe({ largestatus: 'degraded' }).indicator, 'minor');
  assert.equal(NORMALISERS.stripe({ largestatus: 'down' }).indicator, 'major');
  assert.equal(NORMALISERS.postmark({ page: { state: 'operational' } }).indicator, 'none');
  assert.equal(NORMALISERS.postmark({ page: { state: 'degraded_performance' } }).indicator, 'minor');
  assert.equal(NORMALISERS.postmark({ page: { state: 'major_outage' } }).indicator, 'critical');
});

test('an unrecognised vendor value is unknown, never all-clear', () => {
  // A vendor rewording its states must not read as "everything is fine" — the
  // whole point of this data is to be believed when it says something is off.
  assert.equal(NORMALISERS.statuspage({ status: { indicator: 'brand_new_word' } }).indicator, 'unknown');
  assert.equal(NORMALISERS.stripe({ largestatus: 'wobbly' }).indicator, 'unknown');
  assert.equal(NORMALISERS.postmark({ page: { state: 'having_a_moment' } }).indicator, 'unknown');
  assert.equal(NORMALISERS.statuspage({}).indicator, 'unknown');
  assert.equal(NORMALISERS.stripe({}).indicator, 'unknown');
  assert.equal(NORMALISERS.postmark({}).indicator, 'unknown');
});

test('every vendor declares a shape that has a normaliser', () => {
  for (const vendor of VENDORS) {
    assert.ok(
      NORMALISERS[vendor.shape],
      `${vendor.id} declares shape "${vendor.shape}" with no normaliser`
    );
  }
});
