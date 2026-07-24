---
title: "@skill mention silently fails to bind when designated agent is already implicit-active (YUP-407)"
date: 2026-07-24
module: server/internal/handler
problem_type: logic_error
component: development_workflow
severity: high
symptoms:
  - "Agent runs but its bundle lacks the designated @skill — agent_skill row never created for the designated agent"
  - "Backend log shows `mention task enqueued` is routed to the assignee, not to the user-designated agent (or vice-versa), even though the user explicitly gestured to a different agent via the @skill popover"
  - "Reproduced with kahneman persona in FZG-338 at 13:49:05: user @ce-plan + gesture designated kahneman (e47f93a7); kahneman responded at 13:49:35 with a hand-rolled plan rather than calling ce-plan; e47f93a7's agent_skill table initially showed no ce-plan (fd314843) binding"
  - "Trigger preview chip showed only the implicit agent row when the agent was both implicit + skill-designated, hiding the user's @skill intent"
root_cause: logic_error
resolution_type: code_fix
tags:
  - skill-mention
  - bind-decouple
  - yup-407
  - dedup
  - r5-r3
  - self-host
---

# @skill mention silently fails to bind when designated agent is already implicit-active (YUP-407)

## Problem

When a user writes a comment that contains both an implicit trigger path (reply-parent agent / assignee / `@agent`) and a `@skill` chip whose gesture designates an agent that the implicit path already selected, the comment creates an `agent_skill` row for the designee — except it didn't. The agent would run, but it would run without the designated skill's bundle, and the failure was invisible: no error, no signal in the chip, no entry in `agent_skill`. The user only noticed when the agent produced a "plan" it had written itself rather than calling `ce-plan`. End-to-end reproduction is recorded in the FZG-338 issue (workspace `fz`, 2026-07-24 13:49), with the kahneman persona as the designated agent and `ce-plan` as the designated skill; the end-to-end verification step shows the resulting `agent_skill` row was created after the fix.

## Symptoms

- Backend log shows `mention task enqueued` is routed to the assignee / implicit trigger winner, not to the agent the user explicitly gestured to via the `@skill` popover. The bind is the missing half of "designated".
- `agent_skill` table has no row for `(designated_agent_id, designated_skill_id)` after the comment is created, even though `skill_mention_agents` was set on the request.
- The trigger-preview chip shows only the implicit agent row, hiding the fact that the user designated a skill for that agent.
- Reproduced end-to-end: kahneman persona in FZG-338 at 13:49:05 — user wrote `@ce-plan` plus the agent-picker gesture designating kahneman (e47f93a7); at 13:49:35 kahneman returned a hand-written plan rather than invoking `ce-plan`. After the fix the same conversation produced the `agent_skill` row (fd314843) and kahneman carried the `ce-plan` bundle.

## What Didn't Work

- **"Frontend gesture isn't submitting."** First instinct was that the user's pick never reached the backend. Backend request log proved otherwise: `skill_mention_agents` was set; the issue was downstream of the request boundary.
- **"Assign workflow is broken."** Re-reading `enqueueCommentAgentTriggers` showed the assignment was correct; the agent was being enqueued under its implicit Source (correct per R5 dedup contract). The actual contract violation was on the bind side, which the dedup had silently invalidated.
- **"Bisect onto v0.4.9 upgrade."** A first stab at bisecting blamed the recent v0.4.9 upgrade. That was a false positive: the regression was local to `bindDesignatedSkillsForTriggers`, present on the v0.4.8 worktree too. Verifying the v0.4.8 worktree against the same `agent_skill` table cleared the upgrade suspicion and pointed at the comment-go bind path.

## Solution

Reverse review finding #4 ("bind-without-run weapon"): stop filtering bind on `Source == mention_skill`, and key the bind pass on agent id (from `skillBindings`) instead of on trigger source. The result is that an agent the implicit path already selected — and which R5 dedup therefore kept in place of the skill duplicate — is still durably bound to the skill. `filterSuppressed` runs after bind and only controls whether the agent runs this turn; it does not undo the durable bind (R3). Trigger-preview also merges so the chip surfaces the designation row when an agent is both implicit and skill-designated (`packages/views/issues/hooks/use-comment-trigger-preview.ts:140-143`).

The post-fix `bindDesignatedSkillsForTriggers` body in `server/internal/handler/comment.go:1723-1744`:

```go
func (h *Handler) bindDesignatedSkillsForTriggers(ctx context.Context, triggers []commentAgentTrigger, skillBindings skillBindingsMap, issue db.Issue) {
	for _, t := range triggers {
		agentKey := uuidToString(t.Agent.ID)
		skills, ok := skillBindings[agentKey]
		if !ok {
			continue
		}
		for _, skillUUID := range skills {
			if _, err := h.Queries.UpsertAgentSkillEnabled(ctx, db.UpsertAgentSkillEnabledParams{
				AgentID: t.Agent.ID,
				SkillID: skillUUID,
			}); err != nil {
				slog.Warn("skill mention bind: upsert failed (continuing)",
					"issue_id", uuidToString(issue.ID),
					"agent_id", agentKey,
					"skill_id", uuidToString(skillUUID),
					"error", err)
				continue
			}
		}
	}
}
```

Before the fix, the loop looked roughly like this (reconstructed from review notes; the source filter was the contract violation):

```go
for _, t := range triggers {
	if t.Source != commentTriggerSourceMentionSkill { // ← R5 dedup rewrites Source to implicit, so this skips exactly the agent we want bound
		continue
	}
	// ... same upsert below ...
}
```

Companion changes:

- `server/internal/handler/comment.go:1491-1531` — `triggerTasksForComment` doc comment expanded to spell out the R3 contract ("filterSuppressed runs next and only controls whether the agent runs this turn; it does not undo the durable bind") so future edits do not silently undo the decoupling.
- `server/internal/handler/skill_mention_trigger_test.go:820-874` — `TestEnqueueSkillMention_ImplicitAndDesignatedSameAgent_BindsDespiteDedup` (renamed from `_NoBindWithoutRun`): assertion reversed from `got != 0` to `got != 1` (the YUP-407 fix's "0→1 inversion").
- `server/internal/handler/skill_mention_trigger_test.go:876` — new `TestEnqueueSkillMention_SuppressedDesignatedAgentStillBound` (doc comment at :876, function at :879) covering R3.
- `packages/views/issues/hooks/use-comment-trigger-preview.ts:140-143` — merge changed so the designated row wins (R5): `[...backendAgents.map(a => designatedById.get(a.id) ?? a), ...designated.filter(a => !backendIds.has(a.id))]`.

## Why This Works

The prior `bindDesignatedSkillsForTriggers` filtered on the trigger's `Source`, not on whether the agent held a designation. After R5 dedup rewrote the source from `mention_skill` to the implicit source (so the agent could still run once, not twice), the bind loop then skipped that exact trigger — the agent kept its implicit-source trigger and the skill duplicate got dropped, but the bind was tied to `Source == mention_skill`, so the bind never ran. The filter described the *path* the trigger traveled, not the *hazard* it posed. Replacing the source filter with an agent-id lookup from `skillBindings` decouples the bind from the run: bind is keyed by which agent the user designated, not by which trigger source survived dedup. This matches the product contract spelled out in `CONCEPTS.md:49-50` ("Skill Mention Gesture"): "designating one and submitting durably binds the skill to that agent (when not already bound) and enqueues the agent to run with the skill's full bundle." The R3/R4 split is also documented in `server/internal/handler/comment.go:2260-2264` — a `@skill` mention without a designation is silent, not suppressive, which is the correct behavioral neighbor for "designated even if dedup-rewritten."

## Prevention

- **Write the failing test first when a contract is silent.** The "bind-without-run weapon" lived in the source filter for months before YUP-407 caught it. `_BindsDespiteDedup` (the YUP-407 regression test, `server/internal/handler/skill_mention_trigger_test.go:820-874`) locks the "0→1 inversion" assertion; any future change that re-introduces a source filter on bind will fail this test. Pair it with `_SuppressedDesignatedAgentStillBound` so R3 stays covered too.
- **Filters must describe hazards, not paths.** Whenever a bind/enqueue/route pass keys on `Source` or any other field that another step can rewrite, ask first: "what invariant survives the rewrite?" If none, the filter is a contract violation waiting to happen. The reviewer F1 finding ("partial reversal") that re-fixed part but not all of the bind-decode flow should be re-read at every comment.go review.
- **Bisect to the function, not to the upgrade.** When a "regression" maps to a single function, bisect onto that function before suspecting an upstream merge. The v0.4.9 false positive cost ~30 min and was preventable by checking out the v0.4.8 worktree first; the git guardrails plus a quick worktree comparison clears it.
- **Front-end mirror of backend invariants.** Whenever a backend dedup contract changes (R5 → R3 here), audit the trigger-preview merge in `use-comment-trigger-preview.ts` and any chip surface in the same change. The chip must reflect "will run carrying the skill," not just "will run."

## Related Issues

- `docs/plans/2026-07-24-001-fix-skill-mention-bind-decouple-plan.md` — plan that produced this fix.
- `docs/customizations.md:54` — ledger entry for the bind-run decoupling work.
- `CONCEPTS.md:49-50` — "Skill Mention Gesture" shared-domain vocabulary.
- Hot files: `server/internal/handler/comment.go` (`bindDesignatedSkillsForTriggers`, `triggerTasksForComment` comments), `server/internal/handler/skill_mention_trigger_test.go` (renamed `_NoBindWithoutRun` → `_BindsDespiteDedup`, assertion reversed 0→1; added `_SuppressedDesignatedAgentStillBound`), `packages/views/issues/hooks/use-comment-trigger-preview.ts`.
- Resolves user report YUP-407; end-to-end-verified on FZG-338 (kahneman persona, `e47f93a7` → `fd314843`) at 13:49.
