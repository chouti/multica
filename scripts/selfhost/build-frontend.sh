#!/usr/bin/env bash
# Build the @multica/web frontend as a standalone bundle and assemble it into
# the deploy directory (~/.multica/frontend).
#
# Why standalone: next.config.ts gates `output: "standalone"` behind
# STANDALONE=true. The product is a self-contained apps/web/server.js plus a
# traced node_modules, runnable without the repo's dev environment and without
# colliding with `pnpm dev:web` (which uses apps/web/.next directly).
#
# Rewrites (/api, /uploads, /auth, /ws -> backend) are resolved by
# next.config.ts at BUILD time from REMOTE_API_URL and baked into the routes
# manifest, so the value below is what the running server will proxy to.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEPLOY="${HOME}/.multica/frontend"

# Build-time inputs baked into the manifest / client bundle.
export STANDALONE=true
export REMOTE_API_URL="${REMOTE_API_URL:-http://localhost:8081}"
export NEXT_PUBLIC_APP_VERSION="${NEXT_PUBLIC_APP_VERSION:-v0.4.6}"

echo "==> Building @multica/web (standalone, REMOTE_API_URL=$REMOTE_API_URL)..."
cd "$REPO"
pnpm --filter @multica/web build

STANDALONE_DIR="apps/web/.next/standalone"
if [ ! -f "$STANDALONE_DIR/apps/web/server.js" ]; then
  echo "ERROR: expected standalone server not found at $STANDALONE_DIR/apps/web/server.js" >&2
  echo "       (did STANDALONE=true take effect? check apps/web/next.config.ts)" >&2
  exit 1
fi

echo "==> Assembling standalone bundle into $DEPLOY ..."
rm -rf "$DEPLOY"
mkdir -p "$DEPLOY"

# server.js + traced node_modules, mirroring the monorepo layout (apps/web/...).
cp -R "$STANDALONE_DIR/." "$DEPLOY/"

# Static assets and public/ are NOT traced into standalone; server.js expects
# them at apps/web/.next/static and apps/web/public (relative to cwd = deploy root).
rm -rf "$DEPLOY/apps/web/.next/static" "$DEPLOY/apps/web/public"
cp -R "apps/web/.next/static" "$DEPLOY/apps/web/.next/static"
cp -R "apps/web/public" "$DEPLOY/apps/web/public"

echo "==> Done."
echo "    Server:  $DEPLOY/apps/web/server.js"
echo "    Run:     PORT=3001 HOSTNAME=127.0.0.1 node $DEPLOY/apps/web/server.js"
