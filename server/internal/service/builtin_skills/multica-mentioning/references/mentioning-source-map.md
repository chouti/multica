# Mentioning — source map

Every claim in `SKILL.md` traces to a line below. Re-derive against the current
tree before trusting any line number; the behavior is the contract, the line is
a pointer.

## The mention grammar (what parses)

| Fact | Source |
| --- | --- |
| `MentionRe` — the only recognizer of a mention link | `server/internal/util/mention.go:16` |
| Pattern: `` `\[@?(.+?)\]\(mention://(member\|agent\|squad\|issue\|skill\|project\|all)/([0-9a-fA-F-]+\|all)\)` `` (regex built from `ValidMentionTypes`) | `server/internal/util/mention.go:14-22,41-46` |
| `<type>` group = `member \| agent \| squad \| issue \| skill \| project \| all` (joined from `ValidMentionTypes`) | `server/internal/util/mention.go:14-22` |
| `<id>` group = `[0-9a-fA-F-]+` (hex + dashes) **or** the literal `all` — so a typical name with non-hex letters never matches | `server/internal/util/mention.go:43` |
| `ParseMentions` extracts and dedups `{Type, ID}` from `m[2]`/`m[3]` | `server/internal/util/mention.go:54-67` |
| `Mention.Type` doc enum = "member", "agent", "issue", "skill", "project", or "all" (squad added in regex; skill + project added via `ValidMentionTypes`) | `server/internal/util/mention.go:24-31` |
| `HasMentionAll` reports whether any parsed mention is `all` | `server/internal/util/mention.go:69-77` |

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
| `computeCommentAgentTriggers` is the shared comment trigger computation used by preview and enqueueing | `server/internal/handler/comment.go:1159-1195` |
| `computeMentionedAgentCommentTriggers` builds the mention trigger set; `enqueueCommentAgentTriggers` is the shared enqueue helper | `server/internal/handler/comment.go:1381-1467,1124-1157` |
| Comment creation runs `triggerTasksForComment`, which computes triggers, applies suppressions, then enqueues | `server/internal/handler/comment.go:1069,1092-1098` |
| Comment edit re-triggering also runs `triggerTasksForComment` after cancelling old tasks for the edited comment | `server/internal/handler/comment.go:1577-1594` |
| `squad` branch: resolve squad in workspace, read `LeaderID`, add the leader trigger | `server/internal/handler/comment.go:1397-1435` |
| `squad` → shared enqueue helper calls `EnqueueTaskForSquadLeader` | `server/internal/handler/comment.go:1141-1147` |
| Everything not `agent` after the squad branch is skipped: `if m.Type != "agent" { continue }` | `server/internal/handler/comment.go:1437-1439` |
| `agent` branch: load agent in workspace, then add the agent trigger | `server/internal/handler/comment.go:1440-1464` |
| `agent` → shared enqueue helper calls `EnqueueTaskForMention` (a run for that agent) | `server/internal/handler/comment.go:1148-1154` |
| **`member` and `issue` mentions reach neither branch — they enqueue NOTHING.** A `member` mention fails the `!= "agent"` skip at lines 1437-1439 (the squad branch above it only matches `squad`); an `issue` mention does the same. | `server/internal/handler/comment.go:1397,1437-1439` |

## @skill mention routing (explicit designation, NOT reverse-lookup)

Unlike `agent`/`squad`, the mention `[@Bot](mention://skill/<skill-id>)` does
not pick a runner from the link alone. The composer must supply a non-empty
`skill_mention_agents` map alongside the request; the backend durably binds
each designated agent to the skill (idempotent) and enqueues it.

| Fact | Source |
| --- | --- |
| `CreateCommentRequest` accepts optional `skill_mention_agents` (map of skill id → agent ids; values are agent-id arrays since the redesign added multi-agent support) | `server/internal/handler/comment.go:999-1006` |
| `UpdateComment` accepts optional `skill_mention_agents` (same shape) — the inline DTO is decoded in the handler at lines 2774-2781, validated via `parseSkillMentionAgents` at line 2778, and forwarded to `triggerTasksForComment` at the retrigger site | `server/internal/handler/comment.go:2713` (handler), `server/internal/handler/comment.go:2774-2781` (decode), `server/internal/handler/comment.go:2778` (parse), `server/internal/handler/comment.go:2830` (forward) |
| `triggerTasksForComment` is the create-time entry point that computes implicit triggers, calls `bindAndEnqueueSkillMentions` for the designated agents, concatenates with implicit triggers, runs the outer R5 dedup, and binds ONLY the deduped set (bind-on-first-trigger; the bind-without-run weapon is closed) | `server/internal/handler/comment.go:1492-1537` |
| `bindAndEnqueueSkillMentions` resolves the @skill mentions in a comment to the user-designated agents; returns one trigger per agent + a per-agent list of skill ids (so a single agent designated for multiple @skill chips gets all of them bound) — NO dedup, NO bind (both happen in the caller) | `server/internal/handler/comment.go:1577` (signature), `server/internal/handler/comment.go:1592-1713` (body) |
| `bindDesignatedSkillsForTriggers` upserts the agent_skill rows AFTER the outer dedup, iterating the deduped slice; per-agent bind failure (DB blip) is logged and the loop continues so a transient error does not strand remaining agents unbound-and-enqueued | `server/internal/handler/comment.go:1716` (signature), `server/internal/handler/comment.go:1716-1770` (body) |
| Designated-agent gates mirror direct `@agent`: invocable (`canInvokeAgent`), not archived, runtime present; `m.ID` for the skill mention is parsed via `util.ParseUUID` + `m.ID == "all"` skip (defense against panicking on malformed mention ids) | `server/internal/handler/comment.go:1632-1654` (gates), `server/internal/handler/comment.go:1623-1631` (safe parse) |
| Disabled-but-existing agent_skill row is re-enabled via `SetAgentSkillEnabled(true)`; missing row is inserted via `AddAgentSkill`; the lookup uses the new `GetAgentSkillEnabled` query (one-row SELECT on (agent_id, skill_id) returning the enabled flag) so the two cases are distinguishable | `server/internal/handler/comment.go:1744-1759` (upsert paths), `server/internal/handler/comment.go:1769-1776` (lookup) |
| Mention_skill enqueue failure now returns `err` (matches every other case in `enqueueSingleCommentTrigger`); the previous pre-existing swallow that hid the R5 double-fire is closed | `server/internal/handler/comment.go:2169-2178` |
| The shared outer dedup (`dedupeTriggersByAgent`) in `triggerTasksForComment` collapses an implicit path + @skill designation for the same agent, keeping the implicit trigger; the bind pass then runs only on the deduped set, closing the bind-without-run weapon | `server/internal/handler/comment.go:1521-1535` (outer dedup), `server/internal/handler/comment.go:1535` (post-dedup bind call) |
| Preview route accepts `skill_mention_agents` for shape validation but parses-and-discards — the read-only preview NEVER binds or triggers a skill | `server/internal/handler/comment.go:1153-1184` |
| `commentTriggerSourceMentionSkill` is the source label returned on a chip when the user explicitly designated the agent via `skill_mention_agents` | `server/internal/handler/comment.go:1049` |
| `commentTriggerSourceMentionSkill` reason string returned alongside the source on the preview/response payload | `server/internal/handler/comment.go:1132-1133` |
| `commentTriggerSourceThreadParent` source label for reply-parent triggers | `server/internal/handler/comment.go:1050,1134-1135` |
| Frontend trigger-chip label switches for `mention_skill` and `thread_parent` (so chips don't fall through to the unknown-source "trigger" label) | `packages/views/issues/components/comment-trigger-chips.tsx:51-78` |
| i18n keys `trigger_source_mention_skill` and `trigger_source_thread_parent` (en/zh-Hans/ja/ko parity) | `packages/views/locales/en/issues.json:316-321`, `packages/views/locales/zh-Hans/issues.json:307-312`, `packages/views/locales/ja/issues.json:307-312`, `packages/views/locales/ko/issues.json:307-312` |

## Preview and suppression

| Fact | Source |
| --- | --- |
| Preview route: `POST /api/issues/{id}/comments/trigger-preview` | `server/cmd/server/router.go:707` |
| Preview handler loads the issue, expands issue identifiers, then calls `computeCommentAgentTriggers` | `server/internal/handler/comment.go:837-911` |
| Preview request accepts `content`, optional `parent_id`, and optional `editing_comment_id` | `server/internal/handler/comment.go:778-782` |
| Preview response returns agent `id`, `name`, optional `avatar_url`, `source`, and `reason` | `server/internal/handler/comment.go:784-793` |
| `editing_comment_id` is parsed as UUID input, scoped to the same workspace and issue, and used as `ExcludeTriggerCommentID` | `server/internal/handler/comment.go:855-872` |
| Preview validates or derives the parent context for an edit | `server/internal/handler/comment.go:874-897` |
| `CreateCommentRequest` accepts optional `suppress_agent_ids` | `server/internal/handler/comment.go:770-776` |
| `UpdateComment` accepts optional `suppress_agent_ids` | `server/internal/handler/comment.go:1509-1513` |
| Create-comment `suppress_agent_ids` is parsed as request-boundary UUID input | `server/internal/handler/comment.go:957-964` |
| Update-comment `suppress_agent_ids` is parsed as request-boundary UUID input | `server/internal/handler/comment.go:1523-1535` |
| Create and edit trigger paths compute the full trigger set, then apply `filterSuppressedCommentAgentTriggers` before enqueueing | `server/internal/handler/comment.go:1092-1122,1594` |
| Frontend API sends `editing_comment_id` for preview and `suppress_agent_ids` for update when present | `packages/core/api/client.ts:664-700` |
| Edit UI calls preview with `editingCommentId`, renders trigger chips, tracks suppressed agents, and submits suppressions on save | `packages/views/issues/components/comment-card.tsx:269-274,300-315,359-367,578-582,858-862` |
| Preview hook includes `editingCommentId` in its query key and sends it to the API | `packages/views/issues/hooks/use-comment-trigger-preview.ts:58-80` |
| Timeline edit mutation passes suppressed agent IDs through to the API layer | `packages/views/issues/hooks/use-issue-timeline.ts:299-302` |

## Edit-preview pending-task dedup

| Fact | Source |
| --- | --- |
| Default dedup query skips any queued or dispatched task for the issue and agent | `server/pkg/db/queries/agent.sql:544-548` |
| Edit-preview dedup query excludes only tasks whose `trigger_comment_id` equals the edited comment | `server/pkg/db/queries/agent.sql:550-558` |
| `hasPendingTaskForIssueAndAgent` selects the comment-scoped exclusion only when `ExcludeTriggerCommentID` is valid | `server/internal/handler/comment.go:1232-1244` |
| Agent-assignee on-comment dedup uses the shared helper | `server/internal/handler/issue.go:2576-2594` |
| Assigned squad leader on-comment dedup uses the shared helper | `server/internal/handler/comment.go:1197-1229` |
| Mentioned squad leader dedup uses the shared helper | `server/internal/handler/comment.go:1397-1435` |
| Direct agent mention dedup uses the shared helper | `server/internal/handler/comment.go:1440-1464` |
| Positive regression test covers all four edit-preview trigger sources | `server/internal/handler/comment_trigger_preview_test.go:179-265` |
| Negative regression test proves another comment's pending task still dedupes the preview | `server/internal/handler/comment_trigger_preview_test.go:267-290` |
| Edit-submit regression test proves `suppress_agent_ids` filters update-triggered tasks | `server/internal/handler/comment_trigger_preview_test.go:292-316` |

## Guards that make a valid mention a silent no-op

| Guard | Source |
| --- | --- |
| agent archived / no runtime → `continue` (`RuntimeID` invalid or `ArchivedAt` set) | `server/internal/handler/comment.go:1451-1452` |
| squad leader archived / no runtime → `continue` | `server/internal/handler/comment.go:1417-1423` |
| private agent the actor cannot access → `continue` (`canAccessPrivateAgent`) | `server/internal/handler/comment.go:1454-1458` |
| private squad leader the actor cannot trigger → `continue` (`canAccessPrivateAgent`) | `server/internal/handler/comment.go:1425-1428` |
| already-pending dedup (agent) → shared pending-task helper → `continue` | `server/internal/handler/comment.go:1459-1463` |
| already-pending dedup (squad leader) → shared pending-task helper → `continue` | `server/internal/handler/comment.go:1429-1433` |
| `canAccessPrivateAgent` definition | `server/internal/handler/agent_access.go` (search `func (h *Handler) canAccessPrivateAgent`) |
| `canEnqueueSquadLeader` (loads leader, delegates to `canInvokeAgent`) | `server/internal/handler/agent_access.go:261-267` |
| autopilot-delegation invoke authority: an unattributed autopilot run delegating on the issue it created falls back to the autopilot creator as the effective invoking user for the gate, bound to verified speaking-task lineage (author == task agent, `task.issue_id` == this issue) so no cross-issue borrow (MUL-4857) | gate application via `opts.effectiveInvoker()` in `server/internal/handler/comment.go` (search `func (o commentTriggerComputeOptions) effectiveInvoker`); lineage-verifying helper in `server/internal/handler/agent_access.go` (search `func (h *Handler) autopilotDelegationAuthority`); resolved from the trusted X-Task-ID / `comment.source_task_id` via `autopilotDelegationAuthorityFromRequest` / `autopilotDelegationAuthorityFromComment` |
| autopilot-delegation authority on the DEFERRED path: a delegation to a busy target replays at the target's completion reconcile, which restores the same authority from `comment.source_task_id` (MUL-4857) | `server/internal/handler/daemon.go` (search `reconcileCommentsOnCompletion`, the `autopilotDelegationAuthorityFromComment` call) |
| authority lineage is persisted per-action: only an agent editing its OWN comment re-stamps `source_task_id` to the current editing task (issue-scoped, like create); any other editor — including a workspace owner/admin editing an agent's comment (manage rights, not invoke rights) — CLEARS it, so a cross-issue edit or an admin edit makes every authority/originator read fail closed, including the deferred completion-reconcile — preview, save, and reconcile agree (MUL-4857) | `server/internal/handler/comment.go` (search `commentSourceTaskIDForIssue` and the `isAuthor` branch in `UpdateComment`) |

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
delivery path for member (or issue) mentions: `computeMentionedAgentCommentTriggers`
branches only on `squad` and `agent`
(`server/internal/handler/comment.go:1397,1437-1439`), and a grep of the file for
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
