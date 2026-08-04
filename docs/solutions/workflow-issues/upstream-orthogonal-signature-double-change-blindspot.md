---
title: "Three-way merge silently keeps the fork's function signature when upstream adds a parameter to the same function — only go build catches it"
date: 2026-08-03
category: "workflow-issues"
module: "git"
problem_type: "workflow_issue"
component: "development_workflow"
severity: "high"
applies_when:
  - "Self-host fork added a parameter to a shared function signature and now tracks an upstream release"
  - "Merging an upstream release where upstream also changed the same function's signature or added a new call site for it"
  - "Any three-way merge where both sides extend the same function signature along independent parameter axes"
  - "Auto-merge, merge-tree, and typecheck all pass but the language is Go (signature drift is invisible to typecheck/TS tooling) and only go build catches it"
resolution_type: "code_fix"
tags: [upstream-upgrade, merge-conflicts, go-build, function-signature, orthogonal-signature, three-way-merge, auto-merge, self-hosted]
---

# Upstream upgrade silently drops a parameter when BOTH fork and upstream change the same Go function signature (Strategy D double-signature blind spot)

## Context

This documents a silent-merge defect found during the self-host fork's upstream upgrade from `v0.4.15` to `v0.4.16` (local merge commit `2912c6a32` on this fork's `main`, "merge(upstream): upgrade to v0.4.16 with local customization preservation"). It is a more insidious variant of the Strategy D "orthogonal signature" problem already recorded in `docs/solutions/workflow-issues/safe-upstream-upgrade-with-local-customizations.md` (where Strategy D is first defined) and `docs/solutions/workflow-issues/upstream-api-divergence-cherry-pick-port.md`.

The v0.4.14 incident taught us that an auto-merge can silently drop one side's change when the fork adds a *parameter* and upstream changes the *return value* of the same function — two orthogonal axes that git resolves by picking one side textually. The v0.4.16 incident is the **upgraded version**: here **both sides changed the parameter list** of the same function, on adjacent text, so git's three-way merge picked the HEAD (fork) signature and dropped upstream's new parameter entirely — with zero textual conflict and zero signal from `pnpm typecheck`.

The two colliding changes to `triggerTasksForComment` in `server/internal/handler/comment.go`:

- **Fork** (local customization, @skill mention feature, fork PR #5346): added parameter `skillMentionAgents map[string][]pgtype.UUID`.
- **Upstream v0.4.16** (MUL-4857 autopilot delegation invoke-gate): added a *different* parameter `delegationAuthorityUserID string`, **and** added a brand-new call site in `server/internal/handler/quick_action.go` (quick-actions, MUL-5465 / MUL-5149).

Because the fork's signature line and upstream's signature line occupy the same textual region, `git merge v0.4.16 --no-commit --no-ff` resolved the hunk by taking the fork side. Upstream's `delegationAuthorityUserID` parameter vanished from the merged signature, while upstream's *new* call site in `quick_action.go` — written against the two-parameter version — survived.

## Guidance

When an upgrade audit shows the fork customized a function's **signature**, do not stop at "the merge reported clean." A clean three-way merge is exactly the dangerous case: git resolved the collision by picking one side, and one side's parameter is gone. You must actively hunt for the silent loss.

**1. After any merge that touches a fork-customized signature, grep the upstream diff for (a) a change to the same signature and (b) any *new* call sites of that function:**

```bash
git diff <base>..<tag> -- <file> | grep "func.*<name>\|<name>("
```

If upstream both touched the signature and added a call site, you have a Strategy D double-signature situation: the merged result needs a **manual merge of the two parameter axes**, not a side pick. New upstream call sites are the smoking gun — they are compiled against upstream's parameter list, so they will reference parameters your fork signature doesn't have (or pass them positionally into the wrong slots).

**2. Merge the two parameter axes orthogonally — keep BOTH, don't pick a side.** The correct resolution concatenates the new parameters from each side onto one signature. For this incident the merged signature is (`server/internal/handler/comment.go:1974`):

```go
func (h *Handler) triggerTasksForComment(ctx context.Context, issue db.Issue, comment db.Comment, parentComment *db.Comment, actorType, actorID, originatorUserID, delegationAuthorityUserID string, suppressAgentIDs []pgtype.UUID, skillMentionAgents map[string][]pgtype.UUID) []CommentTriggerOutcome {
```

Note both upstream's `delegationAuthorityUserID string` and the fork's `skillMentionAgents map[string][]pgtype.UUID` are present. Inside the body the new parameter must be threaded into the options struct that already carries the field — here `commentTriggerComputeOptions.AutopilotDelegationAuthorityUserID` (`comment.go:1565`), set at `comment.go:1985`:

```go
AutopilotDelegationAuthorityUserID: delegationAuthorityUserID,
```

**3. Check whether the auto-merge overwrote upstream's *new logic* near the fork's old lines.** A silent pick doesn't only drop parameters — it can revert upstream's newly added body lines back to the fork's older version. In this incident the merge used the fork's older `UpdateComment` body and dropped upstream's new MUL-4857 delegation-resolution logic. It had to be ported back:
- `CreateComment` resolves the authority via `autopilotDelegationAuthorityFromRequest` (`server/internal/handler/agent_access.go:275`, called at `comment.go:1929`).
- `UpdateComment` resolves it via `autopilotDelegationAuthorityFromComment` (`server/internal/handler/agent_access.go:291`, called at `comment.go:3545`).

**4. Update ALL call sites, including the new upstream one and every test.** A Go signature change does not produce a textual conflict, but every caller must compile against the new arity:
- The new upstream call site `quick_action.go:917` passes `delegationAuthority` (a `string`) into the new parameter and appends `nil` for the fork's `skillMentionAgents` (quick actions have no @skill designation):

```go
resp.TriggerOutcomes = h.triggerTasksForComment(r.Context(), issue, comment, nil, actorType, actorID, originatorUserID, delegationAuthority, nil, nil)
```

- Every test call site must gain the new argument (here an empty-string `delegationAuthorityUserID`). The affected test files are `comment_reconcile_test.go`, `skill_mention_trigger_test.go`, and `trigger_test.go`. Run `go vet ./<pkg>/` — it compiles test files and will catch any caller `go build ./...` alone might surface only via the package's own test compilation.

**5. Verify with the toolchain that actually compiles the changed language.** `pnpm typecheck` passed 6/6 green throughout this incident and proved nothing — the divergence was in Go. Only `go build -C server ./...` exposed it. For a backend-signature change, the merge is not verified until `go build ./...` and `go vet ./<pkg>/` are green.

## Why This Matters

This failure mode is silent at every layer except the correct compiler. There was no textual conflict (`merge-tree` and `git merge` both reported clean), and the wrong toolchain (`pnpm typecheck`) stayed green. The merged tree *looked* fully integrated while actually missing an upstream parameter and an upstream feature. Left unfixed, the fork would have shipped v0.4.16 silently missing the MUL-4857 autopilot delegation invoke-gate — a security-relevant A2A invoke authorization — because the merged signature had no way to carry the authority through.

The generalizable lesson is about where git's three-way merge is *blind*: when two branches change the **same line region** of a signature differently, the merge is not a union — it is a pick. Adding parameters is the commonest way a fork and upstream both touch the same signature, so this is not an edge case but the expected collision shape for an actively customized fork. The only reliable detector is the compiler for the language the signature lives in, driven by an audit step that knows to look.

The second-order lesson is that the pick is not limited to the parameter list. The same hunk-level resolution that dropped the parameter also reverted upstream's new body logic near the fork's older lines. Auditing only "does it compile" would have caught the arity error but not the silently-reverted `UpdateComment` delegation logic — that required comparing the merged body against upstream's intent.

## When to Apply

Reach for this procedure on **every upstream upgrade merge** of a fork that carries local customizations, and specifically whenever the audit shows:

- The fork added or changed a **parameter, return type, or any signature element** of a function (handlers are the hot spot — `triggerTasksForComment` and any fork-modified handler are recurring risk points; per auto memory `project-strategy-d-double-signature-merge`, treat any fork-parameter-added handler as a known risk site). (auto memory [claude])
- Upstream's diff for the same file touches the **same function name** — either its `func ...` line or any call site of it.

Trigger the full manual-merge path (not a side pick) when **both** are true: upstream changed the same signature **and** added/changed a call site. The new call site is what turns a silent pick into a build break, and it is the clearest signal that the two parameter axes must be merged by hand.

Do not rely on the absence of a merge conflict as evidence of a correct merge. For signature collisions, "clean" is the failure signal, not the success signal.

## Examples

### Before — what the silent auto-merge produced

The three-way merge took the fork's signature, dropping upstream's `delegationAuthorityUserID`. Upstream's new call site (kept, because it lived in a different file/hunk) then passed a `string` where the fork signature expected `[]pgtype.UUID`, producing the only observable error — from `go build`, not from any merge or TS check:

```
internal/handler/quick_action.go:917:122: cannot use delegationAuthority (variable of type string) as []pgtype.UUID value in argument to h.triggerTasksForComment
```

The string `delegationAuthority` landed in the fork signature's `suppressAgentIDs []pgtype.UUID` slot — a positional arity/type mismatch that only the Go compiler could see.

### After — orthogonal (both-axes) signature merge

Both parameters are kept; the new one is threaded into the options struct:

```go
// server/internal/handler/comment.go:1974
func (h *Handler) triggerTasksForComment(ctx context.Context, issue db.Issue, comment db.Comment, parentComment *db.Comment, actorType, actorID, originatorUserID, delegationAuthorityUserID string, suppressAgentIDs []pgtype.UUID, skillMentionAgents map[string][]pgtype.UUID) []CommentTriggerOutcome {
	// ...
	triggers, targets := h.computeCommentAgentTriggers(ctx, issue, comment.Content, parentComment, actorType, actorID, commentTriggerComputeOptions{
		ExcludeTriggerCommentID:            comment.ID,
		OriginatorUserID:                   originatorUserID,
		AutopilotDelegationAuthorityUserID: delegationAuthorityUserID, // comment.go:1985
	})
	// ...
}
```

The options struct field already existed on the merged tree (`comment.go:1565`), and `effectiveInvoker` (`comment.go:1575`) falls back to it only when `OriginatorUserID` is empty — so wiring the parameter through restores upstream's MUL-4857 gate semantics without disturbing attribution.

The ported-back upstream delegation resolution at the two trusted boundaries:

```go
// CreateComment — comment.go:1929
delegationAuthority := h.autopilotDelegationAuthorityFromRequest(r, issue, authorType, authorID)

// UpdateComment — comment.go:3545
delegationAuthority := h.autopilotDelegationAuthorityFromComment(r.Context(), issue, comment)
```

The new upstream quick-action call site, updated to the merged arity (`quick_action.go:917`) — `nil` for `skillMentionAgents` because quick actions carry no @skill designation:

```go
resp.TriggerOutcomes = h.triggerTasksForComment(r.Context(), issue, comment, nil, actorType, actorID, originatorUserID, delegationAuthority, nil, nil)
```

A representative test call site gaining the empty `delegationAuthorityUserID` (`trigger_test.go:116`):

```go
h.triggerTasksForComment(context.Background(), issue, comment, nil, "member", memberID, memberID, "", nil, nil)
```

### Verification

After the manual merge and call-site updates, `go build -C server ./...` and `go vet -C server ./internal/handler/` were both green. The fix is recorded in merge commit `2912c6a32`.

## Related

- `docs/solutions/workflow-issues/safe-upstream-upgrade-with-local-customizations.md` — the parent strategy. Strategy D (orthogonal function-signature merge) is first defined here (Step 4), with the *return-type* variant of this same function (`triggerTasksForComment`: fork adds a param + upstream changes the return type). This doc is the missed sub-variant: **both sides append to the parameter list**, which the SOP's "When NOT to apply" carve-out (same-slot conflict) does not cover.
- `docs/solutions/workflow-issues/upstream-type-scale-refactor-fork-only-files-blindspot.md` — sibling blindspot, same meta-lesson ("auto-merge clean + typecheck green ≠ semantically correct") at a different layer (design-system tokens vs Go parameter list), and one-sided refactor vs this doc's two-sided concurrent edit.
- `docs/solutions/workflow-issues/run-typecheck-after-upstream-merge.md` — argues `tsc --noEmit` is the non-skippable post-merge gate. True for TS/TSX, but **necessary-not-sufficient for Go signature drops** — this doc is the class of break even that gate misses; only `go build` catches it.
- `docs/solutions/workflow-issues/rerere-stale-auto-resolution-upgrade-merge.md` — sibling auto-resolution-trust lesson (rerere replaying a stale resolution vs three-way hunk alignment dropping a parameter axis).
- `docs/solutions/workflow-issues/merge-feature-branch-customized-main.md` — Strategy D applied to a feature-branch merge (the SOP's param + return-type variant); cross-link so a reader landing there discovers the param-append blindspot too.
- `docs/solutions/workflow-issues/manual-backport-merge-liability.md` — sibling "contract-level divergence, text-merge-clean" lesson (backport origin, caught at typecheck rather than go build).
- `docs/solutions/workflow-issues/upstream-single-sided-fork-param-convergence-merge.md` — **the mirror image (scenario B)**. Where this doc covers both sides adding a parameter (the union-signature fix, caught by `go build`), scenario B covers upstream *removing* a fork-added parameter axis: auto-merge picks the fork side cleanly, **no `go build` error**, and the blind spot moves from "build" to "behavior". An auditor who reads only this doc will misclassify a scenario-B case as "safe" because the compile passes.
