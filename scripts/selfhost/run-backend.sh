#!/usr/bin/env bash
# launchd wrapper that starts the Multica backend server binary.
#
# Two requirements that are easy to get wrong and silently break things:
#   1. cwd MUST be the repo root. LOCAL_UPLOAD_DIR defaults to ./data/uploads
#      (relative to cwd), so avatars/attachments 404 if the server is started
#      from any other directory. This is the same root cause as the historical
#      "agent avatars disappeared" bug.
#   2. launchd (like `go run`) does not load .env. Source it explicitly so
#      PORT, DATABASE_URL, etc. are injected before exec'ing the binary.
set -euo pipefail

# Repo root is fixed for this self-host checkout (see CLAUDE.md: no compatibility
# layers for internal code). Update here if the checkout moves.
REPO="/Users/fengzhao/multica"
SERVER="${HOME}/.multica/backend/server"

if [ ! -x "$SERVER" ]; then
  echo "ERROR: backend binary not found at $SERVER" >&2
  echo "       Run scripts/selfhost/install.sh (or make build-prod) first." >&2
  exit 1
fi

cd "$REPO"
# shellcheck disable=SC1091
set -a; . ./.env; set +a

exec "$SERVER"
