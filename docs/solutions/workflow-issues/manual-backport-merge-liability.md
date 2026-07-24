---
title: "Manual backport of an upstream fix becomes a merge liability when the official fix lands"
date: 2026-07-24
category: workflow-issues
module: upgrade-workflow
problem_type: workflow_issue
component: development_workflow
severity: medium
applies_when:
  - "A fork manually backported an upstream fix to unblock a local build (e.g. a fix the release tag omitted)"
  - "Merging a newer upstream release that may now officially include that same fix"
  - "typecheck fails after an auto-merge that reported zero conflicts, pointing at a file the fork once hand-patched"
tags: [upstream-merge, backport, technical-debt, typecheck, auto-merge, upgrade]
---

# Manual backport of an upstream fix becomes a merge liability when the official fix lands

## Context

When a fork tracks upstream and an upstream **release tag ships broken** (a fix
landed on `main` after the tag cut, or the tag simply omitted it), the tempting
local move is to **manually backport just enough of the fix** to unblock the
local build — usually only the test/caller side, not the full upstream change.

That backport is silent technical debt. It passes today, but the next upstream
release almost always **officially includes the real fix** — and the real fix
frequently changes a component signature, a prop name, or a function shape that
the hand-backport assumed was stable. The two then disagree, and because the
disagreement is at the **type/API contract level** (not the text level),
`git merge` auto-merges it cleanly and reports **zero conflicts** — the breakage
surfaces only at typecheck.

## Guidance

Treat every manual backport as a **pending reconciliation** with a known upstream
origin, and close it on the very next upgrade:

1. **Record the backport with its upstream origin.** When you hand-patch to
   unblock a build, note in the ledger (e.g. `docs/customizations.md`) *which
   upstream commit/PR the patch imitates* and *why you didn't take the whole
   thing*. The v0.4.8 upgrade recorded exactly this: "手改两 case 复刻 main 修法
   (dd45f3055), 未带入 MUL-5164 的 toolbar 改动" (`docs/upgrades/v0.4.8-plan.md`).
2. **At the next upgrade, check whether upstream has officially landed it.** Before
   resolving, confirm the origin commit is now in the range being merged
   (`git log --oneline <base>..<target> | grep <origin-sha>`). If it is, the
   hand-backport is now **redundant** and almost certainly **wrong** (it imitated
   an older shape).
3. **Prefer the upstream official version; drop the hand-backport.** When the
   origin commit is in the merge, take upstream's file for the touched region
   (`git checkout <target> -- <file>`) rather than trying to merge the two
   hand-backport + official versions. The official version is the superset;
   reconciling by hand just recreates the drift.

## Why This Matters

The hand-backport and the official fix diverge along **different layers**. The
backport copies the *minimum to compile* (typically the test's call site). The
official fix changes the *thing being called* (component props, function
signature, type). `git merge` only sees text hunks; if the two edits land on
different lines it auto-merges and declares success — but the merged test now
calls an API the merged component no longer accepts. **Auto-merge clean ≠
semantically correct.** This is exactly the class of error that only a
post-merge typecheck catches, which is why typecheck must run **before** the
merge commit and **before** any irreversible step (DB migrate, service restart).

The cost of getting this wrong is low (typecheck catches it, fix is one
`git checkout`) — but only if you *expect* it. The failure mode when you don't
expect it is time lost diagnosing "why does typecheck fail on a zero-conflict
merge of a file I barely touched."

## When to Apply

- Any fork-local edit whose commit message or ledger note says it imitates /
  backports / ports an upstream fix that wasn't in the release tag you merged.
- Any post-merge typecheck failure on a file the fork previously hand-patched,
  especially a failure of the shape *"Property X does not exist on type Y"*
  (a prop/symbol the upstream fix removed but the local backport still passes).
- During upgrade audit: grep the ledger/plan files for "backport", "复刻",
  "手修", "port of" and verify each origin has either landed upstream (→ drop
  local) or is still pending (→ carry).

## Examples

**v0.4.8 → v0.4.9, `packages/views/issues/components/table-view-editing.test.tsx`:**

- v0.4.8 release tag omitted `dd45f3055` (MUL-5164), so the tag's own typecheck
  was red. The fork hand-patched the test to compile: changed two cases from
  `serverIssues = [makeIssue(...)]` to `<Harness issues={[makeIssue(...)]} />`
  — a minimal, test-side-only imitation of the fix. Recorded as a backport in
  `docs/upgrades/v0.4.8-plan.md`.
- v0.4.9 **officially includes `dd45f3055`**, whose component change **removed
  the `issues` prop** from `<Harness>` (it now takes `childProgressMap` +
  `surfaceKey` + `onCreateIssue`).
- `git merge v0.4.9` → **0 conflicts** (the test's `<Harness issues={...}/>`
  lines and upstream's component-signature change are in different hunks).
- `pnpm typecheck` → red:
  `table-view-editing.test.tsx(352,11): error TS2322: Property 'issues' does not exist on type ...`
  (and again at line 387).
- Fix: `git checkout v0.4.9 -- packages/views/issues/components/table-view-editing.test.tsx` —
  take upstream's official test, drop the fork's hand-backport. Typecheck green;
  the hand-backport was fully superseded by the official MUL-5164 fix.

This is the same "auto-merge clean but semantically wrong" shape as
`docs/solutions/ui-bugs/admin-list-stale-after-mutation.md` (a runtime cache
contract violation that compiled fine) — different layer, same lesson: the
merge tool does not verify type or runtime contracts; only typecheck/tests do.

## Related

- `docs/upgrades/v0.4.9-plan.md` — this upgrade's Phase 4/5 record of the fix
  (negative_claim caveat predicted it; Phase 5 typecheck caught it).
- `docs/upgrades/v0.4.8-plan.md` — where the hand-backport was originally made
  and recorded.
- `docs/customizations.md` — the per-customization ledger; backports should be
  recorded here with their upstream origin.
- `docs/solutions/workflow-issues/safe-upstream-upgrade-with-local-customizations.md` —
  the 10-step upgrade SOP this pattern complements (it covers accept/re-apply
  strategy; this doc covers the backport-reconciliation sub-case).
- `docs/solutions/ui-bugs/admin-list-stale-after-mutation.md` — sibling
  "auto-merge clean ≠ correct" case at the runtime layer.
