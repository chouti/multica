---
title: Runtime build provenance — surfacing the official release baseline in the Help menu
date: 2026-07-16
last_updated: 2026-07-28
category: architecture-patterns
module: multica
problem_type: architecture_pattern
component: development_workflow
severity: medium
applies_when:
  - "Self-hosted builds where operators must verify which release is running"
  - "Artifacts whose provenance depends on the host git checkout (multiple tags available, including local-only ones)"
  - "Multi-process products whose server and daemon must surface version agreement (the server and daemon are independently stamped and independently upgrade)"
  - "Air-gapped, shallow-clone, or forked checkouts where the resolver cannot reach the canonical remote"
tags: build-provenance, self-hosting, git-describe, help-menu, baseline-resolution, daemon-cli, drift-flag, multica
related_components:
  - scripts/resolve-official-baseline.sh
  - server/cmd/server/router.go
  - apps/web/components/web-providers.tsx
  - packages/core/config/index.ts
  - packages/views/layout/help-launcher.tsx
  - packages/core/runtimes/cli-version.ts
  - packages/core/runtimes/select-cli-version.ts
---

# Runtime build provenance — surfacing the official release baseline in the Help menu

## Context

Self-hosted Multica is deployed from a checkout, from a tarball, or from `docker-compose.selfhost.yml` pulling prebuilt images. In all three paths, the operator needs a trustworthy answer to one question: "what version is actually running right now?". Before this feature, the backend exposed `server_version` in `/api/config` as whatever `git describe` produced — `v0.4.2`, `v0.4.2-5-g-abc-1234`, `v0.4.2-dirty`, or `dev`. The frontend had no equivalent surface at all: it stamped `NEXT_PUBLIC_APP_VERSION` into the bundle but no UI rendered it. Three consequences followed:

- **Operator trust gap.** A self-hoster who pulled `v0.4.2-3-g<shortsha>` and one who pulled `v0.4.2` saw the same-looking `server_version` on a quick log skim (the `<shortsha>` is illustrative here too), with no in-product signal that one was a fork-only tag, a dirty checkout, or a real upstream release. The Help menu — the only universal "what am I on?" surface — was silent about it.
- **Frontend/backend drift.** Nothing forced the two artifacts to carry the same version. A rebuild could legitimately stamp `v0.4.2` in the Go binary while the web bundle still read `package.json` (a dev fallback) or an older `NEXT_PUBLIC_APP_VERSION`. There was no single source of truth, and no way to detect mismatch from inside the app.
- **Untrusted values reaching the UI.** Any string the build script happened to set reached the help text verbatim, including `dev`, hashes, and dirty markers — values that look authoritative but mean "this is not a release".

This pattern closes those gaps with one rule: a value is only shown in the Help sidebar if it is a clean `vX.Y.Z`-style tag that the resolver has confirmed is actually on the canonical upstream `https://github.com/multica-ai/multica`. Anything else renders as "unavailable".

The full design rationale, alternatives considered, and the four resolution semantics are summarized in PR #5539's description (the originating plan doc lives in the author's local-main fork for personal reference; it is intentionally not in this PR's diff). The implementation was opened in #5539; merge state at write time: **OPEN**, mergeable: MERGEABLE, not a draft (verified via `gh pr view 5539 --repo multica-ai/multica`).

## Guidance

The architecture has four layers, each enforcing the same rule in its own language:

### 1. Host-side resolver: `scripts/resolve-official-baseline.sh`

The single authority that picks the baseline. Authority order:

1. **Derive** the nearest reachable official tag with `git describe --tags --abbrev=0 --match 'v[0-9]*'`. The `--abbrev=0` is load-bearing — it guarantees no commit-distance or `-g<hash>` suffix even when the checkout has commits past the tag.
2. **Verify** the candidate exists among canonical upstream tags by running `git ls-remote --tags "$MULTICA_UPSTREAM_REMOTE"`. The upstream URL defaults to `https://github.com/multica-ai/multica` and is overridable for forks that track a different canonical remote.
3. **Fall back** to `MULTICA_TRUSTED_BASELINE` only when derivation is unavailable.
4. **Fail** (exit non-zero, never print `dev`/hash/dirty) when neither source produces a clean tag.

Output is exactly the baseline tag on stdout; diagnostics go to stderr. The script cannot run inside a Docker context — `.dockerignore` excludes `.git` — so it must run on the build host before image creation.

The shape that matters at the seam:

```bash
UPSTREAM_REMOTE="${MULTICA_UPSTREAM_REMOTE:-https://github.com/multica-ai/multica}"
TRUSTED_BASELINE="${MULTICA_TRUSTED_BASELINE:-}"

is_official_tag() {
  local tag="$1"
  tag="${tag#"${tag%%[![:space:]]*}"}"; tag="${tag%"${tag##*[![:space:]]}"}"
  [[ "$tag" =~ ^v[0-9] ]] || return 1
  [[ "$tag" =~ -[0-9]+-g[0-9a-f]{4,}$ ]] && return 1
  return 0
}

if candidate=$(git describe --tags --abbrev=0 --match 'v[0-9]*' 2>/dev/null) && [ -n "$candidate" ]; then
  candidate=$(printf '%s' "$candidate" | tr -d '\r' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
  if verify_upstream "$candidate"; then
    printf '%s\n' "$candidate"; exit 0
  fi
fi
if [ -n "$TRUSTED_BASELINE" ] && is_official_tag "$TRUSTED_BASELINE"; then
  printf '%s\n' "$TRUSTED_BASELINE"; exit 0
fi
fail "cannot establish official baseline"
```

The contract is locked by 10 tests in `scripts/resolve-official-baseline.test.sh` covering: exact checkout, post-tag commits, dirty working tree, fork-only tag, unreachable upstream, trusted override, invalid override, tagless checkout, and whitespace trimming around the override (so the trim symmetry across the shell / TS / Go layers is tested in the layer where it's easy to exercise — shell).

### 2. Embed the baseline at compile time

Both artifacts consume the same resolved string at build time, so a single Make target stamps both halves with one value:

**Backend** — Go `-ldflags` injection at `server/cmd/server/router.go:236` reads `main.version` (set by `-X main.version=<baseline>`) into `handler.Config.ServerVersion`, then into `/api/config`'s `server_version` field. The `officialBaseline` helper at `server/cmd/server/router.go:145` is the gatekeeper: it trims, rejects empty/`dev`, and rejects anything that fails `isOfficialBaselineTag` (must start `v[0-9]`, must not contain `-dirty` or `-\d+-g[0-9a-f]{4,}$`). An empty result is omitted from the JSON via `omitempty` so the frontend reads `""`, not a hash.

```go
// server/cmd/server/router.go:143-164
var describeSuffixRe = regexp.MustCompile(`-\d+-g[0-9a-f]{4,}$`)

func officialBaseline(v string) string {
    v = strings.TrimSpace(v)
    if v == "" || v == "dev" {
        return ""
    }
    if !isOfficialBaselineTag(v) {
        return ""
    }
    return v
}
```

**Frontend** — `NEXT_PUBLIC_APP_VERSION` is set to the same baseline before `pnpm build` runs, so `apps/web/components/web-providers.tsx:88` reads it at the platform boundary and runs it through `officialBaseline()` from `@multica/core/config` before handing it to `CoreProvider`. The TS-side `officialBaseline` helper at `packages/core/config/index.ts:13` mirrors the Go rule exactly — same `-N-g<hash>` regex, same `dev` rejection, same trim — so a value accepted at the shell layer passes the same way at the TS layer.

```ts
// packages/core/config/index.ts:5-19
const DESCRIBE_SUFFIX_RE = /-\d+-g[0-9a-f]{4,}$/;

export function officialBaseline(v?: string): string {
  const tag = (v ?? "").trim();
  if (!tag || tag === "dev") return "";
  if (!/^v\d/.test(tag)) return "";
  if (tag.includes("-dirty") || DESCRIBE_SUFFIX_RE.test(tag)) return "";
  return tag;
}
```

The Makefile wires both halves at `Makefile:395-411` (`upgrade` target): one resolver call, one `.env` rewrite (preserving `.env.bak`), one `go build` with `-X main.version=$$BASELINE`, one `pnpm build` with `NEXT_PUBLIC_APP_VERSION` set. Drift is structurally impossible because there is one source of truth for both halves in a single invocation.

### 3. Transport at runtime

`/api/config` exposes `server_version` (omitempty when empty). The frontend's `CoreProvider` reads `frontendBaseline` from `NEXT_PUBLIC_APP_VERSION` at mount and `backendBaseline` from the `/api/config` response. Both are stored under a `backendBaselineStatus: "loading" | "settled"` flag in `packages/core/config/index.ts:71-72` so the UI can distinguish "request still in flight" from "server returned empty / older build" rather than conflating them.

The platform boundary runs the raw env var through `officialBaseline()` before it reaches the store. The store also runs setters through the same helper as defense-in-depth — the boundary sanitization makes the contract visible at the seam; the store-level guard protects any future caller that bypasses the boundary.

### 4. Render the two rows

`packages/views/layout/help-launcher.tsx` is the rendering site. The two provenance rows are **always present in the DOM**, even when unavailable — a hidden row would make a stale or rolled-back artifact look identical to a missing one, defeating the whole feature.

The **Backend** row reads the server's `server_version` from the config store and renders one of three states (tag / loading / unavailable):

```tsx
const backendText =
  backendBaseline ||
  (backendBaselineStatus === "loading"
    ? t(($) => $.help.backend_loading)
    : t(($) => $.help.backend_unavailable));
```

The **CLI** row reads the most-recently-active daemon's `cli_version` from `/api/runtimes/` (via `selectRepresentativeCliVersion`), renders one of three states (tag / loading / unavailable), and applies `text-destructive` when the daemon is **older than the server**:

```tsx
let cliText;
if (noWorkspace) {
  cliText = t(($) => $.help.cli_unavailable);
} else if (!cliVersion) {
  cliText = runtimes === undefined
    ? t(($) => $.help.cli_loading)
    : t(($) => $.help.cli_unavailable);
} else {
  cliText = cliVersion;
}
const drift =
  Boolean(cliVersion) &&
  Boolean(backendBaseline) &&
  isDaemonOlderThanServer(cliVersion, backendBaseline);
```

The drift comparison uses **describe-aware** `parseSemver` / `lessThan` from `packages/core/runtimes/cli-version.ts` — not `officialBaseline`. Dev-built daemons carry `-N-g<hash>` describe suffixes that `officialBaseline` rejects; routing them through the baseline gate would misreport every dev daemon as unavailable. `parseSemver` parses the leading `vX.Y.Z` triple and ignores the tail, so a dev daemon compares correctly against the server's clean tag. Drift is **older-only** — a newer daemon is backward-compatible and not 502-risk, so the flag fires only in the dangerous direction. See `daemon-cli-version-drift-detection.md` for the full design rationale.

The locale keys live in `packages/views/locales/{en,zh-Hans,ja,ko}/layout.json` under `help.cli_label`, `help.cli_unavailable`, `help.cli_loading`, `help.backend_label`, `help.backend_unavailable`, `help.backend_loading`. The `help.frontend_label` / `help.frontend_unavailable` keys were removed when the frontend row was dropped — once the launchd path auto-stamps both halves from a single resolver-driven source, the two stamps are guaranteed identical by mechanism, so the frontend row became redundant noise.

## Why This Matters

- **Operator trust.** Without this pattern, a self-hoster reading "Backend `v0.4.2-dirty`" in the sidebar has no signal that this is not actually a release. With the pattern, anything that isn't upstream-verified reads "Backend unavailable", which is honest and actionable.
- **Debuggability.** A support engineer looking at a screenshot of the Help sidebar can tell at a glance whether the running frontend and backend agree, and whether each is on a real release. Mismatched rows (e.g. `Frontend v0.4.2` / `Backend unavailable`) immediately point at a deployment step that didn't stamp the value — typically a forgotten `make upgrade` on one half.
- **Supportability.** The override path (`MULTICA_TRUSTED_BASELINE=vX.Y.Z`) is the only sanctioned way to ship from a shallow clone, source tarball, fork, or offline host. Operators get one knob; support gets one diagnostic ("set the env var to the upstream tag you're tracking"). The four failure modes (shallow clone, source archive, fork, air-gapped) are enumerated in `SELF_HOSTING.md` so operators don't have to guess.
- **Single source of truth.** One resolver call, one string, both artifacts stamped with the same value in one Make target. A future change that introduces a third artifact (e.g. the CLI) just consumes `$$BASELINE` from the same Makefile target — no second resolver, no drift.
- **Defense in depth.** The same rule lives in three layers (shell, TS, Go). Each layer rejects `dev`, hashes, dirty markers, and `-N-g<hash>` suffixes independently. A bug in one layer doesn't poison the UI.

## When to Apply

Apply this pattern when:

- **Self-hosted artifacts** carry version info that must survive from build to runtime UI, especially when operators need to verify what they deployed.
- The version is **derivable from a git checkout at build time** (i.e. the canonical truth lives in git history, not in a registry or release database).
- The product has **multiple processes / artifacts** that must agree on a single version — frontend and backend, here, but the pattern generalizes to any bundle pair where drift between halves would silently mask a partial deploy.
- The build runs in **contexts where `git ls-remote` may fail** (offline hosts, shallow clones, source tarballs, forks tracking a different remote). The explicit-trusted-override path is part of the contract, not an edge case.
- The UI surface for the value must be **honest under all conditions**: when the value is missing, the UI must read "unavailable" rather than fall back to a hash, a `dev` literal, or a hidden row.

Do **not** apply when:

- The value is read live from a registry or release database at runtime (the resolver step is then redundant; transport-only is enough).
- Drift between halves is acceptable or detectable by another mechanism (e.g. shared release tag in a signed manifest).
- The build context is guaranteed to have the canonical remote reachable **and** no overrides are ever needed — in that case, the resolver can be a single `git describe` with no fallback. The pattern here explicitly includes the fallback because real self-host deployments hit all four failure modes.

## Examples

### Before — three problems at the seam

**Old `server_version`** (raw `git describe` value reaches JSON):

```
server_version: "v0.4.2-5-g-abc-1234"
```

This is on the wire regardless of whether the commit-suffix fragment corresponds to a real upstream tag (the `<shortsha>` in these examples is illustrative — operators should not read it as a real commit). Frontend dutifully renders it; operator can't tell a fork from an upstream release from a dirty checkout.

**Old frontend:** no `frontendBaseline` field, no UI rendering. The Help menu had no version row at all.

**Old Makefile:** `build-prod` target stamped the backend with `$(VERSION)` from `git describe --tags --match 'v[0-9]*' --always --dirty` and the frontend had no equivalent — drift was possible by construction.

### After — the resolver, the embed points, and the sidebar

**The resolver enforces one rule across all four failure modes** (`scripts/resolve-official-baseline.sh`):

```bash
$ cd /path/to/multica-checkout
$ bash scripts/resolve-official-baseline.sh
v0.4.2
$ cd /path/to/fork-only-checkout
$ bash scripts/resolve-official-baseline.sh
resolve-official-baseline: nearest tag 'v7.7.7-forkonly' is not present on upstream 'https://github.com/multica-ai/multica'
  Derivation unavailable. Set MULTICA_TRUSTED_BASELINE=vX.Y.Z to supply an explicit trusted baseline.
$ MULTICA_TRUSTED_BASELINE=v0.4.2 bash scripts/resolve-official-baseline.sh
v0.4.2
```

**Both halves consume the same baseline** (`Makefile:395-411`):

```makefile
upgrade: ## Rebuild backend + frontend prod bundle with the resolved official baseline
	@if [ -z "$(BASELINE_OVERRIDE)" ]; then \
		BASELINE=$$(bash scripts/resolve-official-baseline.sh) || exit 1; \
	else \
		BASELINE=$(BASELINE_OVERRIDE); \
	fi
	@echo "==> Official baseline: $$BASELINE"
	@sed -i.bak "s|^NEXT_PUBLIC_APP_VERSION=.*|NEXT_PUBLIC_APP_VERSION=$$BASELINE|" .env
	cd server && CGO_ENABLED=0 go build -ldflags "-s -w -X main.version=$$BASELINE" -o bin/server ./cmd/server
	cd apps/web && pnpm build
```

A single `make upgrade` (or `MULTICA_TRUSTED_BASELINE=v0.4.2 make upgrade` from an offline host) stamps the backend binary and the web prod bundle with the same value.

**The sidebar shows two honest rows** (`packages/views/layout/help-launcher.tsx`):

```
┌─────────────────────────────────────┐
│  Docs                       ↗      │
│  Changelog                  ↗      │
│  Discord                    ↗      │
│  Send feedback                     │
│ ────────────────────────────────── │
│  CLI       v0.4.12                 │
│  Backend   v0.4.12                 │
└─────────────────────────────────────┘
```

When the most-recently-active daemon is older than the server, the CLI row is flagged with `text-destructive`:

```
│  CLI       v0.4.11   ← red, drift  │
│  Backend   v0.4.12                 │
```

When no workspace is in scope (e.g. a logged-out page), the CLI row renders `unavailable`; when the runtimes cache is cold, it renders `loading`:

```
│  CLI       CLI loading...          │
│  Backend   Backend loading...      │
```

Or, when a daemon exists but none has reported a version:

```
│  CLI       CLI unavailable         │
│  Backend   v0.4.12                 │
```

Each state is honest, distinct, and actionable.

### Recovery patterns

`SELF_HOSTING.md` documents three build paths and one recovery path, all built on the same resolver:

- **Direct build from checkout** (`make selfhost-build`) — host resolver, then Docker build with both `VERSION` and `NEXT_PUBLIC_APP_VERSION` set.
- **Direct production build, no Docker** (`make build-prod`) — same resolver, builds `server/bin/server` and `apps/web/.next/...` directly. Fails fast if the baseline cannot be resolved.
- **Direct production upgrade, no Docker** (`make upgrade`) — same resolver, also rewrites `.env`'s `NEXT_PUBLIC_APP_VERSION` (with `.env.bak`) and rebuilds both halves. The operator then restarts their supervised processes (pm2, systemd, nohup); the target intentionally does not kill them because the supervisor varies per deployment. **Drift note (2026-07-22):** this checkout's Makefile does **not** define an `upgrade` target (`make upgrade` → `No rule to make target`); only `make build-prod` exists. The manual re-stamp fallback (bump `.env` `NEXT_PUBLIC_APP_VERSION` + `go build -ldflags "-X main.version=<tag>"` + `pnpm build`) is documented in `docs/solutions/workflow-issues/version-reporting-after-upstream-upgrade.md`.
- **Recovery when baseline can't be resolved** — `export MULTICA_TRUSTED_BASELINE=vX.Y.Z` before any of the above. Enumerated failure modes: shallow clone without tags, source archive without `.git`, fork whose `v*` tags aren't on the canonical upstream, offline / air-gapped host.

## What is NOT in scope

The pattern stops at "show the official release baseline in the Help menu". Future enhancements deliberately deferred — do **not** attempt to add them as part of this pattern:

- **Baseline mismatch alerts.** Surfacing a banner when `frontendBaseline !== backendBaseline` is a useful next step but is a separate UX concern; it would also need a policy decision about what counts as a tolerable mismatch (e.g. one patch version off for hotfix rollouts).
- **Support bundles.** A "download diagnostics" button that bundles the two baselines plus logs, server config, and recent errors is a natural extension but requires a separate API surface and a privacy review.
- **Image digests.** The Help sidebar shows the version tag, not the SHA256 of the running container image. Operators who need digests for SLSA-style supply-chain verification get them from `docker inspect`, not the in-product UI.
- **Deployment receipts.** A signed, append-only log of "this server was upgraded from v0.4.1 to v0.4.2 at $TIMESTAMP" is a separate persistence concern. The current pattern tells you what's running now, not how it got there.

Each of these would justify its own learning if implemented. They are listed here so a future agent reading this doc knows they are intentionally out of scope, not forgotten.

## Related

- Plan doc (design rationale, alternatives considered, four resolution semantics): the originating plan lives in the author's local-main fork for personal reference; it is intentionally not in this PR's diff. See PR #5539 description for the design summary.
- PR opened in #5539 (merge state at write time: **OPEN**, mergeable: MERGEABLE, not a draft — verified via `gh pr view 5539 --repo multica-ai/multica`).
- Resolver contract and test cases: `scripts/resolve-official-baseline.sh`, `scripts/resolve-official-baseline.test.sh` (10 cases covering exact / post-tag / dirty / fork-only / unreachable / trusted override / invalid override / tagless / whitespace trim).
- Backend embed point and helper: `server/cmd/server/router.go:134-164` (`officialBaseline` + `isOfficialBaselineTag`), `server/cmd/server/router.go:236` (`ServerVersion: officialBaseline(version)`).
- Frontend helper, store, and platform-boundary call site: `packages/core/config/index.ts:13-19` (`officialBaseline`), `apps/web/components/web-providers.tsx:88` (boundary sanitization before `CoreProvider`).
- Help menu rendering: `packages/views/layout/help-launcher.tsx:36-43` (text selection) and `packages/views/layout/help-launcher.tsx:104-113` (two-row rendering in the DropdownMenuGroup).
- Operator-facing docs: `SELF_HOSTING.md` — sections "Upgrading → Direct production upgrade (no Docker)", "Manual Docker Compose Setup → Source build from checkout", "Direct production build (no Docker)", and "Recovery when baseline can't be resolved".
- Build target: `Makefile:395-411` (`upgrade` target).
- Locale strings: `packages/views/locales/{en,zh-Hans,ja,ko}/layout.json` for `cli_label`, `cli_unavailable`, `cli_loading`, `backend_label`, `backend_unavailable`, `backend_loading`. The `help.frontend_label` / `help.frontend_unavailable` keys were removed when the frontend row was dropped (the two stamps were guaranteed identical by the resolver-driven single source, so the row became redundant noise).
