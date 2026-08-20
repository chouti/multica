---
name: multica-mentioning
description: "Designate an agent to apply a skill when commenting on or creating/editing an issue. The agent picks up the skill and runs it asynchronously; you get an inbox notification when done."
user-invocable: false
allowed-tools: Bash(multica *)
---

# Mentioning & Delegating

This skill states WHAT a mention link does in the Multica backend, traced to
source. WHETHER to mention at all — loop avoidance, staying silent on
acknowledgements — is in your runtime brief's Mentions section; follow that and
do not repeat it here.

Every claim below is pinned to source in
`references/mentioning-source-map.md`. If behavior ever differs from this
document, the source map is where to re-check it.

## Scope — where the `@skill` designation gesture is available

`@skill` designation (a chip in the composer + a non‑empty `skill_mention_agents`
entry) is a verified backend gesture on three surfaces:

- **Issue comment composer** (CommentInput / ReplyInput) — the original surface.
  See Step 3.
- **Issue creation modal — manual mode description editor** (new in this
  cluster, fork-only). On submit, the durable `agent_skill` bind lands in the
  create transaction (R6, KTD2) and each designated agent is enqueued via the
  same gate + outcome surface the comment path uses, except when the
  designation targets the issue's own assignee (`DispatchMerged`, R7) or the
  new issue is parked in backlog (`DispatchBound`, R8). Traced to
  `gateIssueSkillDesignations`, `applyCreateIssueSkillDesignations`, and the
  in-transaction `IssueCreateParams.SkillDesignations` loop in
  `server/internal/service/issue.go`. Outcomes return on
  `issue.skill_designation_outcomes`.
- **Issue edit-mode description editor** (new in this cluster, fork-only). On
  update, the bind is post-commit best-effort and the enqueue is split on the
  post-update assignee: designating the current assignee produces
  `DispatchBound` (no run, R9); designating a non-assignee agent on a non-
  backlog, non-`SuppressRun` issue produces `DispatchQueued` carrying the skill
  (R9, R11, KTD6). The handoff note reused from the comment path
  (`issueSkillDesignationHandoffNote`) labels the run as a designation event
  without rewriting the user's free-text handoff field (KTD7). Traced to
  `bindIssueSkillDesignations`, `applyUpdateIssueSkillDesignations`, and
  `issueSkillDesignationHandoffNote` in `server/internal/handler/issue.go`.

The gesture is deliberately **not** available on:

- **Agent-mode prompt panel** in the issue creation modal — the panel already
  speaks to one designated actor, so a skill chip in it would re‑route to
  that same actor and add no information. The `@` menu strips the skill entry
  and the manual→agent mode-switch seed rewrites any pre‑existing skill chips
  in the description back to plain text (KD5).
- **CLI or programmatic issue creation/update** — there is no
  `--skill-mention-agents` flag on `multica issue create`/`update`; an API
  call without `skill_mention_agents` is the same silent no-op the comment
  path documents (R12, comment path Step 3).

Frontend pipeline: the shared engine in
`packages/views/issues/hooks/use-skill-auto-bind.ts` + `use-skill-mention-auto-open.ts`
+ `use-recommended-skill-agent.ts` runs in both description editors; the
auto-bind context provider
(`packages/views/editor/skill-mention-context.ts`) mounts under each
`ContentEditor` mount point (`packages/views/modals/create-issue.tsx` and
`packages/views/issues/components/issue-detail.tsx`). The agent-picker
popover (`packages/views/editor/skill-agent-picker.tsx`) is the same UI as the
comment path.

## A mention link is built from a real UUID

The backend recognizes a mention only through this Markdown shape:

    [@Label](mention://<type>/<id>)

The parser (`util.MentionRe` in `server/internal/util/mention.go`) accepts
six `<type>` values (the `all` type doubles as its own sentinel — the id must
also be the literal `all`), and the `<id>` group accepts only hex characters
and dashes, OR the literal string `all`:

    (member|agent|squad|issue|skill|project|all)/([0-9a-fA-F-]+|all)

So the link target is a real entity UUID (or `all`), never a display name. The
label between the brackets is free text — that is where the human-readable name
goes. This document teaches the types that enqueue or link people — `agent`,
`squad`, `member`, `issue`, and `skill` — plus the `@all` broadcast. `project`
is a recognized mention type but is out of scope here (see the projects
skill).

Note: `skill` is a recognized mention TYPE for routing and silent no-ops, but
unlike the others a bare `@skill` mention does NOT auto-route to an agent —
it fires ONLY when the composer also passes a non-empty designation list for
that skill id (see Step 2). Without a designation the parser still matches,
the mention renders, and the backend does nothing with it. This is the same
silent contract a `member` mention uses, but for a different reason: members
never had a runner, while skill mentions ARE routed to agents — just not by
the backend inferring one from a binding table.

One `mention://` form deliberately sits OUTSIDE this parser:
`[Label](mention://project/<uuid>)`. `project` is absent from the type group
above, so the backend never parses it and it can enqueue nothing — it is a
render-only link every client makes navigable (a chip on web and desktop, an
ordinary link that opens the project on tap on mobile). That is the whole point:
a project reference should never be able to start a run. Use it freely to point
at a project (see the multica-projects-and-resources skill); everything else in
this document is about the four types (plus `all`) the parser does recognize.

## Step 1 — look up the UUID with `--output json`

A name is not a UUID. Look the UUID up first, from the matching list command:

- a person → `multica workspace member list --output json` → use `user_id`
- an agent → `multica agent list --output json` → use `id`
- a squad  → `multica squad list --output json` → use `id`

For a person the mention id is the `user_id`, NOT the membership-row id — the
backend's own roster formatter uses `user_id` for member mentions. Match by
display name. If the name is ambiguous or absent, do not guess — say so in your
comment instead of emitting a broken link.

## Step 2 — the five actionable types and exactly what each enqueues

Format: `[@Name](mention://<type>/<uuid>)`. The `<type>` and the id source must
match, or the link resolves to the wrong entity (or to nothing). This table
covers the five types a comment can use to enqueue work or link an entity
(`agent`, `squad`, `member`, `issue`, `skill`); `@all` is a special broadcast
sentinel covered below, and `project` is a recognized mention type but is
out of scope here.

| To…                  | type     | uuid from       | What the backend does                                    |
| -------------------- | -------- | --------------- | -------------------------------------------------------- |
| trigger an agent     | `agent`  | agent.id        | enqueues a run for that agent (`EnqueueTaskForMention`)  |
| hand work to a squad | `squad`  | squad.id        | resolves the squad's `leader_id` and enqueues a run for the LEADER agent |
| link a person        | `member` | member.user_id  | renders a link; enqueues NOTHING — no agent run          |
| reference an issue   | `issue`  | issue.id        | renders a link; enqueues NOTHING — always safe           |
| designate an agent   | `skill`  | skill.id        | renders a link; enqueues a run ONLY for each agent the frontend explicitly designated via `skill_mention_agents` (see Step 3). An undesignated skill mention is a silent no-op — the same shape as `member`, but the failure mode is "no designation supplied", not "the type has no runner". |

The mention trigger set is computed by `computeMentionedAgentCommentTriggers`
(`server/internal/handler/comment.go`); the comment path folds that result into
`computeCommentAgentTriggers` and enqueues it via `enqueueCommentAgentTriggers`.
It acts on two types only: the `squad` branch resolves the squad and adds its
leader to the trigger set; everything that is not `agent` after that is skipped
(`if m.Type != "agent" { continue }`), then the `agent` branch adds that agent.
A `member`, `issue`, or undesignated `skill` mention reaches neither branch, so
it enqueues no task.

A `member` or `issue` mention therefore does NOT make a person "run", and this
skill does NOT claim it delivers a notification through the Go comment handler
— there is no such code path in that handler (see the source map). What is
verified is the narrow contract above: only `agent` and `squad` mentions enqueue
work on their own, and `skill` mentions enqueue work ONLY when accompanied by
a non-empty `skill_mention_agents` entry for that skill id.

## Step 3 — @skill mentions are EXPLICITLY designated, never reverse-looked-up

Unlike `agent` / `squad`, an `@skill` mention does NOT carry enough information
in the link itself to pick a runner — the skill has a skill_id, not an agent_id.
The backend therefore relies on the composer to name the agent(s) for every
skill mention in the comment.

The composer carries that map as `skill_mention_agents` (keyed by the skill id
in the mention link, valued as the list of agent ids designated through the
skill's chip picker — a user pick, or, since the composer auto-bind default
(2026-08-18), the applied-by-default recommended agent the user accepts by
dismissing the picker). It is wired through create/edit comment requests and
lands in
`bindAndEnqueueSkillMentions` (`server/internal/handler/comment.go`), which is
called ONLY from the create-time path — never from the read-only trigger
preview, since binding is a side effect.

For each `[@skill](mention://skill/<id>)` in the comment body:

- If the request body's `skill_mention_agents[<id>]` is missing or empty, the
  mention is dropped silently — same shape as an undesignated member mention
  in the parser. The link still renders, nothing fires.
- If the request body's `skill_mention_agents[<id>]` names one or more agents,
  the backend durably binds each designated agent to the skill via
  `AddAgentSkill` (idempotent — repeat binds are a no-op), then enqueues each
  through the shared trigger pipeline. References and scripts reach the agent
  via the existing bound-skill path with no new delivery plumbing.
- Each designated agent runs through the same gates as a direct `@agent`
  mention: invocable, unarchived, runtime present, no already-pending task on
  this issue. A gate failure reports `invocation_not_allowed`,
  `target_unavailable`, `runtime_offline`, or `internal_error` as a per-agent
  outcome — it never aborts the other designations.
- An implicit path (assignee, reply-parent) that already selected the same
  agent collapses with the skill designation via the shared pending-task helper;
  no agent double-fires from one comment.

CLI does not currently expose a way to author a `skill_mention_agents` map —
that is a composer-only gesture. When it eventually lands, the value must be
the agent's `id` from `multica agent list --output json` (the same field the
direct `@agent` mention uses).

## Step 4 — `@skill` designation on the issue description editor (create + edit)

The same gesture extends to the description editor of the issue creation modal
(manual mode only — agent-mode prompt panel deliberately strips skill chips,
see Scope) and the issue edit-mode description editor. The composer carries
the same `skill_mention_agents` map alongside the request, and the backend
mirrors the comment path's gate set (R15) plus the create/edit-specific
split:

  - the `agent_skill` row is upserted (`UpsertAgentSkillEnabled`, TOCTOU-
    closed, idempotent, enabled=TRUE);
  - each designated agent passes the same gate the comment path uses —
    invocable (`canInvokeAgent`, not `canAccessPrivateAgent` — see-vs-run
    split from MUL-3963), unarchived, runtime-bound. A gate-failed agent
    never binds and never enqueues; it returns a `DispatchBlocked` outcome
    with the same enumeration-safe `reason_code` the comment path uses
    (`ReasonInvocationNotAllowed` for unknown / not-invoke-able /
    cross-workspace, `ReasonTargetUnavailable` for archived, `ReasonRuntimeOffline`
    for missing runtime). A failure does not abort the other designations.

On the **create** path:

  - The `agent_skill` rows for every gate-admitted pair land in the create
    transaction, alongside the issue row and the labels. The post-create
    half (`applyCreateIssueSkillDesignations` in
    `server/internal/handler/issue.go`) then walks the distinct designated
    agents and decides the run outcome:
    - Designation targets the issue's own assignee agent AND the create's
      natural enqueue produced a task (`AssignedTaskID`) → `DispatchMerged`,
      no second enqueue (R7, KTD3). Exactly one run, already carrying the
      skill.
    - Issue is parked in `backlog` → `DispatchBound`, no enqueue (R8). The
      bind stands; the run starts when the issue leaves backlog.
    - A pending (issue, agent) task already exists (natural squad-leader run
      or concurrent duplicate) → `DispatchMerged`, no enqueue.
    - Otherwise → enqueue directly via `EnqueueTaskForMentionWithActor` with
      the creating member as the accountable human (KTD4).

On the **edit** path:

  - The bind is post-commit best-effort, sequenced before any enqueue
    (`bindIssueSkillDesignations` in `server/internal/handler/issue.go`,
    KTD2 edit-side contract).
  - The post-update split (`applyUpdateIssueSkillDesignations`) walks the
    distinct designated agents and decides per the post-update assignee:
    - Designation targets the post-update assignee (the user accepted the
      auto-fill default or explicitly picked the assignee) →
      `DispatchBound`, no run (R9). The skill is pre-installed for
      future runs; nothing fires now.
    - Designation targets a non-assignee agent AND the issue is non-backlog
      AND `SuppressRun` is false → enqueue via
      `EnqueueTaskForMentionWithActor` with the editor as the accountable
      human, producing `DispatchQueued` and stamping a KTD7 handoff note
      (`issueSkillDesignationHandoffNote`).
    - Designation targets a non-assignee agent BUT the issue is `backlog`
      OR `SuppressRun` is true → `DispatchBound`, no run (R11, KTD6). The
      bind stands; the run starts when the issue leaves backlog / the
      suppression is lifted.

The `SuppressRun` flag carries its prior meaning (it already suppresses the
natural assignee enqueue on update) and additionally suppresses
designation-triggered runs on non-assignee agents in this update — the bind
is unaffected (per `_SuppressedDesignatedAgentStillBound` precedent from the
comment path).

The post-create / post-update outcomes are returned to the client on
`IssueResponse.SkillDesignationOutcomes` (a slice of `IssueSkillDesignationOutcome`
with `status` ∈ `queued` / `bound` / `merged` / `blocked` and the same
`reason_code` vocabulary the comment `trigger_outcomes` uses). The same
shape lets the frontend render bind-only / blocked feedback with one toast
component (R13, R16).

CLI does not currently expose `skill_mention_agents` on `multica issue
create` or `multica issue update` either — same CLI gap as the comment
composer, same composer-only-gesture contract. When the flag eventually
lands, the value must be the agent's `id` from
`multica agent list --output json` (same field as the direct `@agent`
mention and as the comment composer).

## Preview and per-comment suppression

Newer clients can call `POST /api/issues/{id}/comments/trigger-preview` before
creating or editing a comment. The preview endpoint uses the same
`computeCommentAgentTriggers` function as create and edit re-triggering, so the
displayed agent chips come from backend rules, not from a client-side
reimplementation.

When previewing an edit, clients may send `editing_comment_id`. The server
validates that the comment belongs to the same workspace and issue, derives or
checks the edit's parent comment context, and excludes only pending tasks whose
`trigger_comment_id` is that same comment. Pending tasks from any other comment
on the issue still dedupe the preview.

When creating or editing a comment, clients may send an optional
`suppress_agent_ids` array. The server still computes the full trigger set
first, then removes those agent IDs as a post-filter. A missing or empty field
preserves the old behavior. A valid UUID that is not in the computed trigger set
is a no-op; a malformed UUID is rejected at the request boundary.

## @all is the broadcast type

`@all` uses the literal `all`, never a UUID:

    [@all](mention://all/all)

It addresses everyone on the issue. It does NOT make any specific agent run.
And it is special at trigger time: a comment that carries an `@all` mention is
treated as a broadcast that SUPPRESSES the issue assignee's automatic
on-comment trigger (and the other implicit routing fallbacks — thread parent /
conversation owner). Use `@all` to announce, not to request work from the
assignee.

`@all` only suppresses those IMPLICIT routes. An EXPLICIT `@agent` / `@squad`
mention in the same comment still fires normally (MUL-5411): a comment reading
`[@all](mention://all/all) heads up — [@Preflight](mention://agent/<uuid>)
please take this` enqueues Preflight and nobody else. Explicit mentions win over
the broadcast; see `computeCommentAgentTriggers` in
`server/internal/handler/comment.go`, where the explicit-mention branch is
evaluated BEFORE the `@all` short-circuit.

## What does NOT happen (so the result doesn't surprise you)

None of these start a fresh run, and none produce an error response — but they
are three different things, and the response tells you which. A mention that
never parsed is a truly silent no-op. One that parsed and was refused comes back
in `trigger_outcomes` as `status: "blocked"` with a `reason_code`. One whose
target is already busy comes back `coalesced` or `deferred`: no second run, but
your comment IS folded into the task that is already running, so it still gets
read. Read that array after posting — it is the only place any of this shows up.

- **A name where a UUID belongs.** `mention://member/Alice` is dead. The id
  group accepts only hex+dashes or `all`; the non-hex letters in a typical name
  make the whole pattern fail to match, so the parser returns nothing.
- **A hex-ish but wrong UUID.** A well-formed-looking UUID that no entity owns
  DOES parse, then no-ops at lookup: the workspace-scoped query finds no agent
  and the mention is reported blocked with `invocation_not_allowed`. That code
  is deliberately ambiguous — **a typo'd UUID and a genuine permission denial
  look identical on purpose**, because the id you typed could name a private
  agent in another workspace and the reason must not confirm that it exists.
  **So when you see `invocation_not_allowed`, check the UUID against the live
  roster BEFORE you touch any visibility or invocation setting** (MUL-5548);
  `multica squad member list <squad-id> --output json` returns the `member_id`
  to build the mention from. An id that matches the pattern but is NOT a valid
  UUID at all (`mention://agent/-`) is rejected by the id parser and blocked
  with `target_unavailable` instead — a non-UUID names no entity anywhere, so
  it conceals nothing. Neither case is ever an error response.
- **An undesignated `@skill` mention.** A `[@Bot](mention://skill/<id>)` with
  no entry (or an empty list) in `skill_mention_agents` for that skill id is
  dropped silently — the parser matched, the link renders, no run is enqueued.
  This is the same shape as a `member` mention, but the cause is "no
  designation supplied", not "skill has no runner" — the skill DOES have
  runners, they just weren't named for this comment. So this is the only
  silent no-op a `@skill` mention can produce, and it is by design: the
  backend never reverse-looks-up the binding table to guess an agent.
- **An already-pending task.** Even a correct `@agent`/`@squad` starts no second
  run when the target already has a pending task on this issue
  (`HasPendingTaskForIssueAndAgent`). This is a fold, not a drop: the comment
  merges into that task and the outcome is `coalesced` (same reviewed head) or
  `deferred` (different head) — do NOT re-post it as "the mention didn't work".
  Edit preview is the only exception: `editing_comment_id` ignores pending tasks
  from the same comment being edited, because save cancels those old tasks
  before it re-computes triggers. It is still comment-scoped, not an agent-wide
  bypass.
- **An archived agent, or one with no runtime bound** (likewise a squad whose
  leader is): blocked with `target_unavailable` and `runtime_offline`
  respectively. Both are checked only AFTER the invoke gate, so a caller who may
  not invoke the target never learns its state.
- **A private agent you cannot invoke:** blocked — the mention path gates on
  `canInvokeAgent` for both `@agent` and `@squad`. That is the *run* gate, not
  the *see* gate: since MUL-3963 a workspace admin who can open a private agent
  in the UI still may not trigger it, so being able to view the target says
  nothing about being able to mention it. (The `canEnqueueSquadLeader` wrapper
  is the squad assignment/promote path, not this one; the child-done wake is
  ungated — see the multica-squads skill.)

One nuance for automation (MUL-4857): when an UNATTRIBUTED autopilot run (a
schedule/webhook dispatch has no human originator, so the A2A gate has no human
to key on) delegates by `@mention` while working on the issue that autopilot
created, the invoke gate falls back to the **autopilot creator** as the effective
invoking user — the same principal that admitted the first dispatch. So a mid-run
`@agent` / `@squad` delegation fires exactly when the autopilot creator could
invoke that target (owner / `public_to` match), and stays skipped otherwise. It
is authorization only — the enqueued run's originator/attribution is unchanged.
This fallback is bound to verified task lineage: it applies only when the
delegating run's own task is the one working on that autopilot issue (author ==
task agent, `task.issue_id` == this issue), so a run doing work elsewhere can
never borrow another autopilot creator's authority by commenting on its issue.
The same authority carries the plain assigned-squad-leader wake (a worker's
result comment on the autopilot issue can still wake the leader), and it survives
a busy target: if the mentioned agent is already running, the delegation is
replayed at that run's completion under the same authority, so it is never lost.
An edit is treated as a fresh action — it re-derives the comment's lineage from
the editing action. Only the agent author editing its OWN comment re-stamps the
lineage to the editing task; any other editor — including a workspace owner/admin
editing an agent's comment — CLEARS it. So editing an old autopilot comment from
an unrelated issue, or an admin editing an agent's comment (manage rights, not
invoke rights), fails closed at the deferred completion-reconcile instead of
reusing the original run's authority.

## Incorrect → Correct

Incorrect: `@alice please review`
  → plain text, no link, parses to nothing, nobody is reached.

Incorrect: `[@Alice](mention://member/Alice) please review`
  → "Alice" is not a UUID; the id group rejects the non-hex letters, the
  pattern does not match, the link is silently dead.

Correct:
  1. `multica workspace member list --output json`  → Alice's `user_id` = 7f3a…
  2. `[@Alice](mention://member/7f3a…) please review`
     → a real `user_id` parses; the link renders and resolves to Alice.

@all broadcast: `[@all](mention://all/all) heads up` — addresses everyone,
runs no specific agent, and suppresses the assignee auto-trigger.

These exact shapes are pinned by a Go behavior test
(`TestMentioningSkillTeachesTheParserContract`) that feeds them through
`util.ParseMentions`: the name form parses to nothing, the real-UUID form
parses, `@all` parses to `{all, all}`, and a wrong `type` with a real UUID
still parses (which is why the type must match the id source).

## References

`references/mentioning-source-map.md` — file:line evidence for the regex, the
comment-path enqueue branches, the issue-path create/edit gate and split
(see the "Issue-path `@skill` designation (create + edit)" section), the @all
suppression, the CLI id-source mapping, and the unified dispatch outcome
contract (DispatchStatus / DispatchReasonCode), plus the explicit note that
no member-notification delivery path exists in the Go comment handler.
