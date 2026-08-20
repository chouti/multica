# Mentioning — source map

Every claim in `SKILL.md` traces to a line below. Re-derive against the current
tree before trusting any line number; the behavior is the contract, the line is
a pointer.

## The mention grammar (what parses)

| Fact | Source |
| --- | --- |
| `MentionRe` — the only recognizer of a mention link | `server/internal/util/mention.go:16` |
| Pattern: `` `\[@?(.+?)\]\(mention://(member\|agent\|squad\|issue\|skill\|project\|all)/([0-9a-fA-F-]+\|all)\)` `` (regex built from `ValidMentionTypes`) | `server/internal/util/mention.go:41-46` |
| `<type>` group = `member \| agent \| squad \| issue \| skill \| project \| all` (joined from `ValidMentionTypes`) | `server/internal/util/mention.go:14-22,41-46` |
| `<id>` group = `[0-9a-fA-F-]+` (hex + dashes) **or** the literal `all` — so a typical name with non-hex letters never matches | `server/internal/util/mention.go:43` |
| `ParseMentions` extracts and dedups `{Type, ID}` from `m[2]`/`m[3]` | `server/internal/util/mention.go:54-67` |
| `Mention.Type` doc enum = "member", "agent", "issue", "skill", "project", or "all" (squad added in regex; skill + project added via `ValidMentionTypes`) | `server/internal/util/mention.go:24-31` |
| `HasMentionAll` reports whether any parsed mention is `all` | `server/internal/util/mention.go:70-77` |
| **`project` parses but is render-only** — `[Label](mention://project/<uuid>)` IS in the type group (fork added it to `ValidMentionTypes`), so it parses to a `project` mention, but the enqueue path handles no `project` case: it can enqueue nothing. It is a render-only link every client makes navigable — a chip on web/desktop (`RichLink` in `packages/views/rich-content/rich-content.tsx`), an ordinary enriched link whose tap is routed on mobile (`onLinkPress` in `apps/mobile/lib/markdown/markdown.tsx`, which renders no chip) | `server/internal/util/mention.go:14-22` |

### Parser behavior tests (pin the example shapes the skill uses)

| Case proven | Source |
| --- | --- |
| `mention://member/<real-uuid>` parses to `{member, uuid}` | `server/internal/util/mention_test.go:42-45` |
| `mention://all/all` parses to `{all, all}` | `server/internal/util/mention_test.go:47-50` |
| `mention://agent/<uuid>` parses; label may contain `[brackets]` | `server/internal/util/mention_test.go:13-35` |
| plain text with no `mention://` parses to `nil` | `server/internal/util/mention_test.go:57-60` |
| Skill eval: a name where a UUID belongs (`mention://member/Alice`) parses to `nil`; a bare `@name` parses to `nil`; a real UUID parses; `@all` → `{all, all}`; a **wrong** type with a real UUID still parses (points at the wrong entity) | `server/internal/service/builtin_skills_test.go:101-157` |

## What each mention type enqueues

| Fact | Source |
| --- | --- |
| `computeCommentAgentTriggers` is the shared comment trigger computation used by preview and enqueueing | `server/internal/handler/comment.go:2874` |
| `resolveMentionedAgentCommentTriggers` builds the mention trigger set (squad + agent branches); `enqueueCommentAgentTriggers` is the shared enqueue helper | `server/internal/handler/comment.go:3223` (resolve), `server/internal/handler/comment.go:2268` (enqueue) |
| Comment creation runs `triggerTasksForComment`, which computes triggers, applies suppressions, then enqueues | `server/internal/handler/comment.go:1973` (func), called from `CreateComment` at `server/internal/handler/comment.go:1932` |
| Comment edit re-triggering also runs `triggerTasksForComment` after cancelling old tasks for the edited comment | `server/internal/handler/comment.go:1973` (func), called from `UpdateComment` at `server/internal/handler/comment.go:3536` |
| `squad` branch: resolve squad in workspace, read `LeaderID`, add the leader trigger | `server/internal/handler/comment.go:3267` (inside `resolveMentionedAgentCommentTriggers`) |
| `squad` → shared enqueue helper calls `EnqueueTaskForSquadLeader` | `server/internal/handler/comment.go:2792,2840` (inside `enqueueCommentAgentTriggers`) |
| Everything not `agent` after the squad branch is skipped: `if m.Type != "agent" { continue }` | `server/internal/handler/comment.go:3340` (inside `resolveMentionedAgentCommentTriggers`) |
| `agent` branch: load agent in workspace, then add the agent trigger | `server/internal/handler/comment.go` (the agent branch immediately after the `!= "agent"` skip at line 3340, inside `resolveMentionedAgentCommentTriggers`) |
| `agent` → shared enqueue helper calls `EnqueueTaskForMention` (a run for that agent) | `server/internal/handler/comment.go:2813,2829` (inside `enqueueCommentAgentTriggers`) |
| **`member` and `issue` mentions reach neither branch — they enqueue NOTHING.** A `member` mention fails the `!= "agent"` skip at line 3340 (the squad branch above it only matches `squad`); an `issue` mention does the same. | `server/internal/handler/comment.go:3267,3340` |

## @skill mention routing (explicit designation, NOT reverse-lookup)

Unlike `agent`/`squad`, the mention `[@Bot](mention://skill/<skill-id>)` does
not pick a runner from the link alone. The composer must supply a non-empty
`skill_mention_agents` map alongside the request; the backend durably binds
each designated agent to the skill (idempotent) and enqueues it.

| Fact | Source |
| --- | --- |
| `CreateCommentRequest` accepts optional `skill_mention_agents` (map of skill id → agent ids; values are agent-id arrays since the redesign added multi-agent support) | `server/internal/handler/comment.go:1465` |
| `UpdateComment` accepts optional `skill_mention_agents` (same shape) — the inline DTO field is declared at line 3446, decoded/validated via `parseSkillMentionAgents` at line 3468, and forwarded to `triggerTasksForComment` at the retrigger site | `server/internal/handler/comment.go:3402` (handler), `server/internal/handler/comment.go:3446` (DTO field), `server/internal/handler/comment.go:3468` (parse), `server/internal/handler/comment.go:3536` (forward) |
| `triggerTasksForComment` is the create-time entry point that computes implicit triggers, calls `bindAndEnqueueSkillMentions` for the designated agents, concatenates with implicit triggers, runs the outer R5 dedup, and binds ONLY the deduped set (bind-on-first-trigger; the bind-without-run weapon is closed) | `server/internal/handler/comment.go:1973` (func), `server/internal/handler/comment.go:1985` (bindAndEnqueue call), `server/internal/handler/comment.go:2001` (dedup), `server/internal/handler/comment.go:2008` (post-dedup bind) |
| `bindAndEnqueueSkillMentions` resolves the @skill mentions in a comment to the user-designated agents; returns one trigger per agent + a per-agent list of skill ids (so a single agent designated for multiple @skill chips gets all of them bound) — NO dedup, NO bind (both happen in the caller) | `server/internal/handler/comment.go:2060` (func) |
| `bindDesignatedSkillsForTriggers` upserts the agent_skill rows AFTER the outer dedup, iterating the deduped slice; per-agent bind failure (DB blip) is logged and the loop continues so a transient error does not strand remaining agents unbound-and-enqueued | `server/internal/handler/comment.go:2205` (func) |
| Designated-agent gates mirror direct `@agent`: invocable (`canInvokeAgent`), not archived, runtime present; `m.ID` for the skill mention is parsed via `util.ParseUUID` + `m.ID == "all"` skip (defense against panicking on malformed mention ids) | `server/internal/handler/comment.go:2144` (canInvokeAgent gate), `server/internal/handler/comment.go:2109,2112` (all-skip + safe parse) |
| The agent_skill upsert is a single TOCTOU-closed statement (the prior `GetAgentSkillEnabled`-then-`AddAgentSkill` split was closed into one idempotent upsert — a disabled-but-existing row is re-enabled, a missing row is inserted) | `server/internal/handler/comment.go:2197` (TOCTOU note), in `bindDesignatedSkillsForTriggers` at `server/internal/handler/comment.go:2205` |
| Mention_skill enqueue failure returns `err` like every other trigger source (the source-labeled enqueue switch is in `enqueueCommentAgentTriggers`) | `server/internal/handler/comment.go:2819` (mention_skill enqueue case) |
| The shared outer dedup (`dedupeTriggersByAgent`) in `triggerTasksForComment` collapses an implicit path + @skill designation for the same agent, keeping the implicit trigger; the bind pass then runs only on the deduped set, closing the bind-without-run weapon | `server/internal/handler/comment.go:2001` (outer dedup), `server/internal/handler/comment.go:2008` (post-dedup bind call), `server/internal/handler/comment.go:2020` (dedupeTriggersByAgent func) |
| Preview route accepts `skill_mention_agents` for shape validation but parses-and-discards — the read-only preview NEVER binds or triggers a skill | `server/internal/handler/comment.go:1632` (parse-and-discard in `PreviewCommentTriggers`) |
| `commentTriggerSourceMentionSkill` is the source label returned on a chip when the user explicitly designated the agent via `skill_mention_agents` | `server/internal/handler/comment.go:1507` |
| `commentTriggerSourceMentionSkill` reason string returned alongside the source on the preview/response payload | `server/internal/handler/comment.go:1590` (reason switch), `server/internal/handler/comment.go:2162` (trigger construction) |
| `commentTriggerSourceThreadParent` source label for reply-parent triggers | `server/internal/handler/comment.go:1508`, `server/internal/handler/comment.go:1592` (reason switch) |
| Frontend trigger-chip label switches for `mention_skill` and `thread_parent` (so chips don't fall through to the unknown-source "trigger" label) | `packages/views/issues/components/comment-trigger-chips.tsx:51-78` |
| i18n keys `trigger_source_mention_skill` and `trigger_source_thread_parent` (en/zh-Hans/ja/ko parity) | `packages/views/locales/en/issues.json:316-321`, `packages/views/locales/zh-Hans/issues.json:307-312`, `packages/views/locales/ja/issues.json:307-312`, `packages/views/locales/ko/issues.json:307-312` |

## Issue-path `@skill` designation (create + edit)

Fork-only extension of the comment-path `@skill` gesture to the issue
description editor. The frontend submits the same `skill_mention_agents`
map; the backend reuses `parseSkillMentionAgents` for boundary validation
(per-skill 8 / total-map 16 caps, identical to the comment path) and emits
outcomes through the unified dispatch vocabulary
(`DispatchStatus` / `DispatchReasonCode` in `server/internal/handler/admission.go`,
aliased from `server/internal/dispatch`). The comment-path gate set is the
gate set here: `canInvokeAgent` (see-vs-run split), archived, runtime-bound
— and the same enumeration-safe `reason_code` is returned on refusal.

| Fact | Source |
| --- | --- |
| Shared boundary parser for `skill_mention_agents` (per-skill 8 / map 16 caps); reused unchanged for the issue path | `server/internal/handler/handler.go:579-612` (`parseSkillMentionAgents`) |
| Unified dispatch outcome enum (`queued` / `coalesced` / `deferred` / `bound` / `merged` / `blocked`) + reason-code vocabulary (aliased from `server/internal/dispatch`) | `server/internal/handler/admission.go:28-75` |
| Issue-path outcome type carried on `IssueResponse.SkillDesignationOutcomes` | `server/internal/handler/issue.go:81-87` (`SkillDesignationOutcomes` field) + `server/internal/handler/issue.go:90-103` (`IssueSkillDesignationOutcome` shape) |
| `IssueSkillDesignationOutcome` builder (`IssueCreateResponse.SkillDesignationOutcomes = designationOutcomes`) and `IssueUpdateResponse` mirroring | `server/internal/handler/issue.go:3065` (create response), `server/internal/handler/issue.go:3955-3956` (update response) |
| Create request DTO: `CreateIssueRequest.SkillMentionAgents` (raw map, validated at the boundary) | `server/internal/handler/issue.go:2728-2735` (field decl), `server/internal/handler/issue.go:2760` (parse call) |
| Update request DTO: `UpdateIssueRequest.SkillMentionAgents` (same shape) | `server/internal/handler/issue.go:3466-3473` (field decl), `server/internal/handler/issue.go:3642` (parse call) |
| Service-layer container for the in-transaction bind: `IssueCreateParams.SkillDesignations` (handler-pre-gated; permission-free for this layer) | `server/internal/service/issue.go:83-91` (field), `server/internal/service/issue.go:377-389` (in-transaction `UpsertAgentSkillEnabled` loop) |
| Pre-create gate: workspace resolution, description content coupling, invoke/archived/runtime checks per agent; mirrors comment-path gate set (R15); returns admitted map + blocked outcomes | `server/internal/handler/issue.go:3069-3160` (`gateIssueSkillDesignations`) |
| Pre-update gate call site (re-uses the same function as create; same actor fields pulled from the update request via `invokeOriginatorFromRequest`) | `server/internal/handler/issue.go:3887-3894` |
| Post-create split (R7/R8/pending-merge + `EnqueueTaskForMentionWithActor` fallback per agent); folded blocked outcomes | `server/internal/handler/issue.go:3162-3245` (`applyCreateIssueSkillDesignations`) |
| Post-update bind (post-commit best-effort, sequenced before any enqueue; single-row upsert; per-pair failure logged + skipped) | `server/internal/handler/issue.go:3247-3273` (`bindIssueSkillDesignations`) |
| Post-update split (R9/R11/KTD6: bind-only for post-update assignee, backlog or `SuppressRun`; otherwise enqueue + handoff note) | `server/internal/handler/issue.go:3275-3386` (`applyUpdateIssueSkillDesignations`) |
| KTD7 handoff note builder (event summary; does not rewrite user's free-text handoff field) | `server/internal/handler/issue.go:3388-3409` (`issueSkillDesignationHandoffNote`) |
| Enqueue leaf used by both create and edit paths: `EnqueueTaskForMentionWithActor` (explicit agent id, no trigger comment, member actor as accountable human) | `server/internal/service/task.go:1186-…` (`EnqueueTaskForMentionWithActor`); pending-task unique index `idx_one_pending_task_per_issue_agent_v2` from migration 257 (v1 dropped by migration 258) |
| Shared pending-task helper that protects the post-update split from a race with the natural enqueue | `server/internal/handler/comment.go` (search `hasPendingTaskForIssueAndAgent`, reused unchanged on the issue side) |
| Private-agent invoke gate (see-vs-run split, MUL-3963) — same predicate as the comment path; runs BEFORE any archived/runtime state is read so a caller who may not invoke the target never learns its state | `server/internal/handler/agent_access.go:48` (`canInvokeAgent`) |
| Frontend shared engine: auto-open popover + auto-bind + sticky recommendation; reused unchanged by the description editor | `packages/views/issues/hooks/use-skill-mention-auto-open.ts` + `packages/views/issues/hooks/use-skill-auto-bind.ts` + `packages/views/issues/hooks/use-recommended-skill-agent.ts` |
| Frontend designation-context provider (mounts under each `ContentEditor` so the shared engine has the workspace/issue context it needs) | `packages/views/editor/skill-mention-context.ts` (provider), `packages/views/editor/skill-agent-picker.tsx` (popover), `packages/views/editor/extensions/mention-suggestion.tsx` (chip + auto-open wiring) |
| Create-modal mount point for the description editor (manual mode only) | `packages/views/modals/create-issue.tsx:864-874` (ContentEditor) |
| Edit-mode mount point for the description editor | `packages/views/issues/components/issue-detail.tsx:2728-2768` (ContentEditor in the description panel) |
| Submit pipeline (create): the create mutation carries `skill_mention_agents` and the `updateIssue` response schema parses `skill_designation_outcomes`; `CreateIssueSchema` accepts the optional map (empty map = no field on the wire) | `packages/core/types/api.ts` (request types), `packages/core/api/client.ts` (`createIssue`/`updateIssue` + zod schemas), `packages/core/issues/mutations.ts` (control-field strip list now includes `skill_mention_agents`, alongside `suppress_run`) |
| Submit pipeline (edit): `useUpdateIssue` payload assembly + `onSuccess` consumer (KTD1 single-shot) | `packages/core/issues/mutations.ts:111-124, :204-224`, `packages/views/issues/components/issue-detail.tsx` (onUpdate接入 :2754-2758 + onSuccess 消费 + 触碰-only 触发器 per R10) |
| Draft persistence: `skillMentionAgents` + touched/filled guards persisted with `multica_issue_draft` so reload doesn't drop pending designations (KTD8); mirrors `CommentDraftPayload.touchedSkillIds` / `filledSkillIds` from the comment path | `packages/core/issues/stores/draft-store.ts` |
| Run-hint client-side designation row ("将携带 skill 运行" / "只绑定不运行") covers the server preview-not-extended gap (KTD8/KTD9) | `packages/views/modals/create-issue.tsx` (CreateRunHint 扩展) |
| Non-block feedback: bind-only + blocked aggregated toasts; unresolved-designation disclosure band (R14) | `packages/views/issues/actions/use-issue-actions.ts` (onSuccess 钩子位) + 编辑态提示组件 |

## Preview and suppression

| Fact | Source |
| --- | --- |
| Preview route: `POST /api/issues/{id}/comments/trigger-preview` | `server/cmd/server/router.go:1146` |
| Preview handler loads the issue, expands issue identifiers, then calls `computeCommentAgentTriggers` | `server/internal/handler/comment.go:1611` (handler), `server/internal/handler/comment.go:1694` (compute call) |
| Preview request accepts `content`, optional `parent_id`, and optional `editing_comment_id` | `server/internal/handler/comment.go:1638,1657` (optional-field parsing) |
| Preview response returns agent `id`, `name`, optional `avatar_url`, `source`, and `reason` | `server/internal/handler/comment.go:1601` (`commentAgentTriggerToResponse`) |
| `editing_comment_id` is parsed as UUID input, scoped to the same workspace and issue, and used as `ExcludeTriggerCommentID` | `server/internal/handler/comment.go:1639` (parse), `server/internal/handler/comment.go:1652` (ExcludeTriggerCommentID) |
| Preview validates or derives the parent context for an edit | `server/internal/handler/comment.go:1657-1663` (parent_id validate) |
| `CreateCommentRequest` accepts optional `suppress_agent_ids` | `server/internal/handler/comment.go:1457` |
| `UpdateComment` accepts optional `suppress_agent_ids` | `server/internal/handler/comment.go:3445` |
| Create-comment `suppress_agent_ids` is parsed as request-boundary UUID input | `server/internal/handler/comment.go:1798` |
| Update-comment `suppress_agent_ids` is parsed as request-boundary UUID input | `server/internal/handler/comment.go:3482` |
| Create and edit trigger paths compute the full trigger set, then apply `filterSuppressedCommentAgentTriggers` before enqueueing | `server/internal/handler/comment.go:2010` (filter call in `triggerTasksForComment`), `server/internal/handler/comment.go:2228` (func) |
| Frontend API sends `editing_comment_id` for preview and `suppress_agent_ids` for update when present | `packages/core/api/client.ts:664-700` |
| Edit UI calls preview with `editingCommentId`, renders trigger chips, tracks suppressed agents, and submits suppressions on save | `packages/views/issues/components/comment-card.tsx:269-274,300-315,359-367,578-582,858-862` |
| Preview hook includes `editingCommentId` in its query key and sends it to the API | `packages/views/issues/hooks/use-comment-trigger-preview.ts:58-80` |
| Timeline edit mutation passes suppressed agent IDs through to the API layer | `packages/views/issues/hooks/use-issue-timeline.ts:299-302` |

## Plain replies and implicit routing

| Fact | Source |
| --- | --- |
| A direct reply to an agent resolves through `routeReplyToParentAuthor` before any assignee fallback | `server/internal/handler/comment.go` (search `parentComment.AuthorType == "agent"` inside `computeCommentAgentTriggers`) |
| A member-authored thread with an explicit or task-derived agent owner resolves through `routeThreadRootOwners` and returns before the final fallback | `server/internal/handler/comment.go` (search `routeThreadRootOwners` inside `computeCommentAgentTriggers`) |
| If the direct parent is a member and no thread owner handled the reply, the reply returns no trigger instead of invoking `routeAssigneeFallback` | `server/internal/handler/comment.go` (search `A plain member-to-member reply`) |
| Top-level member comments retain the final agent/squad assignee fallback because they have no parent | `server/internal/handler/comment.go` (the final `routeAssigneeFallback` call in `computeCommentAgentTriggers`) |
| Regression coverage checks Agent and Squad assignees through both trigger preview and actual comment creation/enqueue | `server/internal/handler/comment_trigger_preview_test.go` (search `PlainReplyToUnownedMemberRootSkipsAssigneeFallback`) |

## Edit-preview pending-task dedup

| Fact | Source |
| --- | --- |
| Default dedup query skips any queued or dispatched task for the issue and agent | `server/pkg/db/queries/agent.sql:544-548` |
| Edit-preview dedup query excludes only tasks whose `trigger_comment_id` equals the edited comment | `server/pkg/db/queries/agent.sql:550-558` |
| `hasPendingTaskForIssueAndAgent` selects the comment-scoped exclusion only when `ExcludeTriggerCommentID` is valid | `server/internal/handler/comment.go:3175` |
| Agent-assignee on-comment dedup uses the shared helper | `server/internal/handler/issue.go` (search `hasPendingTaskForIssueAndAgent` in the assignee path) |
| Assigned squad leader on-comment dedup uses the shared helper | `server/internal/handler/comment.go:3168,3172` (squad-leader assignee dedup) |
| Mentioned squad leader dedup uses the shared helper | `server/internal/handler/comment.go:3267` (squad branch in `resolveMentionedAgentCommentTriggers`, search `hasPendingTaskForIssueAndAgent`) |
| Direct agent mention dedup uses the shared helper | `server/internal/handler/comment.go` (agent branch in `resolveMentionedAgentCommentTriggers` after the `!= "agent"` skip at line 3340, search `hasPendingTaskForIssueAndAgent`) |
| Positive regression test covers all four edit-preview trigger sources | `server/internal/handler/comment_trigger_preview_test.go:179-265` |
| Negative regression test proves another comment's pending task still dedupes the preview | `server/internal/handler/comment_trigger_preview_test.go:267-290` |
| Edit-submit regression test proves `suppress_agent_ids` filters update-triggered tasks | `server/internal/handler/comment_trigger_preview_test.go:292-316` |

## Guards and outcomes for a parsed mention

A mention that parses is never silently dropped: every guard below either
records a blocked outcome with a stable `reason_code`, or hands the trigger to
enqueue, which resolves it to queued / coalesced / deferred. Only a mention
that never parsed at all (a name where a UUID belongs) is a true silent no-op.

| Guard | Outcome | Source |
| --- | --- | --- |
| mentioned agent is archived, or has no runtime bound | blocked `target_unavailable` / `runtime_offline` — evaluated in that order and AFTER the invoke gate, so a caller who may not invoke the target never learns its state | `server/internal/handler/comment.go` (search `resolveMentionedAgentCommentTriggers`, the agent-branch `ArchivedAt` / `RuntimeID` checks) |
| mentioned squad's leader is archived, or has no runtime bound | blocked `target_unavailable` / `runtime_offline`, same ordering behind the leader invoke gate | `server/internal/handler/comment.go` (search `resolveMentionedAgentCommentTriggers`, the squad-branch `ArchivedAt` / `RuntimeID` checks) |
| private agent the actor cannot INVOKE (`canInvokeAgent`, not `canAccessPrivateAgent` — MUL-3963 split see-vs-run) | blocked `invocation_not_allowed` | `server/internal/handler/comment.go` (search `resolveMentionedAgentCommentTriggers`, the agent-branch `canInvokeAgent` call) |
| private squad leader the actor cannot INVOKE (`canInvokeAgent`) | blocked `invocation_not_allowed` | `server/internal/handler/comment.go` (search `resolveMentionedAgentCommentTriggers`, the squad-branch `canInvokeAgent` call) |
| well-formed mention uuid that resolves to no agent in this workspace | blocked `invocation_not_allowed` — the SAME code as a private agent, so a blocked reason can never confirm existence | `server/internal/handler/comment.go` (search `Do not reveal whether the id exists`) |
| mention id that is not a valid uuid at all (`mention://agent/-`) | blocked `target_unavailable` on BOTH the agent and squad branch: a non-uuid names no entity anywhere, so it hides nothing and must not be blamed on permission (MUL-5548) | `server/internal/handler/comment.go` (search `cannot name an entity in ANY workspace`) |
| the mentioned agent already has a pending task on this issue | NOT a drop: the resolver flags `AlreadyPending` and enqueue folds the comment into that task — `coalesced` on a same-head merge, `deferred` on a different head, `blocked` if the merge fails closed | flag set in `server/internal/handler/comment.go` (search `AlreadyPending: hasPending`); resolved in `resolveCommentTriggerEnqueue` |
| the mentioned squad's leader already has a pending task on this issue | same `AlreadyPending` fold as the agent row | `server/internal/handler/comment.go` (search `hasPendingTaskForIssueAndAgent` in the squad branch) |
| `canAccessPrivateAgent` definition — the SEE gate, deliberately NOT used by the mention path | n/a (reference) | `server/internal/handler/agent_access.go` (search `func (h *Handler) canAccessPrivateAgent`) |
| `canEnqueueSquadLeader` (loads leader, delegates to `canInvokeAgent`) — squad assignment/promote path, NOT the mention path | n/a (reference) | `server/internal/handler/agent_access.go` (search `func (h *Handler) canEnqueueSquadLeader`) |
| autopilot-delegation invoke authority: an unattributed autopilot run delegating on the issue it created falls back to the autopilot creator as the effective invoking user for the gate, bound to verified speaking-task lineage (author == task agent, `task.issue_id` == this issue) so no cross-issue borrow (MUL-4857) | feeds the invoke gate | gate application via `opts.effectiveInvoker()` in `server/internal/handler/comment.go` (search `func (o commentTriggerComputeOptions) effectiveInvoker`); lineage-verifying helper in `server/internal/handler/agent_access.go` (search `func (h *Handler) autopilotDelegationAuthority`); resolved from the trusted X-Task-ID / `comment.source_task_id` via `autopilotDelegationAuthorityFromRequest` / `autopilotDelegationAuthorityFromComment` |
| autopilot-delegation authority on the DEFERRED path: a delegation to a busy target replays at the target's completion reconcile, which restores the same authority from `comment.source_task_id` (MUL-4857) | feeds the invoke gate | `server/internal/handler/daemon.go` (search `reconcileCommentsOnCompletion`, the `autopilotDelegationAuthorityFromComment` call) |
| authority lineage is persisted per-action: only an agent editing its OWN comment re-stamps `source_task_id` to the current editing task (issue-scoped, like create); any other editor — including a workspace owner/admin editing an agent's comment (manage rights, not invoke rights) — CLEARS it, so a cross-issue edit or an admin edit makes every authority/originator read fail closed, including the deferred completion-reconcile — preview, save, and reconcile agree (MUL-4857) | fails closed | `server/internal/handler/comment.go` (search `commentSourceTaskIDForIssue` and the `isAuthor` branch in `UpdateComment`) |

## @all broadcast and assignee-trigger suppression

| Fact | Source |
| --- | --- |
| `HasMentionAll` reports whether any parsed mention is `all` | `server/internal/util/mention.go` (search `func HasMentionAll`) |
| `@all` with no explicit `@agent`/`@squad` suppresses every implicit route (assignee / thread parent / conversation) → no run | `server/internal/handler/comment.go` (search `if util.HasMentionAll(mentions)` inside `computeCommentAgentTriggers`) |
| `@all` does NOT suppress an EXPLICIT `@agent`/`@squad` in the same comment — the explicit branch is evaluated first (MUL-5411) | `server/internal/handler/comment.go` (the `hasAgentOrSquadMention` branch immediately above the `HasMentionAll` short-circuit) |
| `@all` never enqueues a specific agent: it is neither `squad` nor `agent`, so it is skipped in the mention trigger computation | `server/internal/handler/comment.go` (search `if m.Type != "agent"` in `resolveMentionedAgentCommentTriggers`) |
| Tests: `@all` alone → 0 agents; `@all` + `@agent` → the mentioned agent only; `@all` + `@squad` → the leader; `@all` + `@member` → 0 agents | `server/internal/handler/comment_trigger_preview_test.go` (search `AllPlusExplicitAgentMentionStillTriggers`) |
| A mention id that matches `MentionRe` but is not a valid UUID (`mention://agent/-`) is parsed with the error-returning `util.ParseUUID` and reported as a blocked mention — never a panic / 500 | `server/internal/handler/comment.go` (search `util.ParseUUID(m.ID)` in `resolveMentionedAgentCommentTriggers`); test `server/internal/handler/comment_trigger_preview_test.go` (search `MalformedMentionIDDoesNotPanic`) |

## CLI id sources (where the UUID comes from)

| List command | Field used as mention id | Source |
| --- | --- | --- |
| `workspace member list` | `user_id` (NOT the membership-row id) | `server/cmd/multica/cmd_workspace.go:465` |
| `agent list` | `id` | `server/cmd/multica/cmd_agent.go:365` |
| `squad list` | `id` | `server/cmd/multica/cmd_squad.go:57` |
| Member mention uses `user_id`, confirmed by the backend roster formatter: `formatMention(user.Name, "member", userID)` where `userID = UUIDToString(m.MemberID)` | `server/internal/handler/squad_briefing.go:189-190` |
| `formatMention` emits `[@<name>](mention://<type>/<id>)` | `server/internal/handler/squad_briefing.go:216-218` |

## Explicit non-claim: no member-notification path in the Go comment handler

The skill deliberately does **not** assert that a `member` mention "sends a
notification." `server/internal/handler/comment.go` has no notification
delivery path for member (or issue) mentions: `resolveMentionedAgentCommentTriggers`
branches only on `squad` and `agent`
(`server/internal/handler/comment.go:3267,3340`), and a grep of the file for
`notif` returns only an unrelated comment about avoiding "log spam" on
unchanged threads — no member-notification call. The verified contract is
narrow: a `member` or `issue` mention renders as a link and enqueues no agent
run; only `agent` and `squad` mentions enqueue work on their own; `skill`
mentions enqueue work ONLY when accompanied by a non-empty
`skill_mention_agents` entry for that skill id (see the @skill routing
section above). If a notification UX exists, it is not in this handler, so
this skill makes no claim about it.

## Explicit non-claim: no reverse-lookup of agent↔skill bindings for @skill mentions

The skill deliberately does **not** assert that a `@skill` mention will
"auto-trigger an agent that has the skill bound." Pre-U1 behavior
(`resolveSkillMentionTrigger` in
`server/internal/handler/skill_mention_trigger_test.go` history) used the
binding table to pick a target, but that path is gone. The verified contract
is: the composer explicitly designates agents via `skill_mention_agents`, and
the backend binds + enqueues exactly those agents. A bare `@skill` mention
without a designation is the silent-no-op case documented in
`SKILL.md` Step 2 — the parser still matches, the link still renders, no run
is enqueued.
