#!/usr/bin/env bash
# =============================================================================
# sync-private-targets.sh — build the Worker's unlisted target list from prod.
#
# Atelier runs ~32 sites and has exactly ONE real tenant. The rest are
# unsolicited prospect pitch sites for businesses that have not agreed to
# anything, and this repository is PUBLIC. So that list never lands in a file
# here: it is read off the production box, reviewed by a human, and pushed
# straight into a Cloudflare Worker secret.
#
# A secret is not in the repository, not in git history, and not in the
# deployment bundle a reader can inspect.
#
#   ./scripts/sync-private-targets.sh              # print the JSON, change nothing
#   ./scripts/sync-private-targets.sh --push       # print it, then set the secret
#
# READ THE OUTPUT BEFORE PUSHING. This is the one place where getting the list
# wrong means monitoring something that should not be monitored, or silently
# not monitoring the tenant that pays.
#
# Exclusions, in order:
#   * the three sites already published by Upptime (see ../.upptimerc.yml)
#   * `default`, which is not a site
#   * anything listed in env/_monitor-exclude.txt on the server, one site
#     directory per line — that is where retired tenants go. A deprovisioned
#     host answers 410 by design, and monitoring it would alert forever about
#     a site that is supposed to be gone.
# =============================================================================
set -euo pipefail

SSH_TARGET="${ATELIER_SSH_TARGET:-nicholas@109.228.57.50}"
SSH_IDENTITY="${ATELIER_SSH_IDENTITY:-$HOME/.ssh/id_rsa-1}"
REMOTE_ROOT="${ATELIER_REMOTE_ROOT:-/var/www/html/atelier}"

PUSH=false
[ "${1:-}" = "--push" ] && PUSH=true

# ---------------------------------------------------------------------------
# Discover site directories and their primary hostname.
#
# Two shapes coexist on this platform and both have to be handled:
#   * env/<dir>.sites.yml declares the hostnames that route to <dir>. The
#     first one listed is the canonical one.
#   * a site whose hostname equals its directory name needs no mapping file at
#     all — that is Drupal's own convention, and it is the only reason TLP
#     survived the 2026-08-28 sites.yml permissions fault while demoweb did
#     not.
#
# So: read the hostname from the mapping file when there is one, and fall back
# to the directory name when there is not.
# ---------------------------------------------------------------------------
raw="$(ssh "$SSH_TARGET" -i "$SSH_IDENTITY" bash -s <<REMOTE
set -euo pipefail
cd "$REMOTE_ROOT"

exclude_file="env/_monitor-exclude.txt"

for env_file in env/*.env.yml; do
  [ -e "\$env_file" ] || continue
  dir="\$(basename "\$env_file" .env.yml)"

  [ "\$dir" = "default" ] && continue
  if [ -f "\$exclude_file" ] && grep -qxF "\$dir" "\$exclude_file"; then
    continue
  fi

  host=""
  if [ -r "env/\$dir.sites.yml" ]; then
    host="\$(awk '/^sites:/{f=1;next} f&&/^[[:space:]]*-[[:space:]]*/{gsub(/^[[:space:]]*-[[:space:]]*/,"");gsub(/["'"'"']/,"");print;exit}' "env/\$dir.sites.yml")"
  fi
  [ -n "\$host" ] || host="\$dir"

  # A directory that is not a hostname and has no mapping cannot be reached
  # over HTTP, so there is nothing to monitor.
  case "\$host" in
    *.*) printf '%s\t%s\n' "\$dir" "\$host" ;;
  esac
done
REMOTE
)"

# ---------------------------------------------------------------------------
# Drop the sites Upptime already publishes, and emit JSON.
#
# The id is the site DIRECTORY, not the hostname. Directories are stable —
# a tenant changing domains is a one-line edit in their .sites.yml — so the
# monitor's state, and any open incident issue, survives a rename.
# ---------------------------------------------------------------------------
json="$(printf '%s\n' "$raw" | awk -F'\t' '
  BEGIN { print "["; first = 1 }
  NF < 2 { next }
  $2 == "timberlodgeparlor.com"        { next }
  $2 == "bookwithatelier.com"          { next }
  $2 == "studio.bookwithatelier.com"   { next }
  {
    if (!first) printf ",\n"
    first = 0
    printf "  {\"id\": \"%s\", \"name\": \"%s\", \"url\": \"https://%s\", \"tier\": \"prospect\"}", $1, $2, $2
  }
  END { print "\n]" }
')"

count="$(printf '%s\n' "$json" | grep -c '"id"' || true)"

echo "$json"
echo ""
echo "── $count unlisted target(s) discovered ──" >&2

if [ "$PUSH" != true ]; then
  echo "Dry run. Review the list above, then re-run with --push to set the secret." >&2
  exit 0
fi

echo "Setting PRIVATE_TARGETS on the Worker..." >&2
printf '%s' "$json" | (cd "$(dirname "$0")/../worker" && npx wrangler secret put PRIVATE_TARGETS)
echo "Done. The next cron tick picks it up — no redeploy needed." >&2
