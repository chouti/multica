---
title: "Strategy D mirror blind spot — upstream single-sided convergence of a fork-added function parameter (scenario B)"
date: 2026-08-04
category: "workflow-issues"
module: "git"
problem_type: "workflow_issue"
component: "development_workflow"
severity: "medium"
applies_when:
  - "fork added a parameter to a shared function and upstream may delete the path that consumes it"
  - "merging a Strategy D fork-vs-upstream release where one side fully refactored a function the fork had previously extended"
  - "auto-merge completes with zero text conflicts but fork-only code paths may now silently bypass upstream safety checks"
  - "Go function arity appears consistent across an upstream merge boundary even though one side's semantics have been replaced"
  - "post-merge go-build and typecheck pass cleanly yet a fork-added parameter is no longer wired through the surviving definition"
tags: [upstream-upgrade, merge-conflicts, go-build, function-signature, strategy-d, fork-9-arg, auto-merge, self-hosted]
---

# Strategy D mirror blind spot — upstream single-sided convergence of a fork-added function parameter (scenario B)

## Context

This documents the mirror image of the already-recorded Strategy D orthogonal-signature blind spot. Both scenarios are silent on auto-merge: zero textual conflicts, typecheck passes, but the merged code no longer reflects both sides' intended semantics. They differ in **direction**:

- **Scenario A** (already documented in `docs/solutions/workflow-issues/upstream-orthogonal-signature-double-change-blindspot.md`, v0.4.16): **both** the fork and upstream add parameters to the same function on independent axes. Auto-merge picks one side, dropping the other's parameter. Only `go build` catches it. Resolution: merge the parameter axes orthogonally.
- **Scenario B** (this document, v0.4.17): the fork added a parameter; upstream **fully refactored** the function and removed the parameter entirely. Auto-merge picks one side — and the outcome is the **opposite** of scenario A: no arity mismatch, no `go build` fix needed, because the fork side wins both the function definition and every call site. The clean compile is the trap: the fork's binding-on-submit path (PR #6220 / internal MUL-5559, plus MUL-5557 and MUL-3963 context) now exists alongside upstream's `isAgentRuntimeBound` (PR #6220) gate, with no semantic handshake between them.

The trigger event was the v0.4.16 → v0.4.17 upgrade (merge commit `720f03209` — a local self-host fork merge, not an upstream PR; SHA is fork-local and may be rewritten if the branch is rebased, so verify via the plan file's record) on this fork's `main`, "merge(upstream): upgrade to v0.4.17 with local customization preservation". Upstream commit `b06af2ae1` (GitHub PR #6220, "feat(runtime): unbind agents on runtime delete instead of destroying them" — the commit subject carries `#6220`, not the internal ticket `MUL-5559`; the two are the author's mapping, cited here for searchability) replaced `server/internal/handler/comment.go`'s `triggerTasksForComment` with a 9-arg-signature (counting `ctx`: ctx + issue + comment + parentComment + 4 string args + suppressAgentIDs) that drops the fork's `skillMentionAgents map[string][]pgtype.UUID` last parameter (added in #5346) — making it one parameter shorter than the fork's 10-arg version. The fork had also added `bindAndEnqueueSkillMentions` (lives at `server/internal/handler/comment.go:2072`) and `parseSkillMentionAgents` (lives at `server/internal/handler/handler.go:538`), plus a fork-only test file `server/internal/handler/skill_mention_trigger_test.go`; the helper functions are fork-original (they never existed in any upstream tag), and neither they nor the `skillMentionAgents` parameter exist in upstream. Auto-merge took the fork side: 10-arg definition, 10-arg call sites, and all helper functions intact.

(Note on the "fork-9-arg" label used throughout this doc and in the `tags:` frontmatter: it refers to the **non-`ctx`** argument count, the convention used in the v0.4.16 + v0.4.17 upgrade-plan artifacts. The raw parameter count including `ctx` is 10 for the fork side and 9 for upstream; the +1 fork-added axis is `skillMentionAgents`.)

## Guidance

The audit pattern from scenario A is **not sufficient for scenario B**. The grep pattern there checks for two signatures of upstream activity:

```bash
git diff <base>..<tag> -- <file> | grep "func.*<name>\|<name>("
```

That catches `(a)` upstream redefined the signature and `(b)` upstream added a new call site. For scenario B, the signal is different: upstream **refactored the function body and dropped the fork-added parameter axis** without deleting the function. The function still exists on both sides; what changed is that the fork-added parameter is present at HEAD and **absent in the upstream tag**. Detect this with a count comparison on the fork-added symbol, not with a function-deletion grep:

```bash
# fork-added symbol count, upstream tag side:
git show <tag>:<file> | grep -c '<fork_added_symbol>'
# fork-added symbol count, HEAD side:
git grep -c '<fork_added_symbol>' <file>
```

Combined, the classification is:

| Signal | Scenario | Resolution |
|---|---|---|
| `(a)` upstream redefined signature AND `(b)` added new call site, both sides add a param | **A** (orthogonal double-signature) | Strategy D: manually merge the two parameter axes into a union signature; `go build` will catch the arity mismatch |
| Fork-added symbol absent upstream (`git show <tag>` count = 0) but present at HEAD (non-zero), AND upstream did NOT add a competing parameter on the same slot | **B** (upstream single-sided convergence) | Keep-fork-path: auto-merge already picked the fork side; **no `go build` fix needed**; verify fork-side semantics still compose with upstream's new state machine |
| `(a)` only — upstream redefined signature, no new call site, no parameter-axis collision | Single-side addition (not Strategy D) | Take upstream's new signature; port fork's parameter value through at every fork call site |
| `(b)` only — new upstream call site, no signature change | New call site | Audit fork call sites for the new wiring (less common; usually means upstream uses the function in a new code path) |
| Upstream deleted the function entirely (`git show <tag>:<file>` errors or `^-func.*<name>` hits in the upstream-tag diff) | Function removal | Fork path is now dead code; decide whether to delete the fork customization or keep it as fork-only |
| None of the above | Pure auto-merge safe | No additional action |

**Key asymmetry between A and B:** scenario A produces a `go build` arity error (the smoking gun). Scenario B produces **no build error** — both sides compile independently because the fork side wins cleanly. The B smoking gun is a **count mismatch on the fork-added symbol** (0 upstream vs non-zero HEAD), which only a deliberate `git show`/`git grep` comparison reveals. A scenario-A-only auditor who relies on `go build` to surface the problem will declare scenario B "safe" and skip the post-merge semantic verification.

For scenario B specifically, after auto-merge:

1. **Confirm fork side survived intact.** Run `git grep -c '<fork_param>' server/internal/handler/<file>.go` and verify the count matches the pre-merge fork side. For the v0.4.17 case, `git grep -c 'skillMentionAgents' server/internal/handler/comment.go` returned `7` (function definition + 6 call sites), matching the pre-merge fork count.
2. **Verify upstream's semantics did not silently replace the fork's.** In scenario A, the danger is that auto-merge picked the fork signature and dropped an upstream parameter. In scenario B, the danger is the inverse: auto-merge picked the fork path entirely, and upstream's safety checks (here `isAgentRuntimeBound` + `ReasonAgentRuntimeRequired`) are now siblings of the fork's binding-on-submit path with no integration. The fork may continue to call its helper functions through `comment.go`, but those calls now operate on a runtime-unbind-aware upstream state that the helpers were never written to inspect.
3. **Decide whether to keep-fork-path or re-port.** The audit answer for v0.4.17 was keep-fork-path (per Phase 2 user decision): the fork's `@skill` chip rendering and trigger-preview (frontend) survive independently of upstream's runtime-unbind path; both run in parallel, and the user accepted that the fork's backend bind logic would no longer fire for the runtime-unbind scenario. The alternative — delete the fork path and rely on upstream's PR #6220 uniformly — would have collapsed two PRs (#5346 plus #6220's reason codes) into one path with simpler semantics. The user's choice trades ongoing fork-vs-upstream maintenance for retention of the bind-on-submit design.

The category-level prevention is in **Phase 1 audit checks** (see `docs/upgrades/v0.4.17-plan.md` Phase 1.2 negative claims 11–14). The pre-merge audit must include the grep-three-patterns check before predicting whether `go build` will need a manual fix. v0.4.16 plan's Strategy D prediction fired correctly and required a fix; v0.4.17 plan's "scenario B may need a fix" prediction fired incorrectly (auto-merge cleanly took fork side) — both were the right precautionary prediction.

## Why This Matters

Without the scenario-B distinction, an auditor who only checks for scenario A would conclude "auto-merge clean = safe" and skip the post-merge semantic verification. The trap is:

- **Auto-merge clean does not mean fork semantics survived.** The fork's `@skill` bind-on-submit path in v0.4.17 is functionally divorced from upstream's `isAgentRuntimeBound` gate. Forks that operate both paths without coordination will silently produce inconsistent behavior — a chip renders as selectable (fork path says yes) but the underlying runtime is unbound (upstream gate would say no). The merge compiles; the UI may behave wrongly.
- **`go build` will not catch it.** Scenario A's blind spot is exactly that auto-merge silently drops a parameter and `go build` catches the arity error. Scenario B has no arity error — both sides compile independently. The blind spot moves from "build" to "behavior".
- **Audit prediction asymmetries bias future runs.** The v0.4.17 plan predicted an arity mismatch based on the v0.4.16 lesson, and was wrong (the prediction was safer than reality). Future audits may over-weight the scenario-A pattern (grep for added parameters) and under-weight scenario B (grep for removed paths). The Phase 1.2 negative-claim discipline catches this when the auditor forces the conclusion "no arity mismatch expected" through a raw command rather than reasoning about it.

Both scenario A and scenario B share the same Phase-1 audit shape (silent on textual conflict, typecheck-clean). They differ in resolution direction. Phase 4 strategy choice must precede Phase 5 verification; a misclassified scenario will either over-merge (concatenating parameters that upstream deleted, breaking the fork's call sites) or under-merge (silently leaving the fork path wired into upstream's new state machine).

## When to Apply

This audit pattern applies when:

- The self-host fork added a parameter to a shared Go function (handler in `server/internal/handler/` is the recurring hot spot; per the auto-memory entry `project_strategy_d_double_signature_merge.md` — Claude Code auto-memory at `~/.claude/projects/-Users-fengzhao-multica/memory/`, outside the repo tree — treat any fork-parameter-added handler as a known risk site)
- An upstream release touches the same function (possibly refactoring it or removing the path entirely)
- Phase 1 audit of an upstream upgrade shows upstream modifying a fork-touched function file
- Auto-merge completes with zero text conflicts but the merged code may have a fork path that no longer wires through any upstream safety check
- The fork-added symbol is **absent in the upstream tag** (`git show <tag>:<file> | grep -c '<fork_symbol>'` = 0) but **present at HEAD**, and upstream did not add a competing parameter on the same slot

It does **not** apply when:

- The fork did not customize the function's signature (carry-original)
- The fork's customization is a non-signature change (e.g., a function body edit with the same signature)
- TypeScript / Vue files (TS tooling catches most silent picks via type errors; the Go-specific blind spot does not translate)
- The function is owned by upstream-only and the fork has never modified it

## Examples

**v0.4.16 → v0.4.17 trace** (the canonical scenario-B case):

```text
Upstream commit b06af2ae1 (GitHub PR #6220, "feat(runtime): unbind agents on
runtime delete instead of destroying them"; internal ticket MUL-5559):
  - server/internal/handler/comment.go:1943  (call site, upstream 9-arg variant incl. ctx)
  - server/internal/handler/comment.go:1956  (function def, upstream 9-arg incl. ctx)
  - converged triggerTasksForComment: dropped fork's skillMentionAgents last param
  - left fork-original helpers in place (auto-merge kept fork side):
      bindAndEnqueueSkillMentions  (comment.go:2072, fork-only — never in upstream)
      parseSkillMentionAgents      (handler.go:538,   fork-only — never in upstream)
      skill_mention_trigger_test.go (fork-only test file — never in upstream)
  - added isAgentRuntimeBound (packages/core/agents/runtime-binding.ts — TypeScript, not Go)
  - added ReasonAgentRuntimeRequired in server/internal/dispatch/reason.go
```

**Scenario-B detection grep — run on the SHARED function, not on fork-only helpers:**

```bash
# Shared function triggerTasksForComment: upstream did NOT delete the function
# (it refactored the body + dropped a parameter). So pattern (c) on the function
# name returns nothing — that is expected, not a miss.
git diff v0.4.16..v0.4.17 -- server/internal/handler/comment.go | grep -E '^-func.*triggerTasksForComment'
# (no output — function was kept with new signature, not deleted)

# The real scenario-B signal is the PARAMETER being deleted on the shared function.
# Look for the minus-side diff line carrying the fork-added parameter name:
git diff v0.4.16..v0.4.17 -- server/internal/handler/comment.go | grep -E '^-.*skillMentionAgents'
# (upstream's pre-image had no skillMentionAgents, so this also returns nothing
# on a clean upstream-tag diff — the signal is instead the ABSENCE of the param
# in `git show v0.4.17:...comment.go` combined with its PRESENCE at HEAD)

# The reliable scenario-B check: count the fork-added symbol upstream-side vs HEAD-side.
git show v0.4.17:server/internal/handler/comment.go | grep -c 'skillMentionAgents'
# 0   ← upstream removed the parameter entirely

git grep -c 'skillMentionAgents' server/internal/handler/comment.go
# 7   ← fork side still has it (function def + 6 call sites)

# A count of 0 upstream + non-zero at HEAD on a fork-added symbol = scenario B.
```

**Do NOT grep `^-func.*<fork-only-helper>`** — fork-original helpers like `bindAndEnqueueSkillMentions` and `parseSkillMentionAgents` never existed upstream, so an upstream-tag diff cannot show them as `-func` deletions. That grep returns empty regardless of scenario; it is not a scenario-B signal.

After auto-merge, the fork side is intact:

```bash
git grep -c 'skillMentionAgents' server/internal/handler/comment.go
# 7
# (function def + 6 call sites — all on fork side)

git show v0.4.17:server/internal/handler/comment.go | grep -c 'skillMentionAgents'
# 0
# (confirms upstream fully removed the parameter — scenario B pre-merge signal)
```

**Audit grep (run before Phase 5 verification):**

```bash
# Identify fork-customized signatures in advance
git diff <base>..HEAD -- server/internal/handler/ | grep -E '^\+func.*Handler' | sort -u

# For each fork-customized function, run the three-pattern classification
FN='triggerTasksForComment'
FILE='server/internal/handler/comment.go'
TAG='v0.4.17'
BASE='v0.4.16'

echo "Pattern (a) — upstream redefined signature:"
git diff "$BASE..$TAG" -- "$FILE" | grep -E "func.*${FN}\b" | head -3

echo "Pattern (b) — upstream added new call sites:"
git diff "$BASE..$TAG" -- "$FILE" | grep -E "${FN}\(" | head -3

echo "Pattern (c) — upstream deleted the function:"
git diff "$BASE..$TAG" -- "$FILE" | grep -E "^-func.*${FN}\b" | head -3
```

If only `(c)` returns hits: scenario B. Auto-merge will take the fork side cleanly; verify fork semantics post-merge, but no `go build` fix needed.

**Counter-example (scenario A — does NOT apply here):**

The v0.4.16 incident (covered by `upstream-orthogonal-signature-double-change-blindspot.md`) had both fork and upstream add parameters. Patterns `(a)` and `(b)` both hit. The resolution there was to manually merge the two parameter axes into a 9-arg union signature. Following scenario A's resolution on a scenario-B case would be wrong: concatenating upstream's new 8-arg with the fork's `skillMentionAgents` would produce a 9-arg signature that upstream never knew about, and the fork's call sites would still be the only consumers. Scenario B is the inverse: fork wins cleanly; no union needed.

## Related

- `docs/solutions/workflow-issues/upstream-orthogonal-signature-double-change-blindspot.md` — scenario A (the mirror image); the two docs should be cross-linked for auditors who encounter one first
- `auto-memory/project_strategy_d_double_signature_merge.md` (Claude Code auto-memory at `~/.claude/projects/-Users-fengzhao-multica/memory/`) — the umbrella memory entry, now covering both scenarios A and B; updated 2026-08-04 during the v0.4.17 upgrade
- `docs/upgrades/v0.4.17-plan.md` — Phase 1.2 negative claims 11–14 (the per-file audit + verified_by commands that produced the scenario-B prediction, including the disagreement with the eventual outcome)
- `docs/customizations.md` line 49 — the `#5346` row [OWNS FORK PATCH PER v0.4.17] footnote recording the keep-fork-path user decision
- `docs/solutions/workflow-issues/safe-upstream-upgrade-with-local-customizations.md` — Step 4 introduces Strategy D for the original two-axis case; scenario B is the extension
- `docs/solutions/workflow-issues/rerere-stale-auto-resolution-upgrade-merge.md` — adjacent: silent text-level auto-resolution (rerere replay) is the same family of blind spot as silent text-level signature pick
- `docs/solutions/workflow-issues/manual-backport-merge-liability.md` — adjacent: textually clean auto-merge that violates a downstream contract
- `docs/solutions/workflow-issues/run-typecheck-after-upstream-merge.md` — adjacent: post-merge verification cannot rely on typecheck alone for Go signature drift