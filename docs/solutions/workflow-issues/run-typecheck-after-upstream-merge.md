---
title: "Run tsc typecheck after every upstream merge — auto-merge silently breaks even files with no local changes"
date: 2026-07-23
last_updated: 2026-08-17
category: workflow-issues
module: upgrade-workflow
problem_type: best_practice
component: development_workflow
severity: medium
applies_when:
  - "Merging an upstream release into a fork and deciding which verification gates to run"
  - "Tempted to assume files without merge-conflict markers were merged correctly"
  - "Choosing between vitest (esbuild, no type-checking) and tsc --noEmit for post-merge verification"
tags: [merge, typecheck, auto-merge, upstream-upgrade, vitest, verification-gate]
---

# Run tsc typecheck after every upstream merge

## Context
After a `git merge`, files that auto-merged (no conflict markers) are often assumed correct. But git's three-way auto-merge works on text hunks, not semantics — it can silently break a file even when **the local fork never touched it**. A green test suite does not prove the merge is type-correct, because vitest transpiles via esbuild (no type-checking) by default.

## Guidance
- After every upstream merge, run `pnpm typecheck` (`tsc --noEmit`), not just `pnpm test`. Make it a non-skippable gate.
- Do not assume a file merged cleanly just because it has no conflict markers. Auto-merge "succeeds" on text but can drop a declaration or mismatch a component prop.
- Remember vitest ≠ typecheck: `pnpm test` (vitest, esbuild) can be green while `tsc` is red. Upstream's CI often runs vitest, so a release tag can ship a type-broken test that upstream never noticed.

## Why This Matters
On the v0.4.8 upgrade, `packages/views/issues/components/table-view-editing.test.tsx` was silently broken by the three-way merge: `serverIssues` was *assigned* but its declaration was lost, and two `<Harness>` calls no longer passed the now-required `issues` prop. No conflict markers. `pnpm test` was green (vitest/esbuild). Only `pnpm typecheck` flagged it:

```
table-view-editing.test.tsx(303,5): error TS2304: Cannot find name 'serverIssues'.
table-view-editing.test.tsx(307,10): error TS2741: Property 'issues' is missing ... but required ...
```

Mechanism: both `base→local` and `base→upstream` touched nearby hunks; git merged by text and dropped one declaration. "Merged cleanly" ≠ "semantically correct."

The counter-intuitive part: this file had **no local customization at all** (`git log $(git merge-base HEAD v0.4.8)..HEAD -- <file>` was empty) — a pure upstream path. It was still broken by the three-way merge. So "I never touched this file" is not a reason to skip verification on it.

Bonus twist: this was actually an **upstream release regression** — `#5767` introduced the broken test, v0.4.8 tagged it, `#5778` fixed it on main ~24 minutes *after* the tag. Upstream CI ran vitest (esbuild), so the break shipped unnoticed. Our `tsc` gate is stricter than upstream's release CI. Filed as upstream issue #5816.

## When to Apply
Every upstream merge, regardless of how few conflicts there were. Especially when upstream refactored a test's harness component or changed a prop signature across the merge window.

## Examples
v0.4.8 upgrade: fixed the two test cases by replicating main's #5778 fix (merged after v0.4.8, so absent from this checkout) — removed the dangling `serverIssues`, inlined `issues={[makeIssue(...)]}` on the `<Harness>` — without pulling in #5778's unrelated toolbar changes. Full record in `docs/upgrades/v0.4.8-plan.md` Phase 5.

## Related

- `docs/solutions/workflow-issues/auto-merge-semantic-collisions-same-symbol-and-fork-test-signature.md` — the sibling collision-classes doc (2026-08-14): its Class 1 (same-symbol-different-region duplicate) is caught by the same `pnpm typecheck` gate this doc prescribes, as the "duplicate" counterpart to this doc's "dropped declaration" case; also embedded as gate #2 of the upgrade skill's Phase 5.
- `docs/solutions/workflow-issues/safe-upstream-upgrade-with-local-customizations.md` — the upgrade SOP whose Step 7 runs this typecheck gate
- `docs/solutions/test-failures/migration-lint-duplicate-prefix-whitelist-gap.md` — same shape: a verification gate catching a bug that quietly slipped through
- `docs/upgrades/v0.4.8-plan.md` — Phase 5 records this exact fallout
