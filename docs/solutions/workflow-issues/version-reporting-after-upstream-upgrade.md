---
title: "Re-stamp both version strings on every upstream upgrade"
date: 2026-07-22
last_updated: 2026-08-17
category: "workflow-issues"
module: "self-host-upgrade"
problem_type: "workflow_issue"
component: "development_workflow"
severity: "medium"
applies_when:
  - "Upgrading a self-host Multica fork to a new upstream release tag"
  - "Help menu shows a stale frontend version or 'Backend unavailable' after an upgrade with healthy services"
  - "Running the backend via `go run` or an unstamped binary instead of a `-ldflags`-stamped build"
  - "Building the frontend without first bumping NEXT_PUBLIC_APP_VERSION in .env"
tags: [version-stamp, upgrade, self-hosting, build-provenance, go-ldflags, next-public, help-menu, silent-failure]
---

# Re-stamp both version strings on every upstream upgrade

## Context

After upgrading this self-host Multica fork (Go backend + Next.js frontend) to upstream `v0.4.6`, the in-app Help menu reported the frontend as `v0.4.3` (one release stale) and the backend as "unavailable" (the row was missing entirely). Both `/health` and the live product were working normally — this was not a service outage. The symptom is the signature of a forgotten version re-stamp, and the backend's "unavailable" state is an intentional silent-failure in the local provenance customization (PR #5539, CLOSED 2026-07-16; see `docs/customizations.md` and the design doc at `../architecture-patterns/runtime-build-provenance.md`).

The Help menu renders two independent provenance rows that are **always present in the DOM**, by design, so a stale or rolled-back artifact never looks identical to a missing one. Each row reads its value from the shared config store (`backendBaseline`) or the most-recently-active daemon's `cli_version`; when either value is empty or unparseable, the row falls back to a localized `unavailable` / `loading` string. So "stale CLI / missing backend" was exactly what you saw when the two injection points froze at their stale/empty defaults. (The original 2026-07-22 symptom described "stale frontend / missing backend" — the row was named Frontend then; the 2026-07-28 work replaced the frontend row with a daemon-CLI row whose value is the most-recently-active daemon's `cli_version`, but the "stale row + missing row" failure shape is unchanged.)

## Investigation

There are **two independent version-injection points**, and both must be re-stamped at upgrade time. Neither reads the running git state at request time; both freeze a value into the artifact at build time.

**Frontend — build-time env, inlined into the bundle.** The `.env` file hard-codes the value (`NEXT_PUBLIC_APP_VERSION=vX.Y.Z` at `.env:27`; the comment documents it as the "official baseline baked into the prod bundle at build time"). The web app reads it once at module load: `process.env.NEXT_PUBLIC_APP_VERSION || packageJson.version || "dev"` (`apps/web/components/web-providers.tsx:46`; 2026-08-17 refresh: that `|| packageJson.version || "dev"` chain now feeds only the **analytics** `identity.version`, deliberately separate from provenance — the provenance path passes the raw env var straight into `officialBaseline` as `frontendBaseline` at `web-providers.tsx:93`). Because `NEXT_PUBLIC_*` vars are inlined by the Next.js compiler at build time, the value captured is whatever `.env` held the day the bundle was built — bumping the tag without rebuilding leaves the old literal in the artifact. The value then crosses the platform boundary through `officialBaseline(process.env.NEXT_PUBLIC_APP_VERSION)` (`apps/web/components/web-providers.tsx:93`).

**Frontend — the sanitizer rejects non-tag values.** The shared `officialBaseline` helper (`packages/core/config/index.ts`) returns `""` for the empty string, `"dev"`, anything not matching `^v\d`, anything containing `-dirty`, and anything ending in a git-describe commit-distance suffix (`DESCRIBE_SUFFIX_RE = /-\d+-g[0-9-f]{4,}$/`). Note the `packageJson.version` fallback is `0.2.0`, which fails the `^v\d` test and also sanitizes to `""` — so an unstamped frontend build shows "unavailable", not a misleading semver. Related ordering trap: on the self-host flow the version re-stamp (`install.sh` → `git describe --tags --abbrev=0`) needs the upgrade's merge commit to already exist — stamping from a working tree pre-commit resolves the previous tag; see the upgrade skill's `.claude/skills/upgrade-upstream/references/host-facts.md` (commit-first).

**Backend — a `var` stamped via `-ldflags`, defaulting to `dev`.** The binary's version is a package variable: `version = "dev"` (`server/cmd/server/main.go:30`). Nothing in the program reads the git checkout at runtime; the value is whatever was injected at compile time. It is canonicalized once at router construction: `ServerVersion: officialBaseline(version)` (`server/cmd/server/router.go:224`). The backend copy of the sanitizer lives in its own file to keep the customization off upstream's hot path (`server/cmd/server/provenance_baseline.go`); its regex is the Go mirror of the frontend's, and `officialBaseline` maps `""`, `"dev"`, any non-`v<num>` string, any `-dirty` value, and any describe-suffixed value to `""`.

**Backend — empty is omitted from the public config.** The field is `ServerVersion string \`json:"server_version,omitempty"\`` (`server/internal/handler/config.go:62-67`), populated only on self-host (gated by `if !isOfficialCloudDeployment()`). `omitempty` plus an empty string means the key is dropped from the JSON entirely — which is exactly why a `curl /api/config` against an unstamped backend returns no `server_version` field at all. On the client, that missing field settles the config store's `backendBaseline` to `""`, and the Help row renders "Backend unavailable".

**Why `git describe` is not a drop-in stamp.** On a checkout that has moved past the tag, `git describe --tags` yields `vX.Y.Z-NNN-g<hash>` and no tag points at HEAD. That `-N-g<hash>` suffix is precisely what both `officialBaseline` implementations reject, so feeding the raw `git describe` string into `-X main.version` (or into `NEXT_PUBLIC_APP_VERSION`) still produces "unavailable". The count advances with every commit; the rejected invariant is the suffix form, not the specific number.

## Root cause

Two version-injection points freeze at stale or empty values unless explicitly re-stamped on upgrade. The frontend default is a stale hard-coded `.env` literal (not derived from git), captured at build time. The backend default is `"dev"`: `go run ./cmd/server` and a bare `go build` without `-ldflags` both leave `main.version` at its `"dev"` default, which `officialBaseline` collapses to `""`, which `omitempty` drops from `/api/config`, which the client renders as "Backend unavailable".

The reason this surfaces as a confusing "backend broken" symptom rather than a clear "you forgot to stamp" error is a deliberate silent-failure in the provenance customization (PR #5539, CLOSED by upstream 2026-07-16). The design never presents a commit hash, a `-dirty` marker, or the literal `dev` as a release baseline — it would rather show "unavailable" than lie about what is deployed. That is the right product call (an operator who acts on a fake baseline is worse off than one who sees "unavailable"), but it means a forgotten re-stamp looks identical to "the backend is down" even though every service is healthy.

## Resolution (launchd path automated after 2026-07-28; manual fallback remains)

**Frontend — `bash scripts/selfhost/install.sh` on the launchd path**
(2026-07-28 onward). install.sh derives `NEXT_PUBLIC_APP_VERSION` from
`scripts/resolve-official-baseline.sh` and exports it so build-frontend.sh
inherits the tag. The bare `.env` file no longer drives the version stamp,
so a stale or missing `.env` does not over- or under-stamp the build.
`MULTICA_TRUSTED_BASELINE` remains the only override when derivation is
unavailable (offline hosts, shallow clones, fork tracking a different
upstream). Verify with `curl -s http://localhost:8081/api/config |
grep server_version` — the resolver fails closed if it cannot establish
a baseline, so an unchanged tag is loud, not silent.

**Backend — launched as `~/.multica/backend/server` by install.sh.**
install.sh builds the binary with the same resolved tag via
`go build -ldflags "-X main.version=$NEXT_PUBLIC_APP_VERSION"` (see
`scripts/selfhost/install.sh`). For non-install.sh paths (e.g. `make
build-prod` not used through launchd, or running `go run` for
single-process dev), the manual two-step below remains the fallback:

```sh
go build -C server -o bin/server \
  -ldflags "-X main.version=v0.4.6" ./cmd/server
```

Then run `bin/server`. The `-X main.version=<clean-tag>` linker flag is the only thing that overrides the `"dev"` default at `server/cmd/server/main.go:30`; `go run` does not pass `-ldflags` through and leaves the default in place. Pass the **clean tag** (`v0.4.6`), not `git describe` output — the `-N-g<hash>` suffix is rejected by `officialBaseline` on both sides. To avoid hand-typing the tag, derive it from the supported helper:

```sh
BASELINE=$(scripts/resolve-official-baseline.sh)   # emits a clean vX.Y.Z or exits non-zero
go build -C server -o bin/server -ldflags "-X main.version=$BASELINE" ./cmd/server
```

`scripts/resolve-official-baseline.sh` derives the nearest official tag via `git describe --tags --abbrev=0 --match 'v[0-9]*'`, verifies it against upstream release tags, and is designed never to emit `dev`, a hash, or a dirty suffix.

## Verification

After both re-stamps, all three observations converge on the target tag:

- `GET /api/config` returns `server_version: "v0.4.6"` — the field is no longer dropped, because `officialBaseline("v0.4.6")` returns the tag unchanged and `!isOfficialCloudDeployment()` is true on self-host.
- The rebuilt frontend bundle greps clean for `v0.4.6`, confirming the build-time inlined literal was refreshed.
- The Help menu shows both rows as `v0.4.6`.

## Prevention

- **For the launchd path, the upgrade checklist is `git fetch && git checkout <tag> && bash scripts/selfhost/install.sh && curl /api/config` — no manual version edits.** install.sh derives VERSION from `resolve-official-baseline.sh` and exports `NEXT_PUBLIC_APP_VERSION` so both halves stamp from the same tag (see the doc's "Resolution" and `../architecture-patterns/runtime-build-provenance.md`). The upgrade-upstream skill's hard-facts and the `project-version-stamp-on-upgrade` memory reflect this; this doc is the written-down reasoning for why the manual two-step below is now the non-launchd fallback, not the standard path.
- **For non-launchd paths** (e.g. `make build-prod`, bare `go run`, custom deploy scripts that bypass `scripts/selfhost/install.sh`): stamp the backend with `go build -ldflags "-X main.version=<clean-tag>"` (where the clean tag comes from `BASELINE=$(scripts/resolve-official-baseline.sh)`), then build the frontend with `NEXT_PUBLIC_APP_VERSION=$TAG pnpm --filter @multica/web build`. The pattern survives whenever install.sh isn't the entry point.
- **Recognize the silent-failure signature when using a hardened resolver:** "Help says Backend unavailable, but `/health` is 200 and the product works" no longer means *forgotten re-stamp*. It now means the resolver failed (no upstream-verified tag reachable, or `MULTICA_UPSTREAM_REMOTE` unreachable) and install.sh aborted under `set -euo pipefail`. Fix: set `MULTICA_TRUSTED_BASELINE=vX.Y.Z` to supply an explicit trusted baseline.
- **Do not weaken the sanitizer to "make this work".** Mapping `dev` to a visible value would turn every unstamped dev build into a misleading baseline; the silent-failure was load-bearing for the old `v0.4.6-fallback` behavior and it remains load-bearing today (the resolver is fail-closed). The right lever is the resolver invocation (always call it, never `go run` in prod), not the sanitizer.
- **Under launchd supervision, the stamped binary is what keeps getting re-executed.** The backend wrapper `scripts/selfhost/run-backend.sh` `exec`s `~/.multica/backend/server`, so `scripts/selfhost/install.sh` must build that binary with `-ldflags` (calling `scripts/resolve-official-baseline.sh` for the clean tag). If the wrapper execs an unstamped binary, launchd's crash-recovery keeps restarting an unstamped server, and the "Backend unavailable" silent-failure persists under supervision exactly as it does under a hand-run `go run` (see `docs/solutions/runtime-errors/caddy-standalone-launchd.md`).

## Related

- `docs/solutions/architecture-patterns/runtime-build-provenance.md` — full design doc for the provenance feature and the sanitizer's four resolution semantics (originating PR #5539, CLOSED 2026-07-16).
- `docs/solutions/workflow-issues/safe-upstream-upgrade-with-local-customizations.md` — the upgrade SOP whose Step 7/8 omit version re-stamping; this doc is the sibling that fills that gap (same "post-merge step the workflow forgot" family as `unapplied-migrations-after-upstream-upgrade` and `pnpm-install-after-upstream-merge`).
- `docs/solutions/test-failures/migration-lint-duplicate-prefix-whitelist-gap.md` — companion from the same v0.4.6 upgrade; shares the meta-pattern of a self-host gotcha staying hidden because `make test`/`make start` are Docker-gated and skipped on Homebrew-pg self-host.
- `docs/customizations.md` — ledger entry for the provenance customization (#5539), including this re-stamp gotcha.
- `docs/solutions/runtime-errors/caddy-standalone-launchd.md` — launchd + standalone production setup; its `install.sh` builds the stamped backend binary, so the launchd-executed server carries the version tag (linking the re-stamp requirement to the new supervised execution path).
- `scripts/resolve-official-baseline.sh` — supported helper that derives a clean official tag (or fails) so build paths never emit `dev`/hash/dirty.
