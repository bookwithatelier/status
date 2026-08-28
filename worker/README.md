# atelier-monitor

The minute-level half of Atelier's outage detection. Cloudflare Worker, free
tier, one cron trigger.

Full context is in the [repository README](../README.md). This file is the map
of the code.

| File | What it decides |
|---|---|
| `src/index.js` | The tick: what is due, fold results into state, dispatch |
| `src/targets.js` | What is watched, the public/private split, per-tier policy |
| `src/probe.js` | How one site is checked, and the front-door second opinion |
| `src/state.js` | What is remembered, and the debounce/renotify rules |
| `src/vendors.js` | Statuspage indicators — context, never a signal |
| `src/alerts.js` | Twilio and GitHub issues, and the wording |

## Three things not to change without reading the comment first

**KV writes.** The free plan allows 1,000 writes a day; this Worker wakes 1,440
times. `src/state.js` stores the *timestamp a failure began* rather than a
count of consecutive failures, precisely so that a bad tick does not cost a
write. Adding any per-tick counter to the state would exhaust the quota and
then fail silently — which is the worst possible failure for a monitor.

**Subrequests.** The free plan allows 50 per invocation, and each check can
make two (health, then the front door). `dueTargets()` deals prospects out
across the minutes of their interval rather than firing thirty at once. The
test asserts the per-minute ceiling.

**Alert routing.** Nothing here may go through the platform's own notification
stack — that stack runs on the machine being watched. Twilio is called
directly; the email path is a GitHub issue in the **private** repo. And alerts
go to platform operations only, never to a tenant.

## Local

```bash
npm install
npm test                      # pure logic, no Workers runtime needed
npx wrangler dev              # needs the secrets in .dev.vars (gitignored)
npx wrangler tail             # live logs from the deployed Worker
```

To force a tick without waiting for the cron:

```bash
curl -H "Authorization: Bearer $DASHBOARD_TOKEN" \
  https://atelier-monitor.<subdomain>.workers.dev/run
```
