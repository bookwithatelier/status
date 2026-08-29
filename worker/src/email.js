/**
 * Email alerts, sent by the Worker itself.
 *
 * WHY NOT JUST THE GITHUB ISSUE
 * -----------------------------
 * Filing an issue already produces an email, via GitHub's own notifications,
 * and that path is genuinely valuable: it is a durable record and it runs on
 * infrastructure unrelated to ours. But as the *only* email path it has two
 * weaknesses. It is one more set of notification preferences between an
 * outage and a human — a muted repo or a digest setting silently disarms it —
 * and it cannot deliver at all when GitHub is the thing having a bad day.
 *
 * So this sends directly, in addition. Two independent paths to the same
 * inbox, which is the whole design principle of this project applied one
 * level down.
 *
 * WHY CLOUDFLARE EMAIL AND NOT AN SMTP PROVIDER
 * ---------------------------------------------
 * No API key to store, no third-party account, no cost, and — the part that
 * matters — no dependency on the platform's own mail stack. Postmark, SES and
 * the iCloud SMTP relay are all things this monitor is supposed to be able to
 * report on; routing its alerts through any of them would mean the "email is
 * broken" alert travels by email through the broken thing.
 *
 * The recipient arrives as a secret rather than as the binding's
 * `destination_address`, because this repository is public and pinning it in
 * wrangler.toml would publish the address. That is not a hole: Cloudflare
 * only ever delivers to addresses already verified as Email Routing
 * destinations on the account, so the binding cannot be turned into an open
 * relay regardless of what the secret says.
 *
 * The one blind spot, stated plainly: this runs on Cloudflare, so a
 * Cloudflare outage takes it out. That is already true of the Worker itself,
 * so it adds no new exposure — and it is exactly the case Upptime covers from
 * GitHub.
 */

/**
 * Sends one alert email. Never throws.
 *
 * @returns {Promise<boolean>} whether it was accepted for delivery.
 */
export async function sendEmail(env, subject, body) {
  if (!env.ALERT_EMAIL) {
    console.error('Email not configured — no ALERT_EMAIL binding (see wrangler.toml [[send_email]])');
    return false;
  }

  const from = env.ALERT_EMAIL_FROM;
  const to = env.ALERT_EMAIL_TO;
  if (!from || !to) {
    console.error('Email not configured — need ALERT_EMAIL_FROM and ALERT_EMAIL_TO vars');
    return false;
  }

  try {
    // Imported lazily so the module still loads (and the tests still run)
    // outside the Workers runtime, where `cloudflare:email` does not exist.
    const { EmailMessage } = await import('cloudflare:email');
    const message = new EmailMessage(from, to, mime(from, to, subject, body));
    await env.ALERT_EMAIL.send(message);
    return true;
  } catch (error) {
    // A rejected destination is the overwhelmingly likely failure and it has a
    // specific fix, so say so rather than logging a bare stack.
    console.error(
      `Email send failed: ${error?.message || error}. If this mentions the ` +
        `destination, verify ${to} under Cloudflare → Email → Email Routing → ` +
        `Destination addresses.`
    );
    return false;
  }
}

/**
 * Builds a minimal RFC 5322 message.
 *
 * Hand-rolled rather than pulling in a MIME library: the message is plain
 * text with no attachments, and a dependency in a monitor is a thing that can
 * break the monitor. Date and Message-ID are both required — Cloudflare
 * rejects a message without them.
 */
function mime(from, to, subject, body) {
  const id = `${crypto.randomUUID()}@${from.split('@')[1] || 'atelierbooking.co'}`;
  return [
    `From: Atelier Monitor <${from}>`,
    `To: <${to}>`,
    `Subject: ${sanitiseHeader(subject)}`,
    `Message-ID: <${id}>`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
  ].join('\r\n');
}

/**
 * Strips CR and LF from a header value.
 *
 * The subject carries a site name, and site names come from a secret that is
 * generated off the production box. Header injection is not a plausible
 * attack here, but a stray newline in a header silently truncates or
 * malforms the message, and a malformed alert is a missed alert.
 */
function sanitiseHeader(value) {
  return String(value).replace(/[\r\n]+/g, ' ').slice(0, 200);
}
