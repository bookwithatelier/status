/**
 * Checking one site.
 *
 * The primary check is /health.php, the endpoint in the private atelier repo
 * (web/health.php). It answers without a Drupal bootstrap — which is the whole
 * point, since the outage that prompted all of this was Drupal being unable to
 * bootstrap at all — and its body names what broke rather than only that
 * something did.
 *
 * It is checked instead of `/` because these sites are behind Cloudflare and a
 * cached edge response for `/` will happily report a dead origin as healthy.
 * /health.php sets `no-store`, so it always reaches the origin.
 *
 * When it does NOT answer, `/` is checked as a second opinion. That one extra
 * request separates two failures that look identical from the outside and have
 * nothing else in common:
 *
 *   health down, front door up  → the endpoint or its deploy is broken, the
 *                                 site is fine, and nobody should be woken up
 *   both down                   → the site is down
 *
 * Without it, shipping a bug to health.php would page somebody at 2am about a
 * site that was serving customers perfectly.
 */

const TIMEOUT_MS = 8000;

/**
 * Fetches a URL with a hard timeout, never throwing.
 */
async function get(url, env, signalTimeout = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), signalTimeout);
  const started = Date.now();

  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        // Identifies us in origin logs, and is what the Cloudflare WAF skip
        // rule matches. A monitor that gets bot-challenged reports a healthy
        // site as down, and false alarms are how a monitor gets ignored.
        'User-Agent': 'Atelier-Worker/1.0 (+https://github.com/bookwithatelier/status)',
        'X-Atelier-Monitor': env.MONITOR_TOKEN || '',
        // Belt and braces against an intermediate cache; the endpoint already
        // sends no-store on the way back.
        'Cache-Control': 'no-cache',
      },
      cf: { cacheTtl: 0, cacheEverything: false },
    });
    const body = await response.text();
    return {
      ok: true,
      code: response.status,
      ms: Date.now() - started,
      body,
    };
  } catch (error) {
    return {
      ok: false,
      code: 0,
      ms: Date.now() - started,
      body: '',
      error: error?.name === 'AbortError' ? 'timeout' : String(error?.message || error),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Checks one target and returns a verdict.
 *
 * @returns {{status: 'ok'|'degraded'|'fail', code: number, ms: number,
 *            reasons: string[], site: string|null, frontDoor: number|null}}
 */
export async function probe(target, env) {
  const health = await get(`${target.url}/health.php`, env);

  if (health.ok && health.code === 200) {
    const parsed = parseHealth(health.body);
    if (parsed) {
      return {
        status: parsed.status === 'degraded' ? 'degraded' : 'ok',
        code: health.code,
        ms: health.ms,
        reasons: parsed.reasons,
        site: parsed.site,
        frontDoor: null,
      };
    }
    // 200 with a body that is not our JSON. Something is answering on that
    // path and it is not the endpoint — a stale CDN cache, a parked page, a
    // redirect that swallowed us. Not an outage; not a green light either.
    return {
      status: 'degraded',
      code: health.code,
      ms: health.ms,
      reasons: ['health_endpoint_unrecognised'],
      site: null,
      frontDoor: null,
    };
  }

  // Something is wrong with the health endpoint. Ask the front door before
  // deciding the site is down.
  const front = await get(target.url, env);
  const frontDoorUp = front.ok && front.code >= 200 && front.code < 400;

  if (health.ok && health.code === 503) {
    // The endpoint answered and said the site cannot serve. Believe it — this
    // is the designed signal, and it comes with reasons.
    const parsed = parseHealth(health.body);
    return {
      status: 'fail',
      code: 503,
      ms: health.ms,
      reasons: parsed?.reasons?.length ? parsed.reasons : ['health_fail'],
      site: parsed?.site ?? null,
      frontDoor: front.code,
    };
  }

  if (frontDoorUp) {
    // The site is serving. Only the endpoint is unreachable — most likely it
    // has not been deployed to this site yet, or a WAF rule is challenging us.
    return {
      status: 'degraded',
      code: health.code,
      ms: health.ms,
      reasons: [health.code === 404 ? 'health_endpoint_missing' : 'health_endpoint_unreachable'],
      site: null,
      frontDoor: front.code,
    };
  }

  return {
    status: 'fail',
    code: health.code || front.code,
    ms: health.ms,
    reasons: [health.error === 'timeout' ? 'site_timeout' : 'site_unreachable'],
    site: null,
    frontDoor: front.code,
  };
}

/**
 * Reads the health endpoint's JSON, returning null for anything else.
 */
function parseHealth(body) {
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    return null;
  }
  if (!data || typeof data.status !== 'string') {
    return null;
  }
  return {
    status: data.status,
    site: typeof data.site === 'string' ? data.site : null,
    reasons: Array.isArray(data.reasons) ? data.reasons.map(String) : [],
  };
}
