---
title: "Type-scale refactors leave fork-only islands invisible to merge-tree and typecheck — only the guard test catches them"
date: 2026-07-31
category: workflow-issues
module: git
problem_type: workflow_issue
component: development_workflow
severity: medium
applies_when:
  - "Merging an upstream design-system refactor (token renames, naming-convention sweeps) into a self-host fork"
  - "Audit claims a refactor is purely mechanical without running the executable guard test for the new invariant"
  - "Fork carries files in the refactor's scan scope that upstream does not touch in the same diff"
  - "Auto-merge, typecheck, and go build all pass but a source-text grep test fails"
tags:
  - upgrade
  - audit
  - merge
  - type-scale
  - design-system
  - fork-only
  - guard-test
  - self-host
---

# Type-scale refactors leave fork-only islands invisible to merge-tree and typecheck

## Context

During the v0.4.14 → v0.4.15 upgrade (local merge commit `6f21b01a0`; not reachable on origin/main because the self-host fork does not fast-forward upstream), the audit recorded a negative claim that upstream MUL-5451 (PR #6136, the role-named type scale refactor) was "purely mechanical with no behaviour change" against `packages/views/issues/**`. The claim was verified by extracting text tokens, normalizing them, and showing the residual multiset was empty — the refactor really is mechanical for files both sides touch.

The refactor renamed every ad-hoc font size to a closed set of role-named tokens defined in `packages/ui/styles/tokens.css`:

```
tokens.css:88-116  --text-micro / --text-caption / --text-label /
                   --text-body / --text-body-lg / --text-title-sm /
                   --text-title / --text-title-lg / --text-display-sm /
                   --text-display
                   each paired with a --line-height counterpart
```

PR #6136 swept 241 files across `packages/views` and 51 files in `packages/ui` (`git show --stat 7803a5b9e` → `324 files changed, 2614 insertions(+), 2246 deletions(-)`). For files both upstream and the fork modified, the rename landed on the same new tokens on both sides, so `git merge v0.4.15` auto-merged them clean — the textual diff was identical after token substitution.

The fork, however, also ships fork-only files inside the same scan scope:

- `packages/ui/components/common/actor-mention-chip.tsx`
- `packages/ui/components/common/skill-mention-chip.tsx`
- `packages/views/admin/user-management-page.tsx`
- `packages/views/editor/skill-agent-picker.tsx`
- `packages/views/editor/skill-profile-card.tsx`

These five files still carried the old `text-sm`, `text-xs`, `text-[11px]`, `text-xl` class names. (`packages/views/editor/extensions/mention-suggestion.tsx` is upstream-owned but is included here because PR #6136 left residual `text-xs` lines behind; it shows up in the same scan but is auto-merge-handled, not fork-only.) None of the following caught the drift:

- **`git merge-tree`** reports no conflict because upstream never touched the files.
- **`pnpm typecheck`** passes because TypeScript does not care about class-name strings.
- **`git diff <base>..v0.4.15`** against these files shows zero changes — they are byte-identical to their pre-merge state.

Only `apps/web/app/type-scale.test.ts` — a source-text grep guard that walks `packages/ui`, `packages/views`, `apps/web`, `apps/desktop/src` (line 45: `const scanRoots = ["packages/ui", "packages/views", "apps/web", "apps/desktop/src"]`) and reports banned patterns (`text-[Npx]`, `text-[Nrem]`, and Tailwind defaults `text-xs`/`text-sm`/`text-base`/`text-lg`/`text-xl`/`text-2xl`/`text-3xl`, lines 65–82) — flagged the violations after the merge. First `pnpm test` run caught 13 files / ~30 off-scale call sites across `issues-page`, `issues-header`, `members-tab`, `import-panel`, `frontmatter-card`, `issue-identifier-badge`, `skill-profile-card`, `skill-agent-picker`, plus the fork-only files listed above. None would have shipped without that test.

The session-history probe surfaced the same pattern recurring at three different layers in the 7-day window before this merge:

1. **Go API signature refactor** (v0.4.13 → v0.4.14 merge, admin.go:177): upstream converted `userToResponse` from a free function to `h.userToResponse` method. `git merge` resolved cleanly because the call-site text only changed locally, but `go build` caught `undefined: userToResponse` because fork's #4118 super-admin rename still called the free function.
2. **TSX font-size tokens on a PR rebase** (2026-07-29, PR #6106 rebase onto latest `origin/main`): four content conflicts all caused by `d68d636c9 feat(ui): establish a role-named type scale and migrate ad-hoc font sizes` (an early form of MUL-5451). Local typecheck + tests both green; upstream CI failed on `issues-header.tsx:1385` — a file the PR touched but whose `text-xs` line escaped human review.
3. **TSX font-size tokens in fork-only files** (v0.4.15 self-host merge, this learning): same root cause, surfaced locally instead of in CI.

The shared root cause is structural: **text-level three-way merge cannot enforce semantic invariants across refactors that change category-of-thing (free function → method, font size literal → role-named token) without changing the local hunk text**. Each layer needs its own invariant guard — `go build` for Go, source-text grep tests for design tokens.

## Guidance

When auditing any upstream refactor that introduces or tightens a design-system invariant, treat the executable guard test as the authoritative verifier, not the textual diff. The recipe:

1. **Identify the invariant being introduced.** Here: a closed set of role-named font-scale tokens (`text-micro`, `text-caption`, `text-label`, `text-body`, ..., `text-display`) defined in `packages/ui/styles/tokens.css:88-116`.
2. **Find its guard.** Here: `apps/web/app/type-scale.test.ts` — a source-text grep test, not a behavioural component test (the file's own header comment, lines 13–18, explains why: "a component test would prove a class name renders, never that the class was one of the ten the design system actually defines").
3. **List fork-only files in scan scope.** Compute `comm -23 <(fork files in scope) <(upstream files in scope)` over the guard's `scanRoots`. In v0.4.15 this produced five files that upstream never touched (plus upstream-touched files like `mention-suggestion.tsx` where PR #6136 left residual off-scale tokens — these are auto-merge-handled but still violate the invariant).
4. **Run the guard test against HEAD before the merge.** If it fails on fork-only files, the refactor is NOT pure-mechanical for the fork even though it is for the overlap. Add "fork-only-file token migration" to the per-file strategy as a non-conflict cleanup phase, with concrete file-by-file substitutions.
5. **If the audit was wrong, treat it as a meta-lesson.** Any future audit claim of the form "X is purely mechanical" must be paired with an executable guard check, not just a textual diff inspection. The `negative_claims` table at the bottom of `docs/upgrades/<tag>-plan.md` is the right place to record both the claim and the command that verifies it (`verified_by:`), and that command must be one that ENFORCES the invariant.

## Why This Matters

The merge-tree view of the world reports "Auto-merging … clean" for files neither side conflicts on, and the human auditor's instinct is to trust the textual diff. Both views are blind to design-system drift inside files the upstream diff never visited. A self-host fork deliberately carries such files — they are the whole point of the fork — so the failure mode is structurally inevitable, not a one-off mistake.

The consequence of shipping the drift silently is that the type-scale invariant erodes over multiple upgrades. Each new fork PR adds a file in scan scope with old token names, the guard test starts failing, and eventually the test is weakened (loosened patterns, new exemptions) to "make CI green". The guard only holds if every violation is migrated, not exempted. Letting violations land in `main` even once sets the precedent for the next round.

This case is also a useful counter-example to "if typecheck passes, the merge is safe". TypeScript does not model Tailwind class names, and neither does the bundle — an off-scale class compiles into valid CSS that renders identically to an on-scale one. The behavioural test harness would never see the difference. Only a source-text guard enforces the invariant, because the invariant is authorial, not behavioural.

The pattern generalizes: any time upstream renames a category of thing (function → method, font literal → role token, import path → scoped path, free-form string → enum value) the merge machinery sees a textual hunk change while the underlying invariant changes silently. The rule is the same — find the guard that ENFORCES the invariant and run it before declaring verification complete.

## When to Apply

- Any upstream refactor introducing a closed set of design tokens (font scale, color ramp, spacing scale, radius scale, shadow scale) that an in-repo source-text test enforces.
- Any audit claim of the form "purely mechanical", "rename only", "no behaviour change", "safe auto-merge" inside a fork's overlap area.
- Any fork whose `scanRoots`-equivalent set contains files the upstream diff does not visit — i.e. almost every self-host fork, by construction.
- Whenever the audit step produces a `negative_claims` table — every claim there should be verified by a command that ENFORCES the invariant, not one that only inspects it.
- Any Go / TS / Rust merge where a function-signature or API-shape refactor lands (analogue: `go build` for Go, source-text grep tests for design tokens).

## Examples

**Before the merge (wrong audit reasoning):**

> "MUL-5451 对 packages/views/issues/** 是纯机械无行为变更。"
> verified_by: "把 text-(<px>|[scale-role]) 归一为 text-SCALE 后 multiset 对比，残差 0"

This verified the refactor's purity for fork-overlap files only. It missed the five fork-only files entirely, none of which are under `packages/views/issues/**`. The textual diff was empty for those files, so the claim "passed" by omission. Recorded as `result: confirmed` in `docs/upgrades/v0.4.15-plan.md` `negative_claims`, but the test suite disagreed.

**After the merge (correct workflow):**

```bash
# 1. Run the guard BEFORE resolving conflicts; capture baseline violations.
pnpm --filter web test -- type-scale

# 2. List fork-only files in scan scope (files the upstream diff didn't touch).
comm -23 \
  <(git ls-files packages/ui packages/views apps/web apps/desktop/src | sort) \
  <(git diff --name-only v0.4.14..v0.4.15 | sort)

# 3. For each fork-only file with violations, run the substitution script.
#    Caveat: BSD sed (macOS) does NOT support \b word boundaries; first batch
#    of substitutions failed silently. Use [[:>:]] or space/" delimiters.

# 4. Re-run the guard until it returns zero violations.
pnpm --filter web test -- type-scale
```

The v0.4.15 merge required ~30 substitutions across 13 files to clear the guard. The substitutions followed a small table:

| Banned pattern | Role token | Notes |
| --- | --- | --- |
| `text-xs` | `text-caption` | 12px / 16px line-height |
| `text-sm` | `text-body` | 14px / 20px line-height |
| `text-[11px]` | `text-micro` | 11px / 15px line-height |
| `text-[10px]` | `text-micro` | collapse to the 11px step |
| `text-xl` | `text-title-lg` | 20px / 28px line-height |

`text-[11px]` is the most common offender because it predates the role scale and was used wherever 11px mattered (chips, badges, dense table cells). `text-base` and `text-lg` were rare in this codebase but would map to `text-title-sm` and `text-body-lg` respectively per the test's hint strings (lines 81, 70).

**After the upgrade (meta-lesson recorded):**

`docs/upgrades/v0.4.15-plan.md` Phase 7 "Actuals vs Plan" section was updated to call out the new variable explicitly:

> "新变量：MUL-5451 type-scale fork-only 文件 ... 字号 migration 是 merge-tree 看不见、typecheck 看不见、只有 `type-scale.test.ts` 守卫测试能抓。"

And the existing `negative_claims` entry for MUL-5451 was annotated with the lesson: a verified claim is only as good as the command that verified it, and the verifier for an invariant must be the test that enforces the invariant.

## Related

- `docs/upgrades/v0.4.15-plan.md` (search "MUL-5451" and "fork-only" for the recorded claim and its correction)
- `apps/web/app/type-scale.test.ts` (the guard; `scanRoots` line 45, banned patterns lines 65–82)
- `packages/ui/styles/tokens.css:88-110` (the role-named scale definitions the guard enforces)
- PR #6136 (the upstream MUL-5451 commit; commit SHAs can be rewritten, PR numbers don't)
- `docs/solutions/workflow-issues/clean-state-rerun-protocol.md` (sibling learning: rerere absorption can mask staleness — same theme of "merge clean ≠ merge correct")
- `docs/solutions/workflow-issues/run-typecheck-after-upstream-merge.md` (sibling: tsc-side analogue; this learning extends it to design-system guards)
- `docs/solutions/workflow-issues/safe-upstream-upgrade-with-local-customizations.md` (canonical upgrade-workflow doc; this lesson plugs into its post-merge audit step as an additional gate for design-system refactors)
- `docs/customizations.md` (the customization ledger — keep it open for new fork-only-file categories)