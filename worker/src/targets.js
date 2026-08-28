/**
 * What the Worker watches, and how loudly.
 *
 * THE PUBLIC/PRIVATE SPLIT
 * ------------------------
 * Atelier runs ~32 sites and has exactly ONE real tenant. The rest are
 * unsolicited prospect pitch sites, built for businesses that have not agreed
 * to anything and mostly do not know the site exists. This repository is
 * public, so their hostnames cannot live in it — not in a config file, not in
 * a comment, not in git history.
 *
 * Only platform surfaces and real tenants are hard-coded below. Everything
 * else arrives at runtime in the PRIVATE_TARGETS secret, a JSON array set with
 * `wrangler secret put` and regenerated from the private repo by
 * scripts/sync-private-targets.sh. A secret is not in the repository, is not
 * in the deployment bundle a reader can inspect, and is not in git history.
 */

/**
 * Sites that may be named publicly.
 */
export const PUBLIC_TARGETS = [
  {
    id: 'tlp',
    name: 'Timberlodge Parlor',
    url: 'https://timberlodgeparlor.com',
    tier: 'tenant',
  },
  {
    id: 'bwa',
    name: 'Book With Atelier',
    url: 'https://bookwithatelier.com',
    tier: 'platform',
  },
  {
    id: 'studio',
    name: 'Atelier Studio',
    url: 'https://studio.bookwithatelier.com',
    tier: 'platform',
  },
];

/**
 * Per-tier policy.
 *
 * `everyMinutes` is the check interval. `failAfter` is how long a site must
 * keep failing before anyone is told — the debounce is expressed in seconds
 * rather than in consecutive checks so that changing the interval does not
 * silently change the sensitivity. Each is set to roughly two missed checks:
 * one bad response is a blip, two in a row is an outage.
 *
 * `degradedAfter` is much longer because degraded is, by construction, not
 * urgent: the site is serving customers and something behind it is late.
 * Fifteen minutes of it is a real fault; ninety seconds of it is a slow cron
 * tick.
 *
 * `renotifySeconds` is how long a still-broken site waits before it is
 * mentioned again — an hour for the tenant, three for platform surfaces, a day
 * for prospects. Long enough that a multi-hour outage does not turn into a
 * pager loop, short enough that it cannot be forgotten.
 *
 * SMS is reserved for the one real tenant going hard down. Everything else is
 * an issue in the private repo, which GitHub turns into an email. Nothing here
 * ever reaches a tenant: outage alerts go to platform operations, and telling
 * a tenant about an outage is a platform-ops decision made by a human through
 * official channels.
 */
export const TIERS = {
  tenant: {
    everyMinutes: 1,
    failAfter: 90,
    degradedAfter: 900,
    channels: { fail: ['sms', 'issue'], degraded: ['issue'] },
    renotifySeconds: 3600,
    listed: true,
  },
  platform: {
    everyMinutes: 5,
    failAfter: 600,
    degradedAfter: 1800,
    channels: { fail: ['issue'], degraded: ['issue'] },
    renotifySeconds: 10800,
    listed: true,
  },
  prospect: {
    everyMinutes: 15,
    failAfter: 1800,
    degradedAfter: 0,
    channels: { fail: ['issue'], degraded: [] },
    renotifySeconds: 86400,
    listed: false,
  },
};

/**
 * Parses the PRIVATE_TARGETS secret.
 *
 * Anything malformed is dropped rather than thrown: a typo in one entry must
 * not stop the tenant check from running, because the tenant check is the one
 * that matters.
 */
export function privateTargets(env) {
  if (!env.PRIVATE_TARGETS) {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(env.PRIVATE_TARGETS);
  } catch {
    console.error('PRIVATE_TARGETS is not valid JSON — ignoring it');
    return [];
  }
  if (!Array.isArray(parsed)) {
    console.error('PRIVATE_TARGETS is not an array — ignoring it');
    return [];
  }
  return parsed
    .filter((t) => t && typeof t.url === 'string' && typeof t.id === 'string')
    .map((t) => ({
      id: t.id,
      name: t.name || t.id,
      url: t.url.replace(/\/+$/, ''),
      tier: TIERS[t.tier] ? t.tier : 'prospect',
    }));
}

/**
 * The targets due for a check this minute.
 *
 * Prospects are spread across the interval rather than all fired at once —
 * target i is checked when `i % everyMinutes === minute % everyMinutes`. Two
 * reasons, and the second is the one that bites:
 *
 *  - A Worker invocation on the free plan may make at most 50 subrequests.
 *    Thirty-odd prospects plus their fallback checks plus the vendor sweep
 *    would blow through that in a single tick, and the failure would land on
 *    whichever targets happened to sort last.
 *  - Firing thirty requests at the same origin in the same second is itself a
 *    small load spike, arriving every fifteen minutes forever.
 *
 * Each target still gets exactly one check per interval; they are just dealt
 * out across the minutes of it.
 */
export function dueTargets(all, minute) {
  return all.filter((target, index) => {
    const tier = TIERS[target.tier] || TIERS.prospect;
    if (tier.everyMinutes <= 1) {
      return true;
    }
    return index % tier.everyMinutes === minute % tier.everyMinutes;
  });
}

/**
 * Every target, public first so the tenant check is dealt into slot 0.
 */
export function allTargets(env) {
  return [...PUBLIC_TARGETS, ...privateTargets(env)];
}
