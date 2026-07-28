#!/usr/bin/env bash
# Resolve the version for selfhost install.sh / build-frontend.sh, then export
# NEXT_PUBLIC_APP_VERSION so downstream bash-callable scripts (in particular
# build-frontend.sh's `pnpm --filter @multica/web build`) inherit it.
#
# Inputs (env):
#   MULTICA_UPSTREAM_REMOTE  — forwarded to scripts/resolve-official-baseline.sh
#   MULTICA_TRUSTED_BASELINE — same
# Outputs (writes to caller shell):
#   VERSION                          — the resolved tag, e.g. "v0.4.12"
#   exports NEXT_PUBLIC_APP_VERSION  — same value, so children inherit it
#
# Behavior is fail-closed under `set -euo pipefail`: if the resolver exits
# non-zero, the surrounding script aborts without falling back to a stale
# .env value or a hard-coded default. The previous install.sh's
# `${NEXT_PUBLIC_APP_VERSION:-v0.4.6}` fallback is intentionally gone.
#
# Sourced by:
#   - scripts/selfhost/install.sh   (production launchd build)
#   - scripts/selfhost-install.test.sh (sandboxed shell test)
# Both must source this script verbatim so install.sh's behavior under test
# is exactly its behavior in production.
#
# This file is sourced, never executed standalone. It has no `main` block and
# emits no stdout of its own; the caller is responsible for any echo/print.

REPO="${REPO:?REPO must be set by the caller (path to the checkout root)}"
MULTICA_BASELINE_RESOLVER="$REPO/scripts/resolve-official-baseline.sh"
[ -x "$MULTICA_BASELINE_RESOLVER" ] || [ -f "$MULTICA_BASELINE_RESOLVER" ] \
  || { echo "selfhost/_version-stamp.sh: resolver not found at $MULTICA_BASELINE_RESOLVER" >&2; return 1 2>/dev/null || exit 1; }

# Run the resolver inside the checkout root so `git describe --tags --abbrev=0`
# reads the same HEAD the deploy is leaving on disk — regardless of the
# caller's cwd. We cd back to the original directory afterwards so side-
# effects on $PWD do not leak back to install.sh or build-frontend.sh.
ORIG_CWD="$PWD"
cd "$REPO" || { echo "selfhost/_version-stamp.sh: cannot cd to REPO=$REPO" >&2; return 1 2>/dev/null || exit 1; }
VERSION="$(bash "$MULTICA_BASELINE_RESOLVER")"
cd "$ORIG_CWD"
export NEXT_PUBLIC_APP_VERSION="$VERSION"

