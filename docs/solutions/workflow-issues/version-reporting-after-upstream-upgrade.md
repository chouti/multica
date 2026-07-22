---
title: "Re-stamp both version strings on every upstream upgrade"
date: 2026-07-22
last_updated: 2026-07-22
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

After upgrading this self-host Multica fork (Go backend + Next.js frontend) to upstream `v0.4.6`, the in-app Help menu reported the frontend as `v0.4.3` (one release stale) and the backend as "unavailable" (the row was missing entirely). Both `/health` and the live product were working normally — this was not a service outage. The symptom is the signature of a forgotten version re-stamp, and the backend's "unavailable" state is an intentional silent-failure in the local provenance customization (PR #5539, CLOSED 2026-07-16; see `docs/customizations.md` and the design doc at `docs/solutions/architecture-patterns/runtime-build-provenance.md`).

The Help menu renders two independent provenance rows that are **always present in the DOM**, by design, so a stale or rolled-back artifact never looks identical to a missing one. Each row reads its value from the shared config store (`frontendBaseline` and `backendBaseline`); when either value is empty, the row falls back to a localized `frontend_unavailable` / `backend_unavailable` string. So "stale frontend / missing backend" is exactly what you see when the two injection points freeze at their stale/empty defaults.

## Investigation

There are **two independent version-injection points**, and both must be re-stamped at upgrade time. Neither reads the running git state at request time; both freeze a value into the artifact at build time.

**Frontend — build-time env, inlined into the bundle.** The `.env` file hard-codes the value (`NEXT_PUBLIC_APP_VERSION=vX.Y.Z` at `.env:26`; the comment documents it as the "official baseline baked into the prod bundle at build time"). The web app reads it once at module load: `process.env.NEXT_PUBLIC_APP_VERSION || packageJson.version || "dev"` (`apps/web/components/web-providers.tsx:44-45`). Because `NEXT_PUBLIC_*` vars are inlined by the Next.js compiler at build time, the value captured is whatever `.env` held the day the bundle was built — bumping the tag without rebuilding leaves the old literal in the artifact. The value then crosses the platform boundary through `officialBaseline(process.env.NEXT_PUBLIC_APP_VERSION)` (`apps/web/components/web-providers.tsx:88`).

**Frontend — the sanitizer rejects non-tag values.** The shared `officialBaseline` helper (`packages/core/config/index.ts`) returns `""` for the empty string, `"dev"`, anything not matching `^v\d`, anything containing `-dirty`, and anything ending in a git-describe commit-distance suffix (`DESCRIBE_SUFFIX_RE = /-\d+-g[0-9-f]{4,}$/`). Note the `packageJson.version` fallback is `0.2.0`, which fails the `^v\d` test and also sanitizes to `""` — so an unstamped frontend build shows "unavailable", not a misleading semver.

**Backend — a `var` stamped via `-ldflags`, defaulting to `dev`.** The binary's version is a package variable: `version = "dev"` (`server/cmd/server/main.go:30`). Nothing in the program reads the git checkout at runtime; the value is whatever was injected at compile time. It is canonicalized once at router construction: `ServerVersion: officialBaseline(version)` (`server/cmd/server/router.go:204`). The backend copy of the sanitizer lives in its own file to keep the customization off upstream's hot path (`server/cmd/server/provenance_baseline.go`); its regex is the Go mirror of the frontend's, and `officialBaseline` maps `""`, `"dev"`, any non-`v<num>` string, any `-dirty` value, and any describe-suffixed value to `""`.

**Backend — empty is omitted from the public config.** The field is `ServerVersion string \`json:"server_version,omitempty"\`` (`server/internal/handler/config.go:60`), populated only on self-host (gated by `if !isOfficialCloudDeployment()`). `omitempty` plus an empty string means the key is dropped from the JSON entirely — which is exactly why a `curl /api/config` against an unstamped backend returns no `server_version` field at all. On the client, that missing field settles the config store's `backendBaseline` to `""`, and the Help row renders "Backend unavailable".

**Why `git describe` is not a drop-in stamp.** On a checkout that has moved past the tag, `git describe --tags` yields `vX.Y.Z-NNN-g<hash>` and no tag points at HEAD. That `-N-g<hash>` suffix is precisely what both `officialBaseline` implementations reject, so feeding the raw `git describe` string into `-X main.version` (or into `NEXT_PUBLIC_APP_VERSION`) still produces "unavailable". The count advances with every commit; the rejected invariant is the suffix form, not the specific number.

## Root cause

Two version-injection points freeze at stale or empty values unless explicitly re-stamped on upgrade. The frontend default is a stale hard-coded `.env` literal (not derived from git), captured at build time. The backend default is `"dev"`: `go run ./cmd/server` and a bare `go build` without `-ldflags` both leave `main.version` at its `"dev"` default, which `officialBaseline` collapses to `""`, which `omitempty` drops from `/api/config`, which the client renders as "Backend unavailable".

The reason this surfaces as a confusing "backend broken" symptom rather than a clear "you forgot to stamp" error is a deliberate silent-failure in the provenance customization (PR #5539, CLOSED by upstream 2026-07-16). The design never presents a commit hash, a `-dirty` marker, or the literal `dev` as a release baseline — it would rather show "unavailable" than lie about what is deployed. That is the right product call (an operator who acts on a fake baseline is worse off than one who sees "unavailable"), but it means a forgotten re-stamp looks identical to "the backend is down" even though every service is healthy.

## Resolution

**Frontend — bump the env, then rebuild.**

1. Edit `.env` and set `NEXT_PUBLIC_APP_VERSION` to the target **clean** tag (e.g. `v0.4.6`). Use the plain `vX.Y.Z` tag, never `git describe` output.
2. Run `pnpm build`. Because `NEXT_PUBLIC_*` is inlined at build time, the rebuild is what actually propagates the new literal into the bundle. A restart without a rebuild keeps serving the old literal.

**Backend — stamp the `main.version` var, then run the binary (not `go run`).**

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

- **Add "re-stamp both versions" to the upgrade checklist.** Every upstream-tag upgrade must (a) bump `NEXT_PUBLIC_APP_VERSION` in `.env` to the clean tag and `pnpm build`, and (b) build the backend with `-ldflags "-X main.version=<clean-tag>"` and run that binary. The upgrade-upstream skill's hard-facts and the `project-version-stamp-on-upgrade` memory capture this operationally; this doc is the written-down reasoning for why those steps are non-optional.
- **Recognize the silent-failure signature.** "Help says Backend unavailable, but `/health` is 200 and the product works" means *forgotten re-stamp*, not *broken backend*. Before debugging the service, check `curl /api/config` for `server_version` and `git describe --tags`; if the former is absent and the latter has a `-N-g` suffix, the fix is a re-stamp, not an investigation.
- **Do not weaken the sanitizer to make this "easier".** Mapping `dev` to a visible value would turn every unstamped dev build into a misleading baseline; the silent-failure is load-bearing. The right lever is the build/run command (always stamp, never `go run` in prod), not the sanitizer.
- **There is no one-shot `make upgrade` target in this checkout.** Despite the provenance plan referencing one, the Makefile has no `upgrade` target (`make upgrade` → `No rule to make target`). `scripts/resolve-official-baseline.sh` is a bare helper that emits the clean tag to stdout; it is not wrapped by a Make target here. Re-stamping is the manual two-step above (or `BASELINE=$(scripts/resolve-official-baseline.sh)` + the `go build -ldflags` line).

## Related

- `docs/solutions/architecture-patterns/runtime-build-provenance.md` — full design doc for the provenance feature and the sanitizer's four resolution semantics (originating PR #5539, CLOSED 2026-07-16).
- `docs/solutions/workflow-issues/safe-upstream-upgrade-with-local-customizations.md` — the upgrade SOP whose Step 7/8 omit version re-stamping; this doc is the sibling that fills that gap (same "post-merge step the workflow forgot" family as `unapplied-migrations-after-upstream-upgrade` and `pnpm-install-after-upstream-merge`).
- `docs/solutions/test-failures/migration-lint-duplicate-prefix-whitelist-gap.md` — companion from the same v0.4.6 upgrade; shares the meta-pattern of a self-host gotcha staying hidden because `make test`/`make start` are Docker-gated and skipped on Homebrew-pg self-host.
- `docs/customizations.md` — ledger entry for the provenance customization (#5539), including this re-stamp gotcha.
- `scripts/resolve-official-baseline.sh` — supported helper that derives a clean official tag (or fails) so build paths never emit `dev`/hash/dirty.
