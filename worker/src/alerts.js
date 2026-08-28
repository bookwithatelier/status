/**
 * Getting the alert to a human.
 *
 * TWO RULES, BOTH NON-NEGOTIABLE
 * ------------------------------
 * 1. Alerts go to PLATFORM OPERATIONS ONLY. Never to a tenant, never to a
 *    tenant's staff, never to a prospect. Telling a tenant their site is down
 *    is a decision a person makes, through official channels, after they know
 *    what is actually happening.
 * 2. Nothing here may route through the platform's own notification stack.
 *    That stack runs on the box this Worker is watching. Sending the "the box
 *    is down" message through the box is how an outage becomes silent.
 *
 * So: Twilio's REST API is called directly, and the email path is a GitHub
 * issue in the PRIVATE repo, which GitHub turns into an email on its own
 * infrastructure. Cloudflare, Twilio and GitHub all have to fail at once for
 * an alert to be lost, and they are three different companies.
 *
 * Issues go to the private repo rather than to this public one because an
 * alert names the site — and most of the sites are prospect pitch sites for
 * businesses that have not agreed to anything. Upptime already publishes
 * issues for the three public surfaces; this channel must stay private.
 */

/**
 * Sends an SMS via the Twilio REST API.
 *
 * Deliberately not the platform's SMS gateway config, its Key entities, or its
 * queue — this Worker holds its own Twilio credentials as Worker secrets and
 * talks to Twilio directly, because everything else is on the machine that
 * just stopped answering.
 */
export async function sendSms(env, body) {
  const sid = env.TWILIO_ACCOUNT_SID;
  const token = env.TWILIO_AUTH_TOKEN;
  const from = env.TWILIO_FROM;
  const to = env.ALERT_SMS_TO;

  if (!sid || !token || !from || !to) {
    console.error('SMS not configured — skipping (need TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM, ALERT_SMS_TO)');
    return false;
  }

  const form = new URLSearchParams({ From: from, To: to, Body: body.slice(0, 1500) });

  try {
    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${btoa(`${sid}:${token}`)}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form,
      }
    );
    if (!response.ok) {
      console.error('Twilio rejected the message:', response.status, await response.text());
      return false;
    }
    return true;
  } catch (error) {
    console.error('Twilio request failed:', error);
    return false;
  }
}

/**
 * Opens (or comments on) an issue in the private repo.
 *
 * One open issue per target, reused for the life of the incident: a new issue
 * per tick would bury the original under a hundred duplicates, and a closed
 * issue is the record that the incident ended. The title carries the target id
 * so the search below can find it again.
 */
export async function fileIssue(env, target, title, body, close = false) {
  const repo = env.ALERT_ISSUE_REPO;
  const pat = env.GITHUB_PAT;

  if (!repo || !pat) {
    console.error('Issue channel not configured — skipping (need ALERT_ISSUE_REPO, GITHUB_PAT)');
    return false;
  }

  const marker = `[monitor:${target.id}]`;
  const headers = {
    Authorization: `Bearer ${pat}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'Atelier-Worker/1.0',
    'Content-Type': 'application/json',
  };

  try {
    const existing = await findOpenIssue(repo, marker, headers);

    if (existing) {
      await fetch(`https://api.github.com/repos/${repo}/issues/${existing}/comments`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ body }),
      });
      if (close) {
        await fetch(`https://api.github.com/repos/${repo}/issues/${existing}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ state: 'closed' }),
        });
      }
      return true;
    }

    // Nothing open. A recovery with no open issue means the incident never
    // reached the alert threshold, so there is nothing to close and nothing
    // worth opening just to say it is over.
    if (close) {
      return true;
    }

    const response = await fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        title: `${title} ${marker}`,
        body,
        labels: ['outage'],
      }),
    });
    if (!response.ok) {
      console.error('GitHub rejected the issue:', response.status, await response.text());
      return false;
    }
    return true;
  } catch (error) {
    console.error('GitHub request failed:', error);
    return false;
  }
}

/**
 * Finds this target's open incident issue by its marker.
 */
async function findOpenIssue(repo, marker, headers) {
  const response = await fetch(
    `https://api.github.com/repos/${repo}/issues?state=open&labels=outage&per_page=100`,
    { headers }
  );
  if (!response.ok) {
    return null;
  }
  const issues = await response.json();
  if (!Array.isArray(issues)) {
    return null;
  }
  const match = issues.find((issue) => typeof issue.title === 'string' && issue.title.includes(marker));
  return match ? match.number : null;
}

/**
 * Human-readable duration, short enough for an SMS.
 */
export function humanDuration(seconds) {
  if (seconds < 60) {
    return `${Math.max(0, Math.round(seconds))}s`;
  }
  if (seconds < 3600) {
    return `${Math.round(seconds / 60)}m`;
  }
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  return minutes ? `${hours}h${minutes}m` : `${hours}h`;
}

/**
 * The one line that lands on a phone.
 *
 * The reasons come first after the status because they are the entire point:
 * "Timberlodge Parlor DOWN — env_file_unreadable" is a message you can act on
 * from bed, and "Timberlodge Parlor DOWN" is one that costs an hour of
 * guessing. On 2026-08-28 that hour was four and a half.
 */
export function smsBody(target, result, alert, vendorLine) {
  const reasons = (result.reasons || []).join(' ') || 'no reason reported';
  const parts = [
    `Atelier: ${target.name}`,
    alert.kind === 'recovered' ? 'RECOVERED' : 'DOWN',
  ];
  if (alert.kind !== 'recovered') {
    parts.push(`(${result.code || 'no response'})`);
    parts.push(reasons);
  }
  parts.push(`— ${humanDuration(alert.forSeconds)}`);
  let text = parts.join(' ');
  if (vendorLine) {
    text += ` | vendors: ${vendorLine}`;
  }
  return text;
}

/**
 * The longer form, for the issue body.
 */
export function issueBody(target, result, alert, vendors) {
  const lines = [
    `**${target.name}** — \`${alert.kind}\``,
    '',
    `| | |`,
    `|---|---|`,
    `| URL | ${target.url} |`,
    `| Tier | ${target.tier} |`,
    `| HTTP | ${result.code || 'no response'} |`,
    `| Response time | ${result.ms} ms |`,
    `| Front door | ${result.frontDoor === null ? 'not checked' : result.frontDoor} |`,
    `| Resolved site dir | ${result.site || 'unknown'} |`,
    `| Duration | ${humanDuration(alert.forSeconds)} |`,
    '',
    '**Reasons**',
    '',
    (result.reasons || []).length
      ? (result.reasons || []).map((r) => `- \`${r}\``).join('\n')
      : '- none reported',
    '',
    '**Vendor status at the time of this check**',
    '',
    Object.values(vendors || {})
      .map((v) => `- ${v.name}: \`${v.indicator}\`${v.description ? ` — ${v.description}` : ''}`)
      .join('\n') || '- not collected',
    '',
    '---',
    '',
    'Vendor status is context, not evidence. A page that says "All Systems',
    'Operational" is entirely compatible with our own account being broken —',
    'so read our reasons first and the vendor line second.',
    '',
    'If a reason names the environment files, check permissions before',
    'anything else, and **stat before you chgrp** — the ctime is the only',
    'record of when the change happened, and fixing it destroys that:',
    '',
    '```',
    "find env -maxdepth 1 -type f -name '*.yml' ! -group www-data -printf '%p %u:%g %m\\n'",
    '```',
  ];
  return lines.join('\n');
}
