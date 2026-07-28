#!/usr/bin/env bash
# One-shot install for the production Multica frontend (standalone) + backend,
# both supervised by launchd so they survive reboots and auto-restart on crash.
#
# What it does:
#   1. Builds the Go backend binary        -> ~/.multica/backend/server
#   2. Builds the standalone Next frontend -> ~/.multica/frontend  (build-frontend.sh)
#   3. Installs run-backend.sh + both launchd plists
#   4. Loads (or reloads) the launchd jobs
#
# Re-running is safe: it rebuilds, redeploys, and reloads the jobs.
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SELF_DIR/../.." && pwd)"
MULTICA_HOME="${HOME}/.multica"
LAUNCH_AGENTS="${HOME}/Library/LaunchAgents"
UID_NUM="$(id -u)"

# Source the repo .env so build-frontend.sh picks up non-version settings
# such as REMOTE_API_URL. The version is NO LONGER read from .env — see
# _version-stamp.sh below; the previous `${NEXT_PUBLIC_APP_VERSION:-v0.4.6}`
# fallback is intentionally gone so a stale or missing .env no longer
# stamps the wrong release. Without selfhost/_version-stamp.sh sourcing
# this script here, the launchd build stamps v0.4.6 forever regardless of
# the checked-out tag and the Help menu silently reports the wrong version.
if [ -f "$REPO/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$REPO/.env"
  set +a
fi

# shellcheck source=/dev/null
. "$SELF_DIR/_version-stamp.sh"

echo "==> Preparing $MULTICA_HOME ..."
mkdir -p "$MULTICA_HOME"/{backend,scripts,logs}

echo "==> Building backend binary -> $MULTICA_HOME/backend/server ..."
cd "$REPO/server"
CGO_ENABLED=0 go build -ldflags "-s -w -X main.version=${VERSION}" \
  -o "$MULTICA_HOME/backend/server" ./cmd/server

echo "==> Building standalone frontend (this takes a while) ..."
cd "$REPO"
bash "$SELF_DIR/build-frontend.sh"

echo "==> Installing run-backend.sh ..."
cp "$SELF_DIR/run-backend.sh" "$MULTICA_HOME/scripts/run-backend.sh"
chmod +x "$MULTICA_HOME/scripts/run-backend.sh"

echo "==> Installing + loading launchd plists ..."
mkdir -p "$LAUNCH_AGENTS"
for label in frontend backend; do
  job="gui/$UID_NUM/com.fengzhao.multica-${label}"
  domain="gui/$UID_NUM"
  plist="com.fengzhao.multica-${label}.plist"
  # Bootout first if a previous version is loaded (idempotent reload).
  if launchctl print "$job" >/dev/null 2>&1; then
    launchctl bootout "$job" 2>/dev/null || true
    for _ in 1 2 3 4 5; do
      launchctl print "$job" >/dev/null 2>&1 || break
      sleep 1
    done
  fi
  cp "$SELF_DIR/$plist" "$LAUNCH_AGENTS/$plist"
  for attempt in 1 2 3; do
    if launchctl bootstrap "$domain" "$LAUNCH_AGENTS/$plist" 2>/dev/null || \
      launchctl load "$LAUNCH_AGENTS/$plist" 2>/dev/null; then
      launchctl print "$job" >/dev/null 2>&1 && break
    fi
    if [ "$attempt" = "3" ]; then
      echo "ERROR: failed to load com.fengzhao.multica-${label}" >&2
      exit 1
    fi
    sleep 1
  done
  echo "    loaded com.fengzhao.multica-${label}"
done

echo ""
echo "==> Installed. Verify:"
echo "    lsof -nP -iTCP:3001 -sTCP:LISTEN    # frontend"
echo "    lsof -nP -iTCP:8081 -sTCP:LISTEN    # backend"
echo "    curl -I http://localhost:8081/uploads/workspaces/<id>/<file>.png"
echo "    open https://multica.aicake.com/"
echo ""
echo "    Logs: tail -f $MULTICA_HOME/logs/{frontend,backend}.err.log"
