#!/usr/bin/env bash
# Tests for the launchd production build's version resolution.
#
# Pins scripts/selfhost/install.sh's version-stamping contract (KTD1):
#   - VERSION is resolved from scripts/resolve-official-baseline.sh
#     (nearest upstream-verified tag), not from .env or a hardcoded
#     fallback.
#   - install.sh exports NEXT_PUBLIC_APP_VERSION from the resolved
#     VERSION, so build-frontend.sh picks it up and overrides any
#     NEXT_PUBLIC_APP_VERSION the .env source block happened to load.
#     Stale .env values must not win.
#   - When the resolver fails (no reachable tag, no override), install.sh
#     fails closed: the resolver exits non-zero and stamp's set -euo
#     pipefail aborts the surrounding script. No fallback to v0.4.6.
#
# Fixture strategy: stamp itself does `cd "$REPO"` then invokes the
# resolver then `cd` back. The test points REPO at this very repository
# ($ROOT_DIR) and constructs fixture tags (v0.4.12-fixture-test and
# v0.4.6-stale-fixture) against a throwaway local upstream so the resolver
# derives deterministically. Both are torn down in the trap.
#
# The test does NOT need to build a parallel git fixture; it uses the
# real multica checkout as the version source, with a fixture *upstream*
# that advertises exactly the tags the test wants.
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RESOLVER="$ROOT_DIR/scripts/resolve-official-baseline.sh"
STAMP="$ROOT_DIR/scripts/selfhost/_version-stamp.sh"

pass=0
fails=0

# Captures a child process's exit status without losing it to `set -e` of the
# command substitution. Writes the child's stdout to a per-call sink file.
run_install_stamp() {
  local fake_env_value="$1" want_trusted="${2:-}"
  local sink
  sink="$(mktemp)"
  (
    set -euo pipefail
    REPO="$ROOT_DIR"
    export REPO
    # Mirror install.sh's source block: source .env (if any) BEFORE stamp
    # is sourced so a stale NEXT_PUBLIC_APP_VERSION in .env is forced through
    # the helper and visibly overridden by the resolved VALUE.
    if [ -n "$fake_env_value" ]; then
      NEXT_PUBLIC_APP_VERSION="$fake_env_value"
      export NEXT_PUBLIC_APP_VERSION
    fi
    MULTICA_UPSTREAM_REMOTE="${MULTICA_UPSTREAM_REMOTE:-}"
    export MULTICA_UPSTREAM_REMOTE
    MULTICA_TRUSTED_BASELINE="$want_trusted"
    export MULTICA_TRUSTED_BASELINE
    # shellcheck source=/dev/null
    . "$STAMP"
    printf 'VERSION=%s\n' "$VERSION"
    printf 'NEXT_PUBLIC_APP_VERSION=%s\n' "$NEXT_PUBLIC_APP_VERSION"
  ) >"$sink"
  RUN_RC=$?
  RUN_OUT="$(cat "$sink")"
  rm -f "$sink"
}

expect_value() {
  local name="$1" var="$2" want="$3"
  local got
  got="$(printf '%s\n' "$RUN_OUT" | awk -F= -v k="$var" '$1==k {print substr($0, length(k)+2)}')"
  if [ "$RUN_RC" = "0" ] && [ "$got" = "$want" ]; then
    echo "ok   - $name"
    pass=$((pass + 1))
  else
    echo "FAIL - $name: want $var=$want, got '$got', exit $RUN_RC"
    fails=$((fails + 1))
  fi
}

expect_fail() {
  local name="$1"
  if [ "$RUN_RC" != "0" ]; then
    echo "ok   - $name"
    pass=$((pass + 1))
  else
    echo "FAIL - $name: expected non-zero exit, got exit 0"
    fails=$((fails + 1))
  fi
}

# Build a throwaway "upstream" git fixture that advertises exactly the tags
# we want the resolver to derive. The resolver verifies its candidate against
# `git ls-remote $MULTICA_UPSTREAM_REMOTE`; pointing that at a local fixture
# keeps the test offline and deterministic.
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$WORK/upstream"
git -C "$WORK/upstream" init -q
git -C "$WORK/upstream" config user.email t@t.t
git -C "$WORK/upstream" config user.name t
git -C "$WORK/upstream" commit -q --allow-empty -m upstream-init
git -C "$WORK/upstream" tag "v0.4.6-stale-fixture"
git -C "$WORK/upstream" tag "v0.4.12-fixture-test"

# So the multica repo (`$ROOT_DIR`) can `git describe` to one of the upstream
# tags, give its HEAD a matching tag locally. We use a throwaway branch + tag
# pair so nothing leaks into the user's branch.
cd "$ROOT_DIR"
ORIG_BRANCH="$(git branch --show-current)"
ORIG_TAG="$(git describe --tags --abbrev=0 2>/dev/null || true)"
cleanup_fixture_tags() {
  git tag -d "v0.4.12-fixture-test" 2>/dev/null || true
  git checkout "$ORIG_BRANCH" >/dev/null 2>&1 || git checkout - >/dev/null 2>&1 || true
  git branch -D fixture-version-test 2>/dev/null || true
}
trap 'cleanup_fixture_tags; rm -rf "$WORK"' EXIT
git checkout -b fixture-version-test >/dev/null 2>&1
git commit -q --allow-empty -m fixture-version-test
# Tag name intentionally matches one of $WORK/upstream's tags so the resolver's
# upstream verification passes for this fixture.
git tag "v0.4.12-fixture-test"

export MULTICA_UPSTREAM_REMOTE="$WORK/upstream"

# 1. Happy path: resolver derives v0.4.12-fixture-test, .env says
#    v0.4.6-stale-fixture. install.sh must override .env with the tag.
run_install_stamp "v0.4.6-stale-fixture" ""
expect_value "resolver-stamped VERSION wins over stale .env" "VERSION" "v0.4.12-fixture-test"
expect_value "NEXT_PUBLIC_APP_VERSION exported from VERSION" "NEXT_PUBLIC_APP_VERSION" "v0.4.12-fixture-test"

# 2. Override: stale .env in NEXT_PUBLIC_APP_VERSION must NOT win.
#    (Re-asserted independently for the override contract.)
expect_value "resolver-derived NEXT_PUBLIC_APP_VERSION overrides .env" "NEXT_PUBLIC_APP_VERSION" "v0.4.12-fixture-test"

# 3. Fail-closed when MULTICA_TRUSTED_BASELINE is unset and the multica HEAD
#    tag is removed so derivation is unavailable. We move HEAD to an
#    orphan commit so git describe --tags --abbrev=0 has no v* tag.
git tag -d "v0.4.12-fixture-test" >/dev/null
# Create a temp commit that has no v* tag reachable from it.
git commit -q --allow-empty -m no-tags-fixture
run_install_stamp "" ""
expect_fail "no reachable v* tag and no trusted override fails closed"

# 4. Fail-closed even with stale .env present.
NEXT_PUBLIC_APP_VERSION="v0.4.6-stale-fixture"
export NEXT_PUBLIC_APP_VERSION
run_install_stamp "$NEXT_PUBLIC_APP_VERSION" ""
expect_fail "no reachable tag + stale .env still fails closed (no v0.4.6 fallback)"

echo
echo "pass=$pass fail=$fails"
[ "$fails" = "0" ] || exit 1
