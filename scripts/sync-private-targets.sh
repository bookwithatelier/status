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

  # Tier comes from env/_monitor-scopes.txt — the SAME file the health
  # endpoint's ?scope= aggregate reads. Deriving it twice from two sources
  # would let the public categories and the private alerting drift apart
  # silently, which is how a real tenant ends up alerting like a prospect.
  scope="prospect"
  if [ -r "env/_monitor-scopes.txt" ]; then
    found="\$(awk -v d="\$dir" '\$1==d && \$2!="" {print \$2; exit}' env/_monitor-scopes.txt)"
    case "\$found" in
      tenant|platform|prospect) scope="\$found" ;;
    esac
  fi

  # A directory that is not a hostname and has no mapping cannot be reached
  # over HTTP, so there is nothing to monitor.
  case "\$host" in
    *.*) printf '%s\t%s\t%s\n' "\$dir" "\$host" "\$scope" ;;
  esac
done
REMOTE
)"

# ---------------------------------------------------------------------------
# Drop the sites the Worker already hard-codes, and emit JSON.
#
# Matched on the site DIRECTORY, not the hostname. A directory is exact and
# stable; a hostname is neither. studio.bookwithatelier.com's first declared
# host is find.bookwithatelier.com — the consumer directory surface, not the
# control plane — so a hostname filter silently let it through as a duplicate
# prospect, which is both a wasted check and a second set of alerts for one
# site.
#
# The id stays the directory too: a tenant changing domains is a one-line edit
# in their .sites.yml, and the monitor's state and any open incident issue
# survive it.
# ---------------------------------------------------------------------------
json="$(printf '%s\n' "$raw" | awk -F'\t' '
  BEGIN { print "["; first = 1 }
  NF < 3 { next }
  $1 == "timberlodgeparlor.com"        { next }
  $1 == "bookwithatelier.com"          { next }
  $1 == "studio.bookwithatelier.com"   { next }
  {
    if (!first) printf ",\n"
    first = 0
    printf "  {\"id\": \"%s\", \"name\": \"%s\", \"url\": \"https://%s\", \"tier\": \"%s\"}", $1, $2, $2, $3
  }
  END { print "\n]" }
')"

# ---------------------------------------------------------------------------
# Drop targets whose hostname does not resolve, loudly.
#
# A site's sites.yml can name a hostname that no longer has DNS — demoweb
# declares web.demo.bookwithatelier.com, which was retired in favour of a path
# on the demo site. The Worker would check it, get Cloudflare's 530, and file
# a perfectly correct outage alert about a host that is not supposed to exist.
#
# That is the worst kind of monitoring bug: not wrong, just useless, and
# repeating every renotify interval until somebody starts ignoring the alerts.
# Catching it here means a human sees it once during review instead.
#
# Such a site is NOT unmonitored: /health.php?scope= evaluates it on the box,
# where no hostname is involved at all.
# ---------------------------------------------------------------------------
unresolved="$(printf '%s\n' "$json" \
  | sed -n 's|.*"url": "https://\([^/"]*\)".*|\1|p' \
  | while IFS= read -r host; do
      [ -n "$host" ] || continue
      # An `if`, not `[ ... ] && echo`: under `set -e` that && evaluates to
      # non-zero for every host that DOES resolve, so the loop exits 1 on the
      # happy path and takes the whole script with it.
      if [ -z "$(dig +short "$host" 2>/dev/null | head -1)" ]; then
        echo "$host"
      fi
    done || true)"

if [ -n "$unresolved" ]; then
  echo "" >&2
  echo "  WARNING: dropping target(s) whose hostname does not resolve:" >&2
  printf '    %s\n' $unresolved >&2
  echo "  Their sites.yml names a host with no DNS. They stay covered by" >&2
  echo "  /health.php?scope=, which runs on the box and needs no hostname." >&2
  echo "" >&2
  # Re-serialised in Python rather than patched with sed: removing an element
  # from a hand-built JSON array with line tools means fixing up a trailing
  # comma, and getting that subtly wrong produces a malformed secret that the
  # Worker silently ignores — which would disable every private target at once.
  json="$(printf '%s' "$json" | UNRESOLVED="$unresolved" python3 -c '
import json, os, sys
bad = set(os.environ["UNRESOLVED"].split())
targets = [t for t in json.load(sys.stdin)
           if t["url"].split("://", 1)[1].split("/")[0] not in bad]
print(json.dumps(targets, indent=2))
')"
fi

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
