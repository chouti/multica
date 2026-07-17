---
name: multica-mentioning
description: "Use when an issue comment needs to @mention someone — link to a person, trigger another agent, hand work to a squad, broadcast with @all, or designate an agent via @skill. Documents the verified mention contract: how a mention link is built from a real UUID, the five mention types and exactly what each one enqueues (agent → a run for that agent, squad → a run for the squad leader, member and issue → a rendered link with NO run, skill → a run ONLY for agents the frontend EXPLICITLY designated in `skill_mention_agents`; undesignated skill mention = silent no-op), comment preview/suppression, the @all broadcast and assignee-trigger suppression, and the silent no-op cases (bad name, bad UUID, undesignated @skill, already-pending, archived, inaccessible). This skill is the backend contract only, traced to server/internal/util/mention.go and server/internal/handler/comment.go."
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
in the mention link, valued as the list of agent ids the user picked from the
skill's chip UI). It is wired through create/edit comment requests and lands in
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
And it is special at trigger time: in `commentMentionsOthersButNotAssignee`
(`server/internal/handler/comment.go`), a comment that carries an `@all`
mention is treated as a broadcast that SUPPRESSES the issue assignee's
automatic on-comment trigger. Use `@all` to announce, not to request work from
the assignee.

## What does NOT happen (so the result doesn't surprise you)

These are all silent no-ops — no error, no run:

- **A name where a UUID belongs.** `mention://member/Alice` is dead. The id
  group accepts only hex+dashes or `all`; the non-hex letters in a typical name
  make the whole pattern fail to match, so the parser returns nothing.
- **A hex-ish but wrong UUID.** A well-formed-looking UUID that no entity owns
  DOES parse, then no-ops at lookup: the workspace-scoped query finds no agent
  and the loop `continue`s. Same agent-visible result (nothing fires), but the
  mechanism is the lookup miss, not a parse failure.
- **An undesignated `@skill` mention.** A `[@Bot](mention://skill/<id>)` with
  no entry (or an empty list) in `skill_mention_agents` for that skill id is
  dropped silently — the parser matched, the link renders, no run is enqueued.
  This is the same shape as a `member` mention, but the cause is "no
  designation supplied", not "skill has no runner" — the skill DOES have
  runners, they just weren't named for this comment. So this is the only
  silent no-op a `@skill` mention can produce, and it is by design: the
  backend never reverse-looks-up the binding table to guess an agent.
- **An already-pending task.** Even a correct `@agent`/`@squad` is skipped when
  the target already has a pending task on this issue
  (`HasPendingTaskForIssueAndAgent` → `continue`). Edit preview is the only
  exception: `editing_comment_id` ignores pending tasks from the same comment
  being edited, because save cancels those old tasks before it re-computes
  triggers. It is still comment-scoped, not an agent-wide bypass.
- **An archived agent**, or a squad whose leader is archived: skipped
  (`RuntimeID` invalid or `ArchivedAt` set).
- **A private agent you cannot access:** skipped — the mention path gates on
  `canAccessPrivateAgent` directly for both `@agent` and `@squad` (the
  `canEnqueueSquadLeader` wrapper is the squad assignment/promote path, not this
  one; the child-done wake is ungated — see the multica-squads skill).

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
enqueue branches, the @all suppression, and the CLI id-source mapping, plus the
explicit note that no member-notification delivery path exists in the Go
comment handler.
