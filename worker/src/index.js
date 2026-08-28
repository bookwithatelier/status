/**
 * Atelier outage monitor — the minute-level half.
 *
 * Runs on Cloudflare's cron trigger every minute, checks whichever sites are
 * due, and escalates on a per-tier policy: SMS for the one real tenant going
 * hard down, a GitHub issue in the private repo for everything else.
 *
 * WHY THIS EXISTS ALONGSIDE UPPTIME
 * ---------------------------------
 * They cover each other's blind spot, and collapsing them into one would
 * reintroduce it.
 *
 *   This Worker runs on Cloudflare, so it cannot detect a Cloudflare outage.
 *   Upptime runs on GitHub, so it keeps checking when Cloudflare is what
 *   broke — but GitHub's `schedule:` is best-effort and routinely runs five to
 *   fifteen minutes late, which is too slow to be the only detector for a
 *   working salon.
 *
 * So: this one is fast and detailed and blind to its own host; that one is
 * slow and independent. Both, or neither is trustworthy.
 *
 * WHAT IT NEVER DOES
 * ------------------
 * It never routes anything through the platform's own notification stack —
 * that stack lives on the machine being watched. It never alerts a tenant.
 * See alerts.js.
 */

import { allTargets, dueTargets, TIERS } from './targets.js';
import { probe } from './probe.js';
import { loadState, saveState, reconcile } from './state.js';
import { vendorStatuses, vendorSummary } from './vendors.js';
import { fileIssue, issueBody, sendSms, smsBody } from './alerts.js';

export default {
  /**
   * The cron entry point. One trigger, every minute; the tiers are decided
   * here rather than with three separate cron expressions, so that adding a
   * tier is a data change and not a deployment-config change.
   */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runChecks(env));
  },

  /**
   * A small read-only view of the current state, for debugging.
   *
   * Behind a bearer token, and that is not optional: the state map contains
   * every prospect target's hostname, which is exactly the list this whole
   * design exists to keep unpublished. With no token configured the endpoint
   * refuses rather than opening up.
   */
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/healthz') {
      return new Response('ok\n', { headers: { 'content-type': 'text/plain' } });
    }

    const expected = env.DASHBOARD_TOKEN;
    const provided = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    if (!expected || provided !== expected) {
      return new Response('Not found\n', { status: 404 });
    }

    if (url.pathname === '/run') {
      const summary = await runChecks(env);
      return json(summary);
    }

    return json({
      state: await loadState(env),
      targets: allTargets(env).map((t) => ({ id: t.id, tier: t.tier, url: t.url })),
    });
  },
};

/**
 * One tick: check what is due, fold it into the state, say what needs saying.
 *
 * Exported so a test can drive a whole tick against a stubbed fetch and a fake
 * KV binding — the wiring between probe, state and dispatch is where a bug
 * would be invisible in the unit tests of each part.
 */
export async function runChecks(env, nowMs = Date.now()) {
  const now = Math.floor(nowMs / 1000);
  const minute = new Date(nowMs).getUTCMinutes();

  const targets = dueTargets(allTargets(env), minute);
  if (!targets.length) {
    return { checked: 0 };
  }

  const state = await loadState(env);

  // Vendor context, refreshed every five minutes rather than every minute.
  // Five extra subrequests a minute would be most of this Worker's traffic and
  // all of it wasted — a status page does not change that fast.
  let vendors = state.__vendors || {};
  let vendorsChanged = false;
  if (minute % 5 === 0) {
    vendors = await vendorStatuses();
    // Only counts as a change when an indicator actually moved. Writing the
    // snapshot back every five minutes would be 288 KV writes a day against a
    // free-plan budget of 1,000, spent on a value that changes a few times a
    // year.
    vendorsChanged = JSON.stringify(state.__vendors || {}) !== JSON.stringify(vendors);
    state.__vendors = vendors;
  }

  const results = await Promise.all(
    targets.map(async (target) => ({ target, result: await probe(target, env) }))
  );

  let dirty = vendorsChanged;
  const summary = [];

  for (const { target, result } of results) {
    const tier = TIERS[target.tier] || TIERS.prospect;
    const { entry, changed, alert } = reconcile(state[target.id], result, tier, now);

    state[target.id] = entry;
    dirty = dirty || changed;
    summary.push({ id: target.id, status: result.status, code: result.code, reasons: result.reasons });

    if (alert) {
      await dispatch(env, target, tier, result, alert, vendors);
    }
  }

  if (dirty) {
    await saveState(env, state);
  }

  return { checked: results.length, results: summary };
}

/**
 * Sends one alert down whichever channels the tier allows.
 *
 * A recovery always goes wherever the original alarm went — an alert with no
 * all-clear trains people to ignore the alert.
 */
async function dispatch(env, target, tier, result, alert, vendors) {
  // A recovery goes wherever its alarm went — an alert with no all-clear
  // trains people to ignore the alert — so it is classified by the status it
  // is recovering FROM, not by the fact that it is good news.
  const severity =
    alert.kind === 'recovered'
      ? (alert.from === 'degraded' ? 'degraded' : 'fail')
      : (alert.kind === 'degraded' ? 'degraded' : 'fail');
  const channels = tier.channels[severity] || [];
  const vendorLine = vendorSummary(vendors);

  if (channels.includes('sms')) {
    await sendSms(env, smsBody(target, result, alert, vendorLine));
  }

  if (channels.includes('issue')) {
    const title =
      alert.kind === 'degraded'
        ? `Degraded: ${target.name}`
        : `Outage: ${target.name}`;
    await fileIssue(
      env,
      target,
      title,
      issueBody(target, result, alert, vendors),
      alert.kind === 'recovered'
    );
  }
}

function json(data) {
  return new Response(JSON.stringify(data, null, 2), {
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
