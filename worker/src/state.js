/**
 * What the Worker remembers between ticks, and why it barely writes.
 *
 * Workers KV on the free plan allows 100,000 reads and **1,000 writes** per
 * day. This Worker wakes up 1,440 times a day, so a design that wrote state on
 * every tick would exhaust the write quota before lunch and then start
 * silently failing — a monitor that stops working without saying so is worse
 * than no monitor.
 *
 * So the state is shaped to change rarely. Nothing here counts consecutive
 * failures, because a counter changes on every bad tick; it records the
 * *timestamp* a failure started, which is written once when the failure begins
 * and once when it ends. Debouncing then becomes "has it been failing for
 * longer than N seconds", which is both cheaper and more meaningful than "N
 * checks in a row" — it does not silently change sensitivity when a check
 * interval changes.
 *
 * The whole map lives under one key: one read per tick regardless of how many
 * sites are watched.
 *
 * Shape, per target id:
 *   {
 *     status: 'ok' | 'degraded' | 'fail',
 *     since: <epoch seconds the CURRENT status began>,
 *     alertedAt: <epoch seconds we last said something, or 0>,
 *     code: <last HTTP code>,
 *     reasons: [ ... ]
 *   }
 */

const KEY = 'monitor-state-v1';

export async function loadState(env) {
  try {
    const raw = await env.STATE.get(KEY, { type: 'json' });
    return raw && typeof raw === 'object' ? raw : {};
  } catch (error) {
    // A KV read failure must not stop the checks. Losing the memory means the
    // debounce restarts and an ongoing outage may be re-announced — noisy, but
    // it fails toward telling somebody rather than toward silence.
    console.error('KV read failed:', error);
    return {};
  }
}

export async function saveState(env, state) {
  try {
    await env.STATE.put(KEY, JSON.stringify(state));
  } catch (error) {
    console.error('KV write failed:', error);
  }
}

/**
 * Folds one probe result into the stored state and decides what to say.
 *
 * @returns {{
 *   entry: object,
 *   changed: boolean,
 *   alert: null | {kind: 'down'|'degraded'|'recovered'|'still-down', forSeconds: number}
 * }}
 */
export function reconcile(previous, result, tier, now) {
  const before = previous || { status: 'ok', since: now, alertedAt: 0 };
  const status = result.status;
  const transitioned = before.status !== status;

  const entry = {
    status,
    since: transitioned ? now : before.since,
    alertedAt: transitioned ? 0 : before.alertedAt || 0,
    code: result.code,
    reasons: result.reasons,
  };

  const forSeconds = now - entry.since;

  // Recovery. Only worth announcing if we announced the problem — otherwise a
  // blip that never reached the debounce would produce an "all clear" for
  // something nobody was ever told about.
  if (status === 'ok') {
    if (transitioned && (before.alertedAt || 0) > 0) {
      return {
        entry,
        changed: true,
        // `from` decides which channels the all-clear goes down. Without it a
        // tenant recovering from *degraded* would send an SMS, because
        // recovery would be classified as a fail-tier event — an all-clear
        // louder than the alarm it answers.
        alert: { kind: 'recovered', from: before.status, forSeconds: now - before.since },
      };
    }
    return { entry, changed: transitioned || stale(before, entry), alert: null };
  }

  const threshold = status === 'fail' ? tier.failAfter : tier.degradedAfter;

  // A tier can opt out of a severity entirely — prospects have no degraded
  // channel, because nobody is going to act at 3am on a stale cron for a site
  // whose owner does not know it exists.
  if (!threshold || !(tier.channels[status === 'fail' ? 'fail' : 'degraded'] || []).length) {
    return { entry, changed: transitioned || stale(before, entry), alert: null };
  }

  if (forSeconds < threshold) {
    // Still inside the debounce. Say nothing, and do not write unless the
    // status actually moved — this is the common path during a blip and it is
    // the one that would burn the KV write quota.
    return { entry, changed: transitioned, alert: null };
  }

  const alertedAt = before.alertedAt || 0;
  const firstTime = alertedAt === 0;
  const dueAgain = !firstTime && now - alertedAt >= tier.renotifySeconds;

  if (firstTime || dueAgain) {
    entry.alertedAt = now;
    return {
      entry,
      changed: true,
      alert: {
        kind: firstTime ? (status === 'fail' ? 'down' : 'degraded') : 'still-down',
        forSeconds,
      },
    };
  }

  return { entry, changed: transitioned, alert: null };
}

/**
 * Whether the stored detail has drifted enough to be worth a write.
 *
 * Only the reason list and HTTP code can change without a status transition,
 * and both are cosmetic while everything is fine — so this only returns true
 * when there is something to report anyway. Keeps the write budget for
 * transitions.
 */
function stale(before, entry) {
  if (entry.status === 'ok' && before.status === 'ok') {
    return false;
  }
  return (
    before.code !== entry.code ||
    (before.reasons || []).join(',') !== (entry.reasons || []).join(',')
  );
}
