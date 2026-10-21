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
 * The same snapshot is published, unchanged, at /vendors.json for the public
 * status page (see publicSnapshot). It carries vendor names and vendor-written
 * status text only — nothing about our own targets ever goes near it.
 *
 * FIVE FORMATS, NOT ONE
 * ---------------------
 * This started out assuming every vendor runs Atlassian Statuspage and so
 * every one of them answers /api/v2/status.json. Several do not, and because
 * an unreachable vendor degrades to 'unknown' rather than throwing, that
 * assumption produced a monitor that quietly reported "unknown" for Stripe
 * and Postmark forever — the failure looked exactly like the vendor being
 * unreachable. Verified against the live endpoints on 2026-08-28 and again on
 * 2026-10-21:
 *
 *   statuspage  Cloudflare, Twilio, GitHub, Anthropic, Clover, Shopify
 *               {"status":{"indicator":"none|minor|major|critical", ...}}
 *   stripe      https://status.stripe.com/current
 *               {"largestatus":"up", "message":"..."}
 *   postmark    https://status.postmarkapp.com/api/v1/status
 *               {"page":{"state":"operational","state_text":"..."}}
 *   google      https://www.google.com/appsstatus/dashboard/incidents.json
 *               [{"service_name":"Gmail","status_impact":"SERVICE_DISRUPTION",
 *                 "begin":"...","end":"..."|absent,"affected_products":[...]}]
 *               Every Workspace incident ever, ~350 KB; an incident with no
 *               `end` is live. Filtered to the products we depend on.
 *   apple       https://www.apple.com/support/systemstatus/data/system_status_en_US.js
 *               {"services":[{"serviceName":"iCloud Calendar","events":[
 *                 {"statusType":"Outage|Issue|Performance|Maintenance",
 *                  "eventStatus":"ongoing|resolved|upcoming", ...}]}]}
 *               Plain JSON despite the .js extension (checked 2026-10-21).
 *               Filtered to the iCloud services calendar sync touches.
 *
 * Two of the hostnames are not the obvious ones: status.anthropic.com now
 * 301s to status.claude.com, and status.shopify.com to www.shopifystatus.com.
 * Both are written here as their final host, because a redirect is one more
 * thing a vendor can break and the Worker would only ever see 'unknown'.
 *
 * Everything is normalised to Statuspage's vocabulary, because that is what
 * the alert text and vendorSummary() speak. If you add a vendor, check its
 * endpoint by hand first — a 404 here is invisible in production — and add
 * its shape to the test that pins every normaliser.
 */

export const VENDORS = [
  {
    id: 'cloudflare',
    name: 'Cloudflare',
    url: 'https://www.cloudflarestatus.com/api/v2/status.json',
    shape: 'statuspage',
    role: 'Edge, DNS and bot protection for every site',
  },
  {
    id: 'stripe',
    name: 'Stripe',
    url: 'https://status.stripe.com/current',
    shape: 'stripe',
    role: 'Card payments and deposits',
  },
  {
    id: 'twilio',
    name: 'Twilio',
    url: 'https://status.twilio.com/api/v2/status.json',
    shape: 'statuspage',
    role: 'Text message reminders and the SMS assistant',
  },
  {
    id: 'postmark',
    name: 'Postmark',
    url: 'https://status.postmarkapp.com/api/v1/status',
    shape: 'postmark',
    role: 'Email confirmations and receipts',
  },
  {
    id: 'github',
    name: 'GitHub',
    url: 'https://www.githubstatus.com/api/v2/status.json',
    shape: 'statuspage',
    role: 'Hosts this status page and its checks',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    url: 'https://status.claude.com/api/v2/status.json',
    shape: 'statuspage',
    role: 'The AI receptionist that answers texts',
  },
  {
    id: 'clover',
    name: 'Clover',
    url: 'https://status.clover.com/api/v2/status.json',
    shape: 'statuspage',
    role: 'In-shop card terminals',
  },
  {
    id: 'shopify',
    name: 'Shopify',
    url: 'https://www.shopifystatus.com/api/v2/status.json',
    shape: 'statuspage',
    role: 'Drop-shipped shop products',
  },
  {
    id: 'google',
    name: 'Google Calendar',
    url: 'https://www.google.com/appsstatus/dashboard/incidents.json',
    shape: 'google',
    products: ['Google Calendar'],
    role: 'Calendar sync for staff who use Google',
  },
  {
    id: 'apple',
    name: 'iCloud Calendar',
    url: 'https://www.apple.com/support/systemstatus/data/system_status_en_US.js',
    shape: 'apple',
    services: ['iCloud Calendar', 'iCloud Account & Sign In'],
    role: 'Calendar sync for staff who use iCloud',
  },
];

const TIMEOUT_MS = 5000;

/** Statuspage's vocabulary, worst last. 'unknown' sits above all-clear on purpose. */
const RANK = { none: 0, unknown: 1, minor: 2, major: 3, critical: 4 };

function worst(indicators) {
  return indicators.reduce(
    (acc, next) => ((RANK[next] ?? RANK.unknown) > (RANK[acc] ?? RANK.unknown) ? next : acc),
    'none'
  );
}

/**
 * Normalises each vendor's own vocabulary into Statuspage's.
 *
 * Unrecognised values become 'unknown' rather than 'none': a wording change
 * at the vendor must never quietly read as "all clear".
 *
 * Each normaliser receives the parsed body and the VENDORS entry, so the
 * feeds that cover a whole product family can be filtered to the products we
 * actually depend on.
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

  /**
   * Google Workspace's dashboard: one array of every incident, closed ones
   * included. An incident is live while it has no `end`. Matched on the
   * incident's own service and on its affected-products list, because a
   * multi-product incident is filed under "Multiple Products".
   */
  google(data, vendor) {
    if (!Array.isArray(data)) {
      return { indicator: 'unknown', description: '' };
    }
    const products = vendor?.products || [];
    const touches = (incident) =>
      products.includes(incident?.service_name) ||
      (incident?.affected_products || []).some((p) => products.includes(p?.title));
    const live = data.filter((incident) => incident && !incident.end && touches(incident));
    if (!live.length) {
      return { indicator: 'none', description: 'No open incidents' };
    }
    const map = {
      SERVICE_INFORMATION: 'none',
      SERVICE_DISRUPTION: 'minor',
      SERVICE_OUTAGE: 'major',
    };
    const indicator = worst(live.map((i) => map[i.status_impact] || 'unknown'));
    const headline = String(live[0].external_desc || '')
      .replace(/\*\*Summary:\*\*\s*/i, '')
      .split('\n')[0]
      .trim();
    return { indicator, description: headline || `${live.length} open incident(s)` };
  },

  /**
   * Apple's system status: every service with its events. Only the services
   * named on the VENDORS entry count, and only an event that is not finished.
   * `eventStatus` has been seen as ongoing, resolved and upcoming; anything
   * unrecognised is treated as live, because the alternative is a new word
   * reading as all-clear.
   */
  apple(data, vendor) {
    if (!Array.isArray(data?.services)) {
      return { indicator: 'unknown', description: '' };
    }
    const wanted = vendor?.services || [];
    const map = { outage: 'major', issue: 'minor', performance: 'minor', maintenance: 'minor' };
    const finished = ['resolved', 'completed'];
    const live = [];
    for (const service of data.services) {
      if (!wanted.includes(service?.serviceName)) continue;
      for (const event of service.events || []) {
        const status = String(event?.eventStatus || '').toLowerCase();
        if (finished.includes(status) || status === 'upcoming') continue;
        live.push({
          indicator: map[String(event?.statusType || '').toLowerCase()] || 'unknown',
          text: `${service.serviceName}: ${event?.message || event?.statusType || 'event'}`,
        });
      }
    }
    if (!live.length) {
      return { indicator: 'none', description: 'No open incidents' };
    }
    return { indicator: worst(live.map((e) => e.indicator)), description: live[0].text };
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
        const parsed = (NORMALISERS[vendor.shape] || NORMALISERS.statuspage)(data, vendor);
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

/**
 * The snapshot as the public status page sees it.
 *
 * Built from the VENDORS list, not from the stored object, so the output can
 * only ever contain keys this file declares: a vendor id, its display name,
 * what it is for, and the indicator and sentence the vendor itself published.
 * The stored state also holds every private target by hostname, and that is
 * exactly what this function must never be able to reach — hence it is
 * handed the vendor map alone, never the state.
 *
 * `as_of` is when the snapshot last CHANGED, not when it was last checked:
 * the Worker writes the snapshot back only on a change, to stay inside the
 * KV write budget, so that is the only timestamp it has.
 */
export function publicSnapshot(vendors, changedAt) {
  return {
    as_of: changedAt ? new Date(changedAt * 1000).toISOString() : null,
    vendors: VENDORS.map((vendor) => {
      const seen = vendors?.[vendor.id] || {};
      return {
        id: vendor.id,
        name: vendor.name,
        role: vendor.role || '',
        indicator: typeof seen.indicator === 'string' ? seen.indicator : 'unknown',
        description: typeof seen.description === 'string' ? seen.description : '',
      };
    }),
  };
}
