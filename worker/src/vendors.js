/**
 * What our vendors say about themselves.
 *
 * Stripe, Twilio, Cloudflare, Postmark and GitHub all run Atlassian
 * Statuspage, so `/api/v2/status.json` is one uniform shape across all of
 * them: `{ status: { indicator, description } }` where indicator is one of
 * none / minor / major / critical.
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
 */

export const VENDORS = [
  { id: 'cloudflare', name: 'Cloudflare', url: 'https://www.cloudflarestatus.com/api/v2/status.json' },
  { id: 'stripe', name: 'Stripe', url: 'https://status.stripe.com/api/v2/status.json' },
  { id: 'twilio', name: 'Twilio', url: 'https://status.twilio.com/api/v2/status.json' },
  { id: 'postmark', name: 'Postmark', url: 'https://status.postmarkapp.com/api/v2/status.json' },
  { id: 'github', name: 'GitHub', url: 'https://www.githubstatus.com/api/v2/status.json' },
];

const TIMEOUT_MS = 5000;

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
        const data = await response.json();
        return [
          vendor.id,
          {
            name: vendor.name,
            indicator: data?.status?.indicator || 'unknown',
            description: data?.status?.description || '',
          },
        ];
      } catch {
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
