/**
 * What our vendors say about themselves.
 *
 * THIS IS CONTEXT, NOT A SIGNAL. Nothing here ever raises an alert on its
 * own, and that is deliberate:
 *
 *  - Vendors lag. A page turns yellow after enough customers have complained,
 *    which is well after the failures started.
 *  - Vendors almost never acknowledge a single-account partial failure at all.
 *    A suspended sending account, a toll-free number still pending
 *    verification, a rotated key — all of them are total outages for us and
 *    "All Systems Operational" for them.
 *
 * Our own numbers are the signal: the notification failure ratio and the
 * calendar-sync health that /health.php reports. What a status page adds is
 * the sentence after it. "SMS failures spiked and Twilio reports a major
 * incident" and "SMS failures spiked and Twilio says everything is fine" are
 * the same alert with two completely different next actions, and knowing
 * which one you are in is worth one HTTP request.
 *
 * THREE FORMATS, NOT ONE
 * ----------------------
 * This started out assuming every vendor runs Atlassian Statuspage and so
 * every one of them answers /api/v2/status.json. Two of the five do not, and
 * because an unreachable vendor degrades to 'unknown' rather than throwing,
 * that assumption produced a monitor that quietly reported "unknown" for
 * Stripe and Postmark forever — the failure looked exactly like the vendor
 * being unreachable. Verified against the live endpoints on 2026-08-28:
 *
 *   statuspage  Cloudflare, Twilio, GitHub
 *               {"status":{"indicator":"none|minor|major|critical", ...}}
 *   stripe      https://status.stripe.com/current
 *               {"largestatus":"up", "message":"..."}
 *   postmark    https://status.postmarkapp.com/api/v1/status
 *               {"page":{"state":"operational","state_text":"..."}}
 *
 * Everything is normalised to Statuspage's vocabulary, because that is what
 * the alert text and vendorSummary() speak. If you add a vendor, check its
 * endpoint by hand first — a 404 here is invisible in production.
 */

export const VENDORS = [
  {
    id: 'cloudflare',
    name: 'Cloudflare',
    url: 'https://www.cloudflarestatus.com/api/v2/status.json',
    shape: 'statuspage',
  },
  {
    id: 'stripe',
    name: 'Stripe',
    url: 'https://status.stripe.com/current',
    shape: 'stripe',
  },
  {
    id: 'twilio',
    name: 'Twilio',
    url: 'https://status.twilio.com/api/v2/status.json',
    shape: 'statuspage',
  },
  {
    id: 'postmark',
    name: 'Postmark',
    url: 'https://status.postmarkapp.com/api/v1/status',
    shape: 'postmark',
  },
  {
    id: 'github',
    name: 'GitHub',
    url: 'https://www.githubstatus.com/api/v2/status.json',
    shape: 'statuspage',
  },
];

const TIMEOUT_MS = 5000;

/**
 * Normalises each vendor's own vocabulary into Statuspage's.
 *
 * Unrecognised values become 'unknown' rather than 'none': a wording change
 * at the vendor must never quietly read as "all clear".
 */
export const NORMALISERS = {
  statuspage(data) {
    const indicator = data?.status?.indicator;
    return {
      indicator: ['none', 'minor', 'major', 'critical'].includes(indicator) ? indicator : 'unknown',
      description: data?.status?.description || '',
    };
  },

  stripe(data) {
    const map = { up: 'none', degraded: 'minor', down: 'major', outage: 'major' };
    const raw = String(data?.largestatus || '').toLowerCase();
    return {
      indicator: map[raw] || 'unknown',
      description: data?.message || '',
    };
  },

  postmark(data) {
    const map = {
      operational: 'none',
      degraded: 'minor',
      degraded_performance: 'minor',
      partial_outage: 'major',
      major_outage: 'critical',
      maintenance: 'minor',
    };
    const raw = String(data?.page?.state || '').toLowerCase();
    return {
      indicator: map[raw] || 'unknown',
      description: data?.page?.state_text || '',
    };
  },
};

/**
 * Fetches every vendor's indicator.
 *
 * A vendor that does not answer is recorded as 'unknown' rather than skipped.
 * "We could not reach Cloudflare's status page" is itself worth seeing next to
 * "three of our sites just went down".
 *
 * @returns {Promise<Object<string, {name: string, indicator: string, description: string}>>}
 */
export async function vendorStatuses() {
  const results = await Promise.all(
    VENDORS.map(async (vendor) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const response = await fetch(vendor.url, {
          signal: controller.signal,
          headers: { 'User-Agent': 'Atelier-Worker/1.0' },
        });
        if (!response.ok) {
          // A 404 here means the vendor moved or retired the endpoint. Loud in
          // the log, because in the report it is indistinguishable from the
          // vendor simply being unreachable.
          console.error(`Vendor ${vendor.id}: HTTP ${response.status} from ${vendor.url}`);
          return [vendor.id, { name: vendor.name, indicator: 'unknown', description: '' }];
        }
        const data = await response.json();
        const parsed = (NORMALISERS[vendor.shape] || NORMALISERS.statuspage)(data);
        return [vendor.id, { name: vendor.name, ...parsed }];
      } catch (error) {
        console.error(`Vendor ${vendor.id}: ${error?.message || error}`);
        return [vendor.id, { name: vendor.name, indicator: 'unknown', description: '' }];
      } finally {
        clearTimeout(timer);
      }
    })
  );

  return Object.fromEntries(results);
}

/**
 * The vendors currently reporting trouble, as one short line for an alert.
 *
 * Returns an empty string when everything is nominal, so the caller can append
 * it unconditionally without producing "Vendors: (none)" on every message.
 * 'unknown' is excluded here — it belongs in the stored snapshot, not in the
 * one line of an SMS.
 */
export function vendorSummary(statuses) {
  const noisy = Object.values(statuses || {}).filter(
    (v) => v.indicator && v.indicator !== 'none' && v.indicator !== 'unknown'
  );
  if (!noisy.length) {
    return '';
  }
  return noisy.map((v) => `${v.name}: ${v.indicator}`).join(', ');
}
