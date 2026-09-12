/**
 * One whole tick, against a stubbed network and a fake KV binding.
 *
 * The unit tests cover each part's judgement. This covers the wiring between
 * them — probe → reconcile → dispatch — which is where a bug would pass every
 * other test and still mean nobody gets told.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { runChecks } from '../src/index.js';

/** A minute at which only the tenant is due (see dueTargets). */
const MINUTE_3 = Date.UTC(2026, 7, 28, 9, 3, 0);

function fakeKv() {
  const store = new Map();
  return {
    store,
    get: async (key, opts) => {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return opts?.type === 'json' ? JSON.parse(raw) : raw;
    },
    put: async (key, value) => {
      store.set(key, value);
    },
  };
}

/**
 * Installs a fetch stub and returns the log of what was requested.
 *
 * `routes` maps a URL substring to a {status, body} response; anything
 * unmatched throws, which models an unreachable host.
 */
function stubFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const href = typeof url === 'string' ? url : url.url;
    calls.push({ url: href, method: init?.method || 'GET', body: init?.body });
    for (const [needle, response] of Object.entries(routes)) {
      if (href.includes(needle)) {
        return new Response(response.body ?? '', { status: response.status ?? 200 });
      }
    }
    throw new Error('ECONNREFUSED');
  };
  return calls;
}

const healthy = JSON.stringify({ status: 'ok', site: 'timberlodgeparlor.com', reasons: [] });

function baseEnv(kv) {
  return {
    STATE: kv,
    MONITOR_TOKEN: 'tok',
    // No Twilio and no GitHub credentials: dispatch must degrade to a logged
    // warning, never to an exception that kills the rest of the tick.
  };
}

test('a healthy tenant produces no alert and no KV write', async () => {
  const kv = fakeKv();
  stubFetch({ 'timberlodgeparlor.com/health.php': { status: 200, body: healthy } });

  const summary = await runChecks(baseEnv(kv), MINUTE_3);

  assert.equal(summary.results[0].status, 'ok');
  assert.equal(kv.store.size, 0, 'a first healthy tick has nothing worth persisting');
});

test('the front door is only consulted when the health endpoint does not answer', async () => {
  const kv = fakeKv();
  const calls = stubFetch({ 'timberlodgeparlor.com/health.php': { status: 200, body: healthy } });

  await runChecks(baseEnv(kv), MINUTE_3);

  assert.equal(calls.length, 1, 'the happy path must cost exactly one subrequest');
});

test('a 503 from the endpoint is believed, and its reasons are carried through', async () => {
  const kv = fakeKv();
  stubFetch({
    'timberlodgeparlor.com/health.php': {
      status: 503,
      body: JSON.stringify({ status: 'fail', site: 'timberlodgeparlor.com', reasons: ['env_file_unreadable'] }),
    },
    'https://timberlodgeparlor.com': { status: 503, body: 'nope' },
  });

  const summary = await runChecks(baseEnv(kv), MINUTE_3);

  assert.equal(summary.results[0].status, 'fail');
  assert.deepEqual(summary.results[0].reasons, ['env_file_unreadable']);

  const state = JSON.parse(kv.store.get('monitor-state-v1'));
  assert.equal(state.tlp.status, 'fail');
  assert.equal(state.tlp.alertedAt, 0, 'one bad tick is a blip — nothing has been announced yet');
});

test('a broken health endpoint on a serving site is degraded, not an outage', async () => {
  const kv = fakeKv();
  stubFetch({
    'timberlodgeparlor.com/health.php': { status: 404, body: 'Not found' },
    'https://timberlodgeparlor.com': { status: 200, body: '<html>the site</html>' },
  });

  const summary = await runChecks(baseEnv(kv), MINUTE_3);

  assert.equal(
    summary.results[0].status,
    'degraded',
    'shipping a bug to health.php must not page anyone about a site that is serving customers'
  );
  assert.deepEqual(summary.results[0].reasons, ['health_endpoint_missing']);
});

test('an unreachable site is a hard failure', async () => {
  const kv = fakeKv();
  stubFetch({});

  const summary = await runChecks(baseEnv(kv), MINUTE_3);

  assert.equal(summary.results[0].status, 'fail');
  assert.deepEqual(summary.results[0].reasons, ['site_unreachable']);
});

test('a 200 that is not our JSON is not a green light', async () => {
  const kv = fakeKv();
  stubFetch({ 'timberlodgeparlor.com/health.php': { status: 200, body: '<html>parked</html>' } });

  const summary = await runChecks(baseEnv(kv), MINUTE_3);

  assert.equal(summary.results[0].status, 'degraded');
  assert.deepEqual(summary.results[0].reasons, ['health_endpoint_unrecognised']);
});

test('a sustained outage alerts once, and unconfigured channels do not throw', async () => {
  const kv = fakeKv();
  stubFetch({
    'timberlodgeparlor.com/health.php': {
      status: 503,
      body: JSON.stringify({ status: 'fail', reasons: ['database_unreachable'] }),
    },
    'https://timberlodgeparlor.com': { status: 502, body: '' },
  });

  const env = baseEnv(kv);
  await runChecks(env, MINUTE_3);
  // Two minutes later, still down: past the 90-second tenant debounce.
  await runChecks(env, MINUTE_3 + 120_000);

  const state = JSON.parse(kv.store.get('monitor-state-v1'));
  assert.ok(state.tlp.alertedAt > 0, 'the outage should have been announced by now');
});

test('a KV read failure does not stop the checks', async () => {
  const broken = {
    get: async () => {
      throw new Error('KV is having a day');
    },
    put: async () => {},
  };
  stubFetch({ 'timberlodgeparlor.com/health.php': { status: 200, body: healthy } });

  const summary = await runChecks({ ...baseEnv(broken), STATE: broken }, MINUTE_3);
  assert.equal(summary.results[0].status, 'ok');
});

/**
 * The whole chain for a dead cron on a prospect, end to end.
 *
 * Every part of this passes its own unit tests whether or not the issue is
 * actually filed — the probe returns degraded, reconcile returns an alert,
 * dispatch reads a channel list. The thing worth asserting is the POST to
 * GitHub, because on 2026-09-11 the equivalent path stayed quiet for twelve
 * hours and nothing anywhere logged a problem.
 */
test('a prospect whose cron has stopped ends up with a GitHub issue', async () => {
  const kv = fakeKv();
  const calls = stubFetch({
    'skin.example/health.php': {
      status: 200,
      body: JSON.stringify({
        status: 'degraded',
        site: 'tc46a1ec169911c5e',
        reasons: ['cron_stale', 'cron_dead'],
      }),
    },
    'api.github.com/search/issues': { status: 200, body: JSON.stringify({ items: [] }) },
    'api.github.com/repos': { status: 201, body: JSON.stringify({ number: 99 }) },
  });

  const env = {
    ...baseEnv(kv),
    ALERT_ISSUE_REPO: 'bookwithatelier/atelier',
    GITHUB_PAT: 'pat',
    PRIVATE_TARGETS: JSON.stringify([
      { id: 'skin', name: 'Skin', url: 'https://skin.example', tier: 'prospect' },
    ]),
  };

  // Already degraded for two hours, so the fail debounce (1800s) is satisfied
  // — the same shape the real fleet was in all of 2026-09-11.
  kv.store.set(
    'monitor-state-v1',
    JSON.stringify({
      skin: { status: 'degraded', since: Math.floor(MINUTE_3 / 1000) - 7200, alertedAt: 0, code: 200, reasons: ['cron_stale'] },
    })
  );

  await runChecks(env, MINUTE_3);

  const opened = calls.find((c) => c.method === 'POST' && c.url.includes('/issues'));
  assert.ok(opened, 'a stopped cron on a prospect must reach the issue channel');
  const payload = JSON.parse(opened.body);
  assert.match(payload.title, /Degraded \(escalated\): Skin/);
  assert.match(payload.title, /\[monitor:skin\]/, 'the marker is how the recovery finds it again');
  assert.match(payload.body, /cron_dead/, 'the body has to name what actually stopped');
  assert.deepEqual(payload.labels, ['outage']);
});

/**
 * The control: the same site with an ordinary stale cron stays silent, which
 * is the behaviour 24 permanently-degraded prospects depend on.
 */
test('a prospect with a merely stale cron files nothing', async () => {
  const kv = fakeKv();
  const calls = stubFetch({
    'skin.example/health.php': {
      status: 200,
      body: JSON.stringify({ status: 'degraded', site: 'tc46a1ec169911c5e', reasons: ['cron_stale'] }),
    },
  });

  const env = {
    ...baseEnv(kv),
    ALERT_ISSUE_REPO: 'bookwithatelier/atelier',
    GITHUB_PAT: 'pat',
    PRIVATE_TARGETS: JSON.stringify([
      { id: 'skin', name: 'Skin', url: 'https://skin.example', tier: 'prospect' },
    ]),
  };
  kv.store.set(
    'monitor-state-v1',
    JSON.stringify({
      skin: { status: 'degraded', since: Math.floor(MINUTE_3 / 1000) - 7200, alertedAt: 0, code: 200, reasons: ['cron_stale'] },
    })
  );

  await runChecks(env, MINUTE_3);

  assert.equal(
    calls.filter((c) => c.url.includes('api.github.com')).length,
    0,
    'a slow tick on a preview site is still nobody\'s emergency'
  );
});
