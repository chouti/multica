---
title: "rerere auto-resolution can be stale — re-verify any rerere-resolved conflict against upstream's current intent"
module: selfhost-upgrade
date: 2026-07-27
problem_type: workflow_issue
component: development_workflow
severity: medium
applies_when:
  - "Merging or rebasing an upstream release into a long-lived fork"
  - "git rerere is enabled and auto-resolves a merge conflict"
  - "The recorded rerere resolution predates upstream changes to the same file"
  - "Upstream has since removed features referenced by the conflicted content"
tags:
  - rerere
  - git-merge
  - upgrade
  - self-host
  - stale-resolution
  - docker-compose
  - conflict-resolution
  - upstream-sync
---

# rerere auto-resolution can be stale — re-verify against upstream's current intent

## Context

A long-running self-host fork of Multica tracks the upstream repository and periodically merges upstream release tags. The fork has `rerere` (reuse recorded resolution) enabled, so git remembers how past merge conflicts were resolved and replays those resolutions when it sees the same conflicted hunks again.

During the v0.4.9 → v0.4.11 upgrade (merge commit `185d446d8`, 2026-07-27 — self-host fork only, not on upstream `origin/main`), the merge produced exactly one conflicted file: `docker-compose.selfhost.build.yml`. Git rerere auto-resolved it without surfacing a conflict for review. But the recorded resolution it replayed had been captured during the **prior** v0.4.9 upgrade — and it was stale. It re-added two build args, `REMOTE_API_URL` and `NEXT_PUBLIC_WS_URL`, that upstream had since **removed** in commit `a90aa92d0` (which moved API/WS URL resolution from build-time to runtime). Verified against the new tag: `git show v0.4.11:Dockerfile.web` declares only one ARG, `NEXT_PUBLIC_APP_VERSION`, and sets `ENV REMOTE_API_URL=http://backend:8080` at runtime instead. `Dockerfile.web` no longer declares the two ARGs rerere re-added.

The rerere-applied text matched the conflict hunks cleanly, so nothing complained. The resolution was caught only because the merge operator re-verified the auto-applied content against upstream's current intent before finalizing. The manual re-resolution dropped the two dead args while keeping the fork's required `VERSION` / `NEXT_PUBLIC_APP_VERSION` `:?` guards (provenance feature — a raw `docker compose` build must fail rather than silently stamp a non-release image).

## Guidance

Treat any rerere auto-resolution as a **draft to re-verify, not a finished resolution**. Rerere proves only that a recorded resolution applies *textually* to the current conflict hunks; it says nothing about whether that resolution is still *semantically* correct against the code being merged in.

For every merge where rerere fires, run this verification before committing the merge:

1. **Identify what rerere resolved.** After the merge stages the auto-resolved file, diff it against the merge target to see exactly what content rerere chose:
   ```bash
   git diff <target-ref> -- <file>
   ```
   Anything this diff reintroduces that the target no longer has is a candidate stale line.
2. **Check upstream's current intent for the referenced feature.** If the resolution references config, build args, env vars, or symbols, confirm the thing they refer to still exists in the incoming ref:
   ```bash
   git show <tag>:<related-file>          # e.g. Dockerfile.web ARG list
   git log <base>..<target> -- <file>     # did upstream touch this file/feature?
   ```
3. **Reconcile.** Drop anything the recorded resolution re-added that upstream has since removed; keep fork-specific content the upstream side genuinely still needs. Edit the file, `git add` it, and complete the merge.

Do not assume "rerere resolved it" means "no review needed." The whole point of rerere is to save you from *re-deriving* a resolution — not from *re-checking* it. Review cost is a diff and one `git show`; skipping it is how dead config ships.

## Why This Matters

Git rerere records the *text* of how a conflict was resolved and replays that text verbatim on a future conflict with the same conflicted hunks. It has no model of the surrounding code and no knowledge that upstream later deleted the feature the old resolution referenced. So a rerere auto-resolution can be **semantically stale even when it applies textually cleanly**.

The failure mode is silent precisely *because* rerere "succeeds":

- The merge completes with no conflict markers and no error, so there is no prompt to look closer.
- The re-added lines are syntactically valid — a build arg `REMOTE_API_URL` is legal YAML whether or not anything consumes it.
- The dead config references a removed feature, so at best it is inert noise; at worst it misleads a future reader into thinking build-time URL wiring still exists, or re-anchors a removed code path the next time someone edits the file.

Crucially, this failure **escapes the typecheck safety net** that catches the sibling "auto-merge clean but semantically wrong" class: re-adding a removed build arg still compiles/builds, so `pnpm typecheck` / `pnpm build` stay green. It can only be caught by re-reading upstream intent, not by a build gate.

This is the conflict-resolution-layer analogue of "auto-merge clean ≠ semantically correct." A merge that applies without conflicts can still be wrong at the type/API-contract layer (see the sibling doc `docs/solutions/workflow-issues/manual-backport-merge-liability.md`); likewise, a conflict that rerere resolves without complaint can still be wrong at the semantic layer. "Rerere resolved ≠ semantically correct."

## When to Apply

Apply this whenever **all** of the following hold:

- You are merging or rebasing on a **long-running fork** (or any branch that repeatedly merges the same upstream), where the same files conflict across successive merges.
- **`rerere` is enabled**, so resolutions from earlier merges are being replayed automatically.
- The recorded resolution being replayed might **predate upstream changes to the same file or to the feature it references** — i.e. upstream has moved on since the resolution was first captured.

The more releases a fork has merged, the older some recorded resolutions get, and the more likely a replayed resolution references something upstream has since removed or reshaped. Any conflict that "resolved itself" deserves a verification pass; a conflict that required genuine human judgment the first time deserves an extra-careful one.

## Examples

Concrete case: the v0.4.9 → v0.4.11 merge, `docker-compose.selfhost.build.yml`.

What rerere re-added (stale — from the v0.4.9-era recorded resolution), under the web service's `build.args`:

```yaml
      args:
        REMOTE_API_URL: http://backend:8080                 # upstream removed build-time URL wiring
        NEXT_PUBLIC_WS_URL: ${NEXT_PUBLIC_WS_URL:-}          # upstream removed build-time URL wiring
        NEXT_PUBLIC_APP_VERSION: ${NEXT_PUBLIC_APP_VERSION:?NEXT_PUBLIC_APP_VERSION is required; ...}
```

Upstream commit `a90aa92d0` (PR `#4840`) moved API/WS URL resolution from build-time to runtime: `git show v0.4.11:Dockerfile.web` declares only `ARG NEXT_PUBLIC_APP_VERSION` and instead sets `ENV REMOTE_API_URL=http://backend:8080` at runtime. The two re-added args no longer correspond to any declared `ARG`, so they are dead config.

Corrected resolution (drop the dead args, keep the fork's provenance guards):

```yaml
      args:
        NEXT_PUBLIC_APP_VERSION: ${NEXT_PUBLIC_APP_VERSION:?NEXT_PUBLIC_APP_VERSION is required; run make selfhost-build or set NEXT_PUBLIC_APP_VERSION / MULTICA_TRUSTED_BASELINE}
```

(The backend `VERSION` arg higher in the file carries the same `:?VERSION is required; ...` guard — the re-resolution kept both version guards and dropped only the two dead URL args.)

The `:?` guards are a fork-specific feature (provenance) that must survive: they make a raw `docker compose` build fail rather than silently stamp a non-release image. They are unrelated to the removed URL wiring, so they stay.

How the stale resolution was inspected and corrected:

```bash
# 1. See what rerere staged vs the incoming tag — the two REMOTE_API_URL /
#    NEXT_PUBLIC_WS_URL lines show up as re-added relative to v0.4.11.
git diff v0.4.11 -- docker-compose.selfhost.build.yml

# 2. Confirm upstream's current intent — does Dockerfile.web still take those ARGs?
git show v0.4.11:Dockerfile.web | grep -i arg     # only NEXT_PUBLIC_APP_VERSION

# 3. Confirm upstream touched this area between the releases.
git log v0.4.9..v0.4.11 -- docker-compose.selfhost.build.yml Dockerfile.web

# 4. Edit the file to drop the dead args, keep the :? guards, then:
git add docker-compose.selfhost.build.yml
git commit    # complete the merge
```

The telling signal in step 1 was that rerere's "resolution" introduced lines relative to the incoming tag. A correct resolution to "upstream deleted these, fork keeps its own guards" should converge toward the upstream side, not re-add lines upstream dropped. When a rerere diff moves *away* from the merge target on lines that are not fork-specific customizations, suspect staleness.

## Related

- `docs/solutions/workflow-issues/manual-backport-merge-liability.md` — closest sibling: the same "tool says clean, semantics say wrong" meta-lesson at the type-contract/auto-merge layer (a hand-backport diverges from the official fix; git auto-merges clean, typecheck catches it). This doc is the conflict-resolution/rerere layer.
- `docs/solutions/workflow-issues/run-typecheck-after-upstream-merge.md` — complementary detection layer: typecheck catches semantic merge errors that green auto-merge/vitest miss. The rerere case escapes even typecheck (dead build args still compile), so it needs intent re-reading, not just a build gate.
- `docs/solutions/workflow-issues/safe-upstream-upgrade-with-local-customizations.md` — the 10-step upgrade SOP; this doc is a Step 4 (conflict resolution) hazard where a rerere auto-resolution silently bypasses the per-file strategy.
- `docs/solutions/workflow-issues/version-reporting-after-upstream-upgrade.md` — same self-host upgrade-session cluster and shared provenance context.
- `docs/upgrades/v0.4.11-plan.md` — the upgrade process artifact where this incident occurred and was re-resolved.
