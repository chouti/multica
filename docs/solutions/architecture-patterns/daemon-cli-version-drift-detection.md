---
title: "Daemon CLI version drift detection in the Help menu"
date: 2026-07-28
category: architecture-patterns
module: multica
problem_type: architecture_pattern
component: development_workflow
severity: medium
applies_when:
  - "A multi-process product (frontend/backend/CLI each stamped independently) needs to surface version drift in its Help menu or diagnostics panel"
  - "Extending an existing officialBaseline provenance row to a runtime/daemon dimension that upgrades on an independent cadence"
  - "A daemon whose version mismatch with the server is a known failure cause (502, protocol mismatch) and must be visible at a glance"
tags: [help-menu, provenance, daemon-cli, version-drift, older-than-server, multica]
---

# Daemon CLI version drift detection in the Help menu

## Context

`runtime-build-provenance.md` established a Help-menu provenance system: two
rows (frontend + backend) showing the official release baseline, sanitized by
`officialBaseline` so only clean `vX.Y.Z` tags render. Two things made the
frontend row stop earning its slot:

1. Once frontend/backend version stamping was consolidated onto the git
   release tag as a single source (`resolve-official-baseline.sh` driving
   both halves), the two rows became **guaranteed identical by mechanism**
   rather than by build discipline — the frontend row turned redundant.
2. The daemon (an independently upgraded Homebrew CLI) talks to the server
   over a protocol whose version mismatch is a known 502 cause, yet the Help
   menu — the one universal "what am I on?" surface — did not show it.

The provenance system's own design doc listed "baseline mismatch alerts" as
a deliberately deferred future enhancement. This pattern is the scoped
instantiation of that enhancement, redirected from frontend/backend (now
immune to drift) to daemon/server (genuinely independent upgrade paths).

## Guidance

Replace the Help menu's frontend-version row with a **daemon-CLI row** that
shows the most-recently-active daemon's version, flagged red only when that
daemon is older than the server. Four design points, each load-bearing:

1. **Daemon version source.** The daemon reports its CLI version at register
   time; the backend stores it as `cli_version` in each runtime row's
   metadata and exposes it via `GET /api/runtimes/`. It is a **set** of
   values (one per connected daemon/machine), not a single global value. Use
   a cross-list selector (`selectRepresentativeCliVersion` in
   `packages/core/runtimes/select-cli-version.ts`) that prefers online rows,
   orders by `last_seen_at`/`updated_at`, and falls through to the next
   daemon when the top-ranked row carries no `cli_version`.

2. **Describe-aware comparison, not `officialBaseline`.** The drift
   comparison must use the describe-aware `parseSemver`/`lessThan` from
   `packages/core/runtimes/cli-version.ts`, **not** `officialBaseline`.
   `officialBaseline` rejects any string carrying a `-N-g<hash>` describe
   suffix (it is the release-baseline gatekeeper); a dev-built daemon
   reports exactly that shape (`v0.4.11-5-gabc1234`), so routing it through
   `officialBaseline` would read the daemon as unavailable and never flag
   drift. `parseSemver` parses the leading `vX.Y.Z` triple and ignores the
   tail, so a dev daemon compares correctly against the server's clean tag.

3. **Older-only drift flag.** Flag red only when the representative daemon
   is **strictly older** than the server. A newer daemon is backward-
   compatible and not 502-risk, so it must not flag. This avoids a false
   red every time the server upgrades before the operator runs
   `brew upgrade multica` — the brief catch-up window stays green, and the
   flag fires only for the genuinely dangerous direction (daemon lagging).

4. **Stale-cache runtimes read.** Subscribe to runtimes via
   `useQuery(runtimeListOptions(wsId))` with `enabled: false`. The sidebar
   indicator, the Runtimes page, and presence previews already warm this
   cache; the Help menu reads the shared cache and triggers no fetch on
   open. This keeps the Help-open path off the network and the loading
   window negligible in practice.

The row itself mirrors the existing backend row's three states
(tag / loading / unavailable) so a cold runtimes cache shows `cli_loading`
rather than misreporting an actually-connected daemon as absent.

## Why This Matters

- **The frontend row was dead weight after consolidation.** Once git tag is
  the single source, frontend and backend stamps agree by construction;
  showing both is noise. Replacing one with the daemon version turns the
  slot from decoration into diagnosis.
- **Daemon/server drift is the real, independent failure surface.** The
  daemon upgrades through Homebrew on the operator's cadence; the server
  upgrades through `install.sh` on a different cadence. They drift in
  normal operation, and that drift is the 502 root cause this product
  documents elsewhere.
- **Older-only is the difference between a useful signal and an annoying
  one.** A "any mismatch" flag would cry wolf every server upgrade;
  older-only fires for the direction that actually breaks things.
- **Describe-aware comparison is what makes dev daemons work.** Without it,
  every developer running a source-built CLI would see "CLI unavailable"
  instead of a comparable version — and the flag would never engage for the
  audience most likely to need it during development.

## When to Apply

- A product with multiple independently-versioned processes (server + CLI +
  desktop + mobile) where the Help menu or a diagnostics panel should
  surface version agreement.
- Extending an existing `officialBaseline`-style provenance row to a
  dimension that upgrades on its own cadence and whose mismatch has
  observable consequences.
- Anywhere a "version drift" indicator must distinguish the dangerous
  direction (lagging) from the benign one (leading).

## Examples

The shipped implementation (feature branch `feat/cli-version-help-menu`,
merged to local main on this self-host fork — no upstream PR, so the
commits are stable local history rather than rebased/squashed PR SHAs):

- **Selector + comparator** (`packages/core/runtimes/`):
  `selectRepresentativeCliVersion(runtimes)` picks the representative;
  `isDaemonOlderThanServer(daemon, server)` does the describe-aware
  older-than comparison, returning `false` when either side is unparseable
  (fail-closed: no false drift flag on unknown versions).
- **Help row** (`packages/views/layout/help-launcher.tsx`): subscribes to
  runtimes with `enabled: false`, derives `cliVersion` and `drift` inline
  (no config-store field — server data stays in React Query per the repo's
  state rules), renders a three-state row with `text-destructive` when
  drift is true.
- **Loading vs unavailable distinction**: the row branches on
  `wsId === undefined` (no workspace → unavailable, never loading) before
  the `runtimes === undefined` (cold cache → loading) check, so a
  no-workspace mount does not stick on `cli_loading` forever.

Locale keys (`help.cli_label`, `help.cli_unavailable`, `help.cli_loading`)
mirror the backend row's three states across all four locales
(en/zh-Hans/ja/ko). The now-dead `help.frontend_label` / `frontend_unavailable`
keys were removed from all four locales when the frontend row was dropped.

## Related

- `docs/solutions/architecture-patterns/runtime-build-provenance.md` — the
  foundation: `officialBaseline` three-layer sanitizer, the resolver, and
  the original two-row Help-menu provenance design. This pattern extends
  that system with the daemon dimension + drift detection.
- `docs/solutions/workflow-issues/version-reporting-after-upstream-upgrade.md`
  — the version re-stamp workflow; updated to reflect that
  `install.sh` now stamps both halves from the git tag automatically.
- Plan artifact: `docs/plans/2026-07-28-001-feat-cli-version-help-menu-plan.md`
  — the implementation-ready unified plan (R1-R6, AE1-AE6, 4 KTDs) this
  pattern shipped from.
