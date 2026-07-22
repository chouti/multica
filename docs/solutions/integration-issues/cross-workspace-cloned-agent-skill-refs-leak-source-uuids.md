---
title: "Cross-workspace cloned agent/skill references leak source-workspace UUIDs and names"
date: 2026-07-22
category: integration-issues
module: "agents-skills"
problem_type: integration_issue
component: database
symptoms:
  - "~50+ escalation mentions and ID/name references in agent instructions and skill contents silently dangling in 4 non-source workspaces"
  - "mention://agent/<fz-uuid> links in tg/szb/ty/dzzw point to fz agents that do not exist in those workspaces"
  - "A Directors table of 14 agents carrying fz 8-hex UUID prefixes; squad table and routing rules carrying stale/bare names"
  - "穆拉利 (Orchestrator) agent instructions bloated to ~200 lines with the full fz UUID table, vs fz's thin ~56-line version that delegates to the mulally-orchestrator skill"
root_cause: scope_issue
resolution_type: seed_data_update
severity: high
tags:
  - multica
  - mention
  - cross-workspace
  - agent
  - skill
  - localization
  - uuid
  - self-host
  - verification
  - methodology
  - debugging
  - false-positive
related_components:
  - service_object
  - assistant
---

# Cross-workspace cloned agent/skill references leak source-workspace UUIDs and names

## Problem

On a self-host Multica instance with 5 workspaces — 峰照网络 (fz), 图片管家 (tg), 上直播 (szb), 图易AI (ty), 电子政务 (dzzw) — agent and skill configuration had been cloned from fz into the other four. The cloning copied text verbatim, including every embedded UUID and name reference. The result: in tg/szb/ty/dzzw, every cross-agent mention, routing table, and escalation path pointed at entities that exist only in fz and not in the target workspace. All of those references were silently broken.

The core cause is a structural fact about Multica's data model that is easy to miss when bulk-copying content across workspaces:

- **Agents and members are per-workspace entities with independent UUIDs.** The "same" agent (e.g. 穆拉利) in fz and in tg is two different rows with two different `agent_id`s. There is no shared identity across workspaces.
- **Member mentions, by contrast, are keyed by the GLOBAL `user_id`, not by the per-workspace `member.id`.** The backend resolves a member mention via `GetMemberByUserAndWorkspace(user_id, workspace_id)` in `server/pkg/db/queries/member.sql`. So a member mention `mention://member/<user_id>` is already workspace-portable — it does NOT need re-localization, because the same human has the same `user_id` everywhere; the backend joins to the per-workspace member row at read time.
- **Agent mentions use the per-workspace `agent_id`** (`mention://agent/<agent_id>`). These MUST be re-localized when copying, because the fz `agent_id` resolves to nothing in another workspace.

This asymmetry — member IDs are global, agent IDs are local — is the single fact that determines what needs fixing and what must be left alone.

## Symptoms

- **48 broken @穆拉利 escalation mentions** across the fleet (12 master agents × 4 non-fz workspaces), plus one 穆拉利 self-reference per workspace — 52 fz-Mulally-ID references in all. Each master agent's instructions contained an escalation mention of the orchestrator 穆拉利 using fz's `agent_id`, which resolves to nothing in tg/szb/ty/dzzw.
- **A Directors table listing 14 agents** with fz 8-hex UUID prefixes baked into the text — every row pointed at an fz entity.
- **Squad tables and routing rules carrying bare or stale names** that no longer matched any agent in the target workspace.
- **穆拉利's own instructions were ~200-line bloated copies of fz content**, including the full fz UUID reference table — while fz's live version is a thin ~56-line file that delegates to the `mulally-orchestrator` skill. The clones had snapshotted the old, fat version and carried its fz-specific UUIDs everywhere.
- **Member mentions keyed by `member_id`** in the mulally-orchestrator skill resolved to nothing, because the backend looks up members by `user_id`, not `member_id`.

## What Didn't Work

1. **Assuming "the ID exists somewhere in a table" means the reference is valid.** A grep showing the UUID present in the target workspace's data is not proof the mention resolves. The verification must match how the backend actually looks the entity up. For members the backend resolves by `user_id`, not by `member.id` — so confirming "the `member_id` is present" tests the wrong field entirely and gives false confidence. Existence-in-a-table ≠ resolvability-by-this-field.

2. **Copying the fz 穆拉利 instructions as the template.** The cloned copies were based on the bloated ~200-line version with the full fz UUID table, so the template itself was the source of most of the leaked UUIDs. Cloning the thin ~56-line fz version (which delegates to the `mulally-orchestrator` skill) and localizing only the few workspace-specific IDs is far less error-prone than scrubbing a fat copy.

3. **Treating member and agent references uniformly.** They look identical in the mention syntax (`mention://TYPE/UUID`) but have opposite localization semantics. Re-localizing member IDs (wrong — they're global) or skipping agent IDs (wrong — they're local) both produce broken output.

## Solution

The mention format is `[@LABEL](mention://TYPE/UUID)`, produced and parsed by `packages/core/markdown/mention-shortcodes.ts` and `packages/views/editor/extensions/mention-extension.ts`. The `TYPE` segment (`member` vs `agent`) is what decides the localization rule. The fix, applied per target workspace (tg/szb/ty/dzzw):

1. **Replace agent UUIDs per workspace.** For each `mention://agent/<fz-uuid>` and each bare fz agent UUID in tables/routing rules, substitute the corresponding agent's `agent_id` in the target workspace. Match by agent role/name, not by position.
2. **Replace any per-workspace `member_id` with the global `user_id`** so member mentions resolve through `GetMemberByUserAndWorkspace`. Where the text already used `user_id`, leave it untouched.
3. **For 穆拉利 specifically: swap the bloated ~200-line instructions for the thin ~56-line fz version** (the one that delegates to the `mulally-orchestrator` skill), then localize only its workspace-specific IDs. This removes the embedded fz UUID table wholesale instead of editing it line by line.
4. **Append the missing generic sections** — Mention 语法规则 and Reporting Protocol — to 零号机 and 卡尼曼, which were missing them. These sections are workspace-agnostic prose and can be copied verbatim.

## Why This Works

The fix keys each substitution to the backend's actual resolution path rather than to surface similarity. Because member resolution goes through `GetMemberByUserAndWorkspace(user_id, workspace_id)` (`server/pkg/db/queries/member.sql`), a member mention built on the global `user_id` is correct in every workspace with zero per-workspace edits — the backend joins to the local member row at read time. Agent mentions have no such indirection: the `agent_id` in `mention://agent/<id>` is looked up directly, and it is a different value in each workspace, so each one must be rewritten. Swapping 穆拉利 to the thin fz template removes the fz UUID table at the source, so there are fewer leaked IDs to hunt down and the remaining ones are the genuinely workspace-specific values.

### Verification method (the durable technique)

The reliable loop was: **dry-run → count guard → write → independent-dimension verification.**

- **Dry-run** the substitution and print the planned replacements before touching any record.
- **Count guard:** assert the number of replacements matches the expected count (e.g. 48 escalation mentions) before writing. A mismatch means the match rule is wrong — stop and fix the rule, not the data.
- **Write** the changes.
- **Independent-dimension verification:** confirm the fix along a dimension orthogonal to the write. Grep the target workspace for the OLD fz UUIDs and require **0 hits**; separately grep for the NEW target-workspace UUIDs and require they are **present**. Checking both directions catches both "old reference survived" and "new reference never landed."

The counter-intuitive lesson embedded here: **verifying "the ID exists in a table" is not the same as verifying "the backend resolves by that field."** Member references resolve by `user_id`, not `member_id`. A verification that greps for `member_id` (or just confirms the UUID appears somewhere) tests the wrong thing and can pass while the mention is still broken. Always verify against the field the resolution query actually filters on.

## Prevention

- **When cloning agents/skills across workspaces, re-localize by entity type.** Agent references (`mention://agent/<id>`, routing tables, Directors/squad UUID lists) are per-workspace and must be rewritten. Member references keyed by global `user_id` are portable — do not touch them. Make this member-global / agent-local split an explicit checklist item in any cross-workspace copy.
- **Clone from the thin, skill-delegating template, not from a fat snapshot.** For orchestrator agents like 穆拉利, copy the minimal instructions that delegate to the skill (`mulally-orchestrator`) rather than a version with an embedded UUID reference table.
- **Verify resolution, not presence.** After any reference rewrite, confirm the backend's lookup field resolves (old UUIDs → 0 hits, new UUIDs → present), and confirm you're grepping the same field the resolution query uses (`user_id` for members, `agent_id` for agents).
- **Prefer the dry-run + count-guard + independent-dimension loop** for any bulk ID rewrite, so a wrong match rule fails loudly before any record is written.

## Related Issues

- `docs/solutions/ui-bugs/skill-hover-card-shows-uuid.md` — shares the rule "never trust a raw UUID as identity; resolve the canonical workspace-correct identity," but its root cause is within-workspace rendering (a hover card falling back to the raw UUID) rather than cross-workspace reference scoping. Complementary, not duplicative.
- `docs/solutions/ui-bugs/mention-hover-card-inconsistency.md` — mentions member vs agent are distinct profile-card types keyed by userId vs agentId, tangentially reinforcing the member(user_id)/agent(agent_id) identity distinction here.
- `docs/solutions/workflow-issues/run-comment-view-run-button-rollout.md` — has "cross-workspace leakage" monitoring SQL, but that is a migration-backfill data-integrity guard, not mention re-localization.
