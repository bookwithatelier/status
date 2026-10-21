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
import { canonicalTier, dueTargets, escalates, privateTargets, TIERS } from '../src/targets.js';
import { NORMALISERS, VENDORS, publicSnapshot, vendorSummary } from '../src/vendors.js';
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
const degraded = (reasons = ['cron_stale']) => ({
  status: 'degraded',
  code: 200,
  ms: 30,
  reasons,
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
  const preview = TIERS.preview;
  const stuck = { status: 'degraded', since: NOW - 999999, alertedAt: 0, code: 200, reasons: [] };
  assert.equal(
    reconcile(stuck, degraded(), preview, NOW).alert,
    null,
    'nobody is acting at 3am on a stale cron for a site whose owner does not know it exists'
  );
});

/**
 * The 2026-09-11 regression, as a test.
 *
 * Twenty-four preview sites reported `cron_stale` for twelve hours while
 * every cron run fataled on a poisoned container. Prospects are silent on
 * degraded by design, so nobody was told until the front doors began
 * returning 500 the next morning. `cron_dead` is the probe saying "this is
 * not a slow tick"; these tests are the Worker acting on it.
 */
test('a dead cron on a preview site opens an issue, where a stale one stays silent', () => {
  const preview = TIERS.preview;
  const stuck = { status: 'degraded', since: NOW - 999999, alertedAt: 0, code: 200, reasons: [] };

  assert.equal(
    reconcile(stuck, degraded(['cron_stale']), preview, NOW).alert,
    null,
    'late is still not worth waking anyone for'
  );

  const { alert, entry } = reconcile(stuck, degraded(['cron_stale', 'cron_dead']), preview, NOW);
  assert.equal(alert.severity, 'fail', 'it takes the fail channels — for the preview tier, the issue');
  assert.equal(alert.kind, 'degraded', 'but it is not called an outage: the site is serving');
  assert.equal(entry.escalated, true);
  assert.deepEqual(preview.channels[alert.severity], ['issue']);
});

test('an escalated alert uses the fail debounce, not the degraded one', () => {
  const preview = TIERS.preview;
  // The preview tier has degradedAfter 0 — the escalation has to bring its own
  // threshold or a single bad tick would file an issue.
  const brief = { status: 'degraded', since: NOW - 60, alertedAt: 0, code: 200, reasons: [] };
  assert.equal(
    reconcile(brief, degraded(['cron_stale', 'cron_dead']), preview, NOW).alert,
    null,
    'one minute of it is not yet worth an issue'
  );

  const sustained = { status: 'degraded', since: NOW - 3600, alertedAt: 0, code: 200, reasons: [] };
  assert.ok(reconcile(sustained, degraded(['cron_stale', 'cron_dead']), preview, NOW).alert);
});

/**
 * The bug this design would have had. The escalation is driven by the reason
 * list, and by the time the site recovers the reason is gone — so recovery
 * has to read what the ALARM did, not what the verdict says. Routing an
 * escalated preview site's all-clear by status alone sends it to the empty
 * degraded channel list and the issue stays open forever.
 */
test('recovery from an escalated degraded closes the issue it opened', () => {
  const preview = TIERS.preview;
  const announced = {
    status: 'degraded',
    since: NOW - 99999,
    alertedAt: NOW - 1000,
    code: 200,
    reasons: ['cron_stale', 'cron_dead'],
    escalated: true,
  };
  const { alert } = reconcile(announced, ok(), preview, NOW);
  assert.equal(alert.kind, 'recovered');
  assert.equal(alert.severity, 'fail', 'the all-clear follows the alarm');
  assert.deepEqual(preview.channels[alert.severity], ['issue']);
});

test('recovery from an ordinary degraded is still quiet for a preview site', () => {
  const preview = TIERS.preview;
  const announced = {
    status: 'degraded',
    since: NOW - 99999,
    alertedAt: NOW - 1000,
    code: 200,
    reasons: ['cron_stale'],
    escalated: false,
  };
  const { alert } = reconcile(announced, ok(), preview, NOW);
  assert.equal(alert.severity, 'degraded');
  assert.deepEqual(preview.channels[alert.severity], []);
});

test('escalation only ever applies to degraded, and only to listed reasons', () => {
  assert.equal(escalates('degraded', ['cron_dead']), true);
  assert.equal(escalates('degraded', ['cron_stale']), false);
  assert.equal(escalates('degraded', []), false);
  assert.equal(escalates('degraded', undefined), false);
  assert.equal(escalates('ok', ['cron_dead']), false);
  assert.equal(
    escalates('fail', ['cron_dead']),
    false,
    'a failure is already at fail severity; escalating it would be a no-op with a confusing name'
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
    ...Array.from({ length: 30 }, (_, i) => ({ id: `p${i}`, tier: 'preview', url: `https://p${i}` })),
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

  // Over any fifteen consecutive minutes every preview site comes up exactly once.
  const seen = new Map();
  for (let minute = 0; minute < 15; minute++) {
    for (const t of dueTargets(targets, minute)) {
      if (t.tier === 'preview') {
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
      { id: 'a', name: 'A', url: 'https://a.example/', tier: 'preview' },
      { id: 'b', url: 'https://b.example' },
      { url: 'https://no-id.example' },
      null,
    ]),
  });
  assert.equal(good.length, 2);
  assert.equal(good[0].url, 'https://a.example', 'trailing slash stripped so /health.php concatenates cleanly');
  assert.equal(good[1].tier, 'preview', 'an unknown or missing tier falls back to the quietest one');
  assert.equal(good[1].name, 'b');
});

/**
 * The secret is generated from the production box and pushed by hand, so a
 * deployed Worker and the PRIVATE_TARGETS it reads can disagree about the
 * spelling of a tier for as long as it takes somebody to re-run the sync.
 * `prospect` was that tier's name until 2026-09-12.
 */
test('the old tier spelling in PRIVATE_TARGETS still lands in the right tier', () => {
  assert.equal(canonicalTier('prospect'), 'preview');
  assert.equal(canonicalTier('tenant'), 'tenant');
  assert.equal(canonicalTier('nonsense'), 'preview', 'anything unrecognised gets the quietest tier');
  assert.equal(canonicalTier(undefined), 'preview');

  const [t] = privateTargets({
    PRIVATE_TARGETS: JSON.stringify([{ id: 'x', url: 'https://x.example', tier: 'prospect' }]),
  });
  assert.equal(t.tier, 'preview', 'normalised on the way in, so nothing downstream sees the old name');
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

// ---------------------------------------------------------------------------
// The two product-family feeds. Google and Apple publish every product's
// incidents in one document, so the normaliser has to pick out the products
// calendar sync actually touches — and a Gmail outage must not paint the
// calendar row red.
// ---------------------------------------------------------------------------

const googleVendor = VENDORS.find((v) => v.id === 'google');
const appleVendor = VENDORS.find((v) => v.id === 'apple');

test('google: only an open incident on a product we use counts', () => {
  const closed = { service_name: 'Google Calendar', status_impact: 'SERVICE_OUTAGE', begin: 'x', end: 'y' };
  const otherProduct = { service_name: 'Gmail', status_impact: 'SERVICE_OUTAGE', begin: 'x' };
  const open = {
    service_name: 'Google Calendar',
    status_impact: 'SERVICE_DISRUPTION',
    begin: 'x',
    external_desc: '**Summary:**\nCalendar invites are delayed.\n**Description:**\nmore',
  };

  assert.equal(NORMALISERS.google([], googleVendor).indicator, 'none');
  assert.equal(NORMALISERS.google([closed, otherProduct], googleVendor).indicator, 'none');
  const result = NORMALISERS.google([closed, otherProduct, open], googleVendor);
  assert.equal(result.indicator, 'minor');
  assert.equal(result.description, 'Calendar invites are delayed.', 'the headline is the first line, without the markdown label');
});

test('google: a multi-product incident is matched through its affected products', () => {
  const multi = {
    service_name: 'Multiple Products',
    status_impact: 'SERVICE_OUTAGE',
    begin: 'x',
    affected_products: [{ title: 'Gmail' }, { title: 'Google Calendar' }],
  };
  assert.equal(NORMALISERS.google([multi], googleVendor).indicator, 'major');
});

test('google: an impact word we have not seen, or a body that is not a list, is unknown', () => {
  const odd = { service_name: 'Google Calendar', status_impact: 'SERVICE_WOBBLE', begin: 'x' };
  assert.equal(NORMALISERS.google([odd], googleVendor).indicator, 'unknown');
  assert.equal(NORMALISERS.google({ incidents: [] }, googleVendor).indicator, 'unknown');
  assert.equal(NORMALISERS.google(null, googleVendor).indicator, 'unknown');
});

test('apple: only a live event on a service we use counts', () => {
  const feed = (events, serviceName = 'iCloud Calendar') => ({
    services: [
      { serviceName: 'Apple TV', events: [{ statusType: 'Outage', eventStatus: 'ongoing', message: 'TV is down' }] },
      { serviceName, events },
    ],
  });

  assert.equal(NORMALISERS.apple(feed([]), appleVendor).indicator, 'none', 'an Apple TV outage is not our problem');
  assert.equal(
    NORMALISERS.apple(feed([{ statusType: 'Outage', eventStatus: 'resolved', message: 'was down' }]), appleVendor).indicator,
    'none'
  );
  assert.equal(
    NORMALISERS.apple(feed([{ statusType: 'Maintenance', eventStatus: 'upcoming', message: 'later' }]), appleVendor).indicator,
    'none',
    'scheduled maintenance that has not started is not an incident'
  );
  const live = NORMALISERS.apple(
    feed([{ statusType: 'Issue', eventStatus: 'ongoing', message: 'Users may be unable to sync.' }]),
    appleVendor
  );
  assert.equal(live.indicator, 'minor');
  assert.equal(live.description, 'iCloud Calendar: Users may be unable to sync.');
  assert.equal(
    NORMALISERS.apple(feed([{ statusType: 'Outage', eventStatus: 'ongoing' }], 'iCloud Account & Sign In'), appleVendor).indicator,
    'major',
    'sign-in is upstream of every CalDAV request'
  );
});

test('apple: a new event status is treated as live, and a new status type as unknown', () => {
  const feed = (event) => ({ services: [{ serviceName: 'iCloud Calendar', events: [event] }] });
  assert.equal(
    NORMALISERS.apple(feed({ statusType: 'Outage', eventStatus: 'escalated' }), appleVendor).indicator,
    'major',
    'an unrecognised lifecycle word must not read as resolved'
  );
  assert.equal(NORMALISERS.apple(feed({ statusType: 'Hiccup', eventStatus: 'ongoing' }), appleVendor).indicator, 'unknown');
  assert.equal(NORMALISERS.apple({ services: 'nope' }, appleVendor).indicator, 'unknown');
  assert.equal(NORMALISERS.apple(undefined, appleVendor).indicator, 'unknown');
});

test('the worst live incident wins', () => {
  const feed = {
    services: [
      {
        serviceName: 'iCloud Calendar',
        events: [
          { statusType: 'Issue', eventStatus: 'ongoing', message: 'slow' },
          { statusType: 'Outage', eventStatus: 'ongoing', message: 'down' },
        ],
      },
    ],
  };
  assert.equal(NORMALISERS.apple(feed, appleVendor).indicator, 'major');
});

// ---------------------------------------------------------------------------
// The public snapshot. This is the one thing the Worker publishes without a
// token, so its shape is pinned here: a change that lets anything else
// through must fail a test, not a code review.
// ---------------------------------------------------------------------------

test('the public snapshot carries vendors only, in declaration order, and never anything else', () => {
  const stored = {
    twilio: { name: 'Twilio', indicator: 'major', description: 'SMS delays', secret: 'should not pass' },
    cloudflare: { name: 'Cloudflare', indicator: 'none', description: 'All Systems Operational' },
    // A key that is not a declared vendor — e.g. something a future refactor
    // stores alongside — must not surface.
    tlp: { url: 'https://timberlodgeparlor.com', status: 'fail' },
  };

  const snapshot = publicSnapshot(stored, 1792612800);

  assert.deepEqual(Object.keys(snapshot), ['as_of', 'vendors']);
  assert.equal(snapshot.as_of, '2026-10-21T20:00:00.000Z');
  assert.deepEqual(
    snapshot.vendors.map((v) => v.id),
    VENDORS.map((v) => v.id),
    'order is the VENDORS list, not whatever the stored object happens to hold'
  );
  for (const row of snapshot.vendors) {
    assert.deepEqual(Object.keys(row), ['id', 'name', 'role', 'indicator', 'description']);
  }
  assert.equal(snapshot.vendors.find((v) => v.id === 'twilio').indicator, 'major');
  assert.equal(snapshot.vendors.find((v) => v.id === 'anthropic').indicator, 'unknown', 'a vendor not yet in the snapshot is unknown, not omitted');
  assert.ok(!JSON.stringify(snapshot).includes('timberlodgeparlor'), 'nothing outside the vendor list leaks');
  assert.ok(!JSON.stringify(snapshot).includes('should not pass'));
});

test('the public snapshot survives an empty or malformed store', () => {
  assert.equal(publicSnapshot(undefined, undefined).as_of, null);
  assert.equal(publicSnapshot(undefined, undefined).vendors.length, VENDORS.length);
  assert.equal(publicSnapshot({ twilio: 'garbage' }, 0).vendors.find((v) => v.id === 'twilio').indicator, 'unknown');
});

test('vendor URLs are their final hosts — a redirect is one more thing to break', () => {
  for (const vendor of VENDORS) {
    assert.ok(vendor.url.startsWith('https://'), `${vendor.id} must be fetched over https`);
    assert.ok(vendor.role, `${vendor.id} needs a one-line role for the public strip`);
  }
  const hosts = VENDORS.map((v) => new URL(v.url).host);
  assert.ok(!hosts.includes('status.anthropic.com'), 'Anthropic moved its status page to status.claude.com');
  assert.ok(!hosts.includes('status.shopify.com'), 'Shopify redirects to www.shopifystatus.com');
  assert.equal(new Set(VENDORS.map((v) => v.id)).size, VENDORS.length, 'vendor ids are unique');
});
