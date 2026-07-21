---
title: "Local customization ledger — tracking divergent commits and upstream PR status"
date: 2026-07-17
last_updated: 2026-07-21
category: "workflow-issues"
module: "git"
problem_type: "workflow_issue"
component: "development_workflow"
severity: "high"
applies_when:
  - "Self-hosted Multica instance tracks upstream and accumulates local customization commits"
  - "One or more customizations were submitted as upstream PRs that are unmerged or rejected"
  - "Before merging a new upstream release, to decide per-customization merge actions"
tags: [local-customizations, upstream-pr, ledger, merge-strategy, self-hosted, drift]
---

# Local customization ledger

> **This is a living document.** Update it whenever you open/close an upstream PR, land a new local customization, or complete an upstream merge. It is the per-customization companion to the merge workflow in `docs/solutions/workflow-issues/safe-upstream-upgrade-with-local-customizations.md` (which covers the *mechanics* of one upgrade; this file tracks *what* you are carrying across all upgrades).

*Audit 2026-07-21:* all tracked PR states unchanged since 2026-07-17 (no new merges/closes); @skill-mention redesign marked **EXECUTED**; registered pure-local build-fix `truncateFallbackCommentBody` (#5455) + `identifier-badge click-to-copy`. **Full v0.4.3→v0.4.6 pre-merge audit completed** — see the "v0.4.3 → v0.4.6 upgrade action list" section below. Headline: one high-conflict commit (`41315989b` editor autolink); readonly mention chips re-apply to the new `rich-content.tsx` (editable face untouched); local main sits at `v0.4.3`, 59 behind / 134 ahead of `origin/main`; 4 known migration duplicate-prefix collisions — **do NOT renumber**. **✅ v0.4.6 upgrade EXECUTED 2026-07-21** (merge `36dbc22ba`, base now `v0.4.6`); see the action list section for actuals vs plan.

## Why this ledger exists

The instance leads upstream `main` by a growing set of commits. Each carries a different merge risk on the next upgrade, and the correct action differs by upstream PR state. Without a ledger, an upgrade resolves every conflict blind — keeping both implementations when upstream adopted a PR differently, or re-porting a fix upstream already shipped. Read the **Action on next merge** column before touching conflicts.

## Status legend

| Status | Meaning | Merge-cost trajectory |
| --- | --- | --- |
| `MERGED` | Upstream shipped the PR. Local commits are now ghosts. | **Eliminate** — take upstream verbatim, drop local version. |
| `OPEN` | Awaiting upstream review. Expect drift; conflicts likely recur. | **Carry** — re-resolve each upgrade; rerere helps. |
| `CLOSED` (by upstream) | Upstream rejected. Code still lives in your commits; will never auto-resolve. | **Own forever** — heaviest burden; minimize file invasiveness. |
| `WITHDRAWN` (by you) | Self-closed, and local code reverted / never merged into `main`. | **None** — no local footprint, no conflict risk. Historical only. |
| `LOCAL` | Never submitted upstream (by choice). | **Own forever** — same as CLOSED. |

> **Verify before classifying.** A `CLOSED` PR is not automatically a burden — check *who* closed it (`gh api repos/multica-ai/multica/issues/<n>/events --jq '.[] | select(.event=="closed") | .actor.login'`) and *whether its code is actually in your leading commits*. Author-closed + reverted = `WITHDRAWN` (no cost); upstream-closed + code present = `CLOSED` (own forever). Misclassifying a withdrawn PR as a live burden inflates your perceived merge cost.

## Active customizations

Ordered by merge risk (highest first). *Files* lists upstream-owned paths most likely to drift — these drive future conflicts. Run the audit in the next section to refresh PR states before each upgrade.

### Mention rendering — the high-conflict cluster

Two open PRs both modify the core mention render path (`packages/views/editor/extensions/mention-view.tsx`, `mention-hover-card.tsx`, `readonly-content.tsx`). Any upstream mention refactor conflicts with **both at once**. Treat this file as the single hottest spot in the repo.

| Feature | PR | Status | Key upstream files | Action on next merge |
| --- | --- | --- | --- | --- |
| MentionType registry + skill mention | [#5346](https://github.com/multica-ai/multica/pull/5346) | OPEN (no review, 3 comments; PR last updated 2026-07-14) | `editor/extensions/mention-suggestion.tsx`, `editor/extensions/mention-view.tsx`, `handler/skill_mention_trigger*.go`, `handler/comment.go`, `handler/handler.go`, `issues/components/comment-trigger-chips.tsx`, `builtin_skills/multica-mentioning/*` | Carry; watch for upstream mention refactors. **Local now leads this PR** — the 7-17 composer-gesture redesign (below) is NOT in the PR. See the @skill gesture note below. |
| Actor mention avatar chips | [#5199](https://github.com/multica-ai/multica/pull/5199) | OPEN (no review) | `editor/extensions/mention-view.tsx`, `editor/mention-hover-card.tsx`, `readonly-content.tsx`, `ui/ActorMentionChip` | Carry; same hot file as #5346 — resolve together. |

> **@skill mention — composer-gesture redesign (EXECUTED 2026-07-17).** Plan: `docs/plans/2026-07-17-001-feat-skill-mention-agent-gesture-plan.md`. The binding-table reverse-lookup was replaced by an **explicit composer gesture**: a `@skill` chip carries a "pick an agent" popover (`packages/views/editor/skill-agent-picker.tsx`, feat `e62cbb40f` U3); on submit the backend durably binds the skill to the designated agent (`AddAgentSkill`, idempotent single-SQL upsert — TOCTOU-closed `fd759a62a`) and enqueues it, so references/scripts ride the normal bound-skill pipeline. `skill_mention_agents` is now the sole skill-routing input, widened to `skill_id → [agent_id]` and capped per-skill + total at the request boundary (`db1fcbf27`). Bind-on-submit is symmetric across CreateComment and UpdateComment edit paths (`a8a799f9e`), draft-persisted across reloads (`65a1ad4d2`), and surfaced in the trigger-preview strip (`3cee62fd2`); `@skill` contract documented in `builtin_skills/multica-mentioning/SKILL.md` (feat `c4ed11891` U4). **No schema migration** — only `server/pkg/db/queries/skill.sql` (sqlc) + generated `skill.sql.go` changed. **Verified hot-file surface (wider than the original plan predicted):** `handler/comment.go`, `handler/handler.go`, `editor/extensions/mention-view.tsx`, `editor/content-editor.tsx`, `issues/components/comment-{input,card,trigger-chips}.tsx`, `reply-input.tsx`, `core/issues/stores/comment-draft-store.ts`, plus new files `editor/skill-agent-picker.tsx`, `editor/skill-mention-context.ts`, `ui/components/common/skill-mention-chip.tsx`, `issues/hooks/use-skill-designated-preview-agents.ts`, `core/issues/comment-trigger-outcomes.ts`. (Plan had listed `use-issue-timeline.ts` + `core/api/client.ts`; neither was touched.) When upstream merges #5346, re-apply only the gesture + bind-on-submit logic on top of upstream's mention render path.

### Open PRs — feature additions

| Feature | PR | Status | Key upstream files | Action on next merge |
| --- | --- | --- | --- | --- |
| Run-comment "View run" affordance | [#5309](https://github.com/multica-ai/multica/pull/5309) | OPEN (no review) | `handler/comment.go`, `migrations/158-160_backfill_comment_source_task_id*`, comments UI | Carry. Upstream `comment.go` is **untouched** in v0.4.3..v0.4.6 — zero conflict this round. The 158/159/160 backfills **collide with upstream's own 158/159/160** — tolerated via the duplicate-prefix lint map, do NOT renumber (see Drift notes). |
| Member display name mgmt (invite + super-admin rename) | [#4118](https://github.com/multica-ai/multica/pull/4118) | OPEN (no review, stale since 06-23) | `cmd_admin.go`, `cmd_workspace.go`, `cmd/multica/main.go`, auth/invitation handlers | Carry; touches CLI + Go handlers — medium conflict rate. |
| skills.sh 2-segment batch import | [#2669](https://github.com/multica-ai/multica/pull/2669) | OPEN (3 reviews — only PR with upstream engagement) | `handler/skill*.go`, `cmd/server/router.go`, `cmd_skill.go`, `core/api/client.ts` | Carry; most likely to merge eventually — re-check first. |
| Adaptive skill discovery (import dialog) | [#5160](https://github.com/multica-ai/multica/pull/5160) | OPEN (no review) | `skills/components/runtime-local-skill-import-panel.tsx`, `locales/*/skills.json` | Carry. **Note:** local base never implemented `data-branch`, so its tests fail pre-existing — see SOP Step 7.5. |

### Adopted upstream — eliminate local version

| Feature | PR | Status | Key upstream files | Action on next merge |
| --- | --- | --- | --- | --- |
| Agents list access-scope column/filter/bulk-edit | [#5393](https://github.com/multica-ai/multica/pull/5393) | **MERGED 2026-07-15** | `agents/components/inspector/access-picker.tsx` (+21 files) | **Drop local commits** (forwardRef→onChange, draft-reset, bulk-dialog fixes are subsumed by upstream's `onChange`+`invocationTargets`). Take upstream verbatim per SOP Step 4.5. Verify no local follow-up still needs to land. |

### Rejected / local-only — own forever

These will never auto-resolve. Keep them as non-invasive as possible; prefer new files over editing upstream files.

| Feature | PR | Status | Key upstream files | Action on next merge |
| --- | --- | --- | --- | --- |
| Runtime build provenance (official baseline in Help menu) | [#5539](https://github.com/multica-ai/multica/pull/5539) | **CLOSED 2026-07-16** | Own file `server/cmd/server/provenance_baseline.go` (zero conflict); `router.go` reduced to a single `ServerVersion:` field line (refactor `8aa05cfb2`); plus `api/client.ts` (2-line) + `help-launcher.tsx` | Own forever. Low-medium invasiveness: logic lives in a dedicated file, only 3 upstream files touched, hottest is `router.go` now down to one line. Recently rejected — confirm intent to keep maintaining locally. |

### Withdrawn — no local footprint (historical)

These PRs were closed **by the author** and their code was never merged into local `main` (or was fully reverted). They are **not** an ongoing merge burden — no conflict risk. Kept here only as history so a future attempt doesn't repeat a dead end.

| Feature | PR | What happened | Re-entry condition |
| --- | --- | --- | --- |
| @project typed mention + cross-workspace cascade | [#5466](https://github.com/multica-ai/multica/pull/5466) | Implemented end-to-end, then **self-closed by chouti 2026-07-15** as unsatisfactory; local changes fully reverted 2026-07-16 (verified: no `@project` / typed-mention trace in `packages/`, `server/`, `apps/`, or leading commits). | Do not resume without re-confirming the approach first (see project memory). |

### Pure-local customizations (never upstreamed)

| Feature | PR | Status | Key upstream files | Action on next merge |
| --- | --- | --- | --- | --- |
| Pin issue comment input to bottom of detail panel | — | LOCAL | `issues/components/issue-detail.tsx` | Own; single hot file — likely recurring conflict. |
| `ActorAvatar` `showName` prop | — | LOCAL | `ui/ActorAvatar.tsx` | Own; upstream refactored ActorAvatar before (v0.3.42) — high drift risk. |
| Issue prefix fallback to slug for non-latin workspace names | — | LOCAL | workspace/prefix logic | Own; small, low conflict. |
| i18n three-dot ellipsis in backend loading copy | — | LOCAL | backend loading copy | Own; trivial. |
| SkillProfileCard compact redesign + frontmatter | — | LOCAL | skills UI components | Own; overlaps #5160 area — resolve together. |
| Issue identifier badge + click-to-copy on detail page | — | LOCAL | `issues/components/issue-identifier-badge.tsx` (new file), `issues/components/issue-detail.tsx`, `locales/*/issues.json` | Own; **shares `issue-detail.tsx` with the pin-comment-input customization** — resolve together on conflicts. Commits `ecd309bb0` / `13a638be8` / `2e009277d`. |
| `truncateFallbackCommentBody` build-fix (fills symbol left dangling by upstream merge `24ea38dcb`; GH [#5455](https://github.com/multica-ai/multica/issues/5455), closed upstream 2026-07-16) | — | LOCAL | own new file `server/internal/service/fallback_comment_truncate.go` (24 lines, zero conflict) | Own; **duplicate-symbol risk** — if upstream later ships its own impl of `truncateFallbackCommentBody` / `maxSynthesizedFallbackCommentRunes`, this new file redeclares them and breaks the package build. On next merge, `grep` upstream for the symbol first; if defined, drop the local file and take upstream's. |

## Pre-merge audit (run before every upstream merge)

Refresh this table, then apply the **Action** column. This is the ledger-driven version of SOP Step 4.5.

```bash
# 1. Refresh PR states
gh pr list --repo multica-ai/multica --author chouti --state all --limit 60 \
  --json number,title,state,mergedAt \
  --jq '.[] | "#\(.number)\t\(.state)\t\(.mergedAt // "-")\t\(.title)"'

# 2. For any newly-MERGED PR: take upstream's files verbatim, drop local version
gh pr view <num> --repo multica-ai/multica --json files --jq -r '.files[].path' \
  | xargs git checkout <tag> --

# 3. Confirm the local ghost commits are gone from the diff
git diff <tag>..HEAD -- <path>   # expect only deliberate deltas, not redundant fix-trail
```

## Drift notes & gotchas

- **Migration numbering — duplicate-prefix collisions are tolerated, do NOT renumber.** Local carries **4 known duplicate-prefix collisions** (each number has two unrelated files): `119` (`invitation_invitee_name` [#4118] vs upstream `user_created_at_index`), `158`/`159`/`160` (#5309 `backfill_comment_source_task_id*` vs upstream `agent_task_queue_chat_input_task_id` / `chat_message_message_kind` / `chat_message_input_owner_index`). These are **accepted legacy state**, tolerated via the `duplicate-prefix migration map` fixture in `server/internal/migrations/migrations_lint_test.go`. **Fixed 2026-07-21 (eval-found bug):** the map previously listed only up to `119`/`128`, so `TestMigrationNumericPrefixesStayUniqueAfterLegacySet` was **failing red** on `158`/`159`/`160` — the three were added to `legacyDuplicateMigrationStems` (their stems), test now passes. Found by a skill-eval baseline, confirmed by running the test; the earlier claim "158-160 tolerated via the map" was wrong. **Do not renumber** — the migrations are already applied and recorded in `schema_migrations`; renumbering breaks the version trail on a running instance. Upstream v0.4.6 adds only `202_runtime_profile_add_qwen` (local head is `201`) — **no new collision this upgrade**. Maintain the lint map if upstream changes the migration lint mechanism. No DB foreign keys; concurrent indexes in single-statement files (repo hard rules).
- **Locale files.** `packages/views/locales/*/{skills,issues}.json` are touched by several features (#5160, #2460) and by upstream constantly. Conflicts are frequent but trivial — take both key sets.
- **The mention cluster is the recurring cost.** If upstream ever lands a native mention-chip system, expect to drop #5199 and #5346 together and re-apply only the skill-mention gesture + bind-on-submit logic on top of upstream's version. **v0.4.6 status (audited 2026-07-21): that precondition has NOT occurred** — upstream `5a11232c4` is a *renderer move* (hollows `readonly-content.tsx`, relocates read-only render to the new `packages/views/rich-content/rich-content.tsx`), not a native mention system; the `project-mention-a11y.test.tsx` in the new dir is just an a11y fix (`<span onClick>` → `<AppLink>`), not a chip system. So this round: re-apply the readonly chips into `rich-content.tsx` (the editable face — `mention-view.tsx` etc. — is untouched by upstream). The shared hot file is `packages/views/editor/extensions/mention-view.tsx`; the 7-17 @skill redesign widened the cluster's surface further into `content-editor.tsx`, `comment-input.tsx`, `comment-draft-store.ts`, and several new gesture files (see the redesign note under the mention cluster table, and the v0.4.6 action list below).
- **Rejected features compound silently.** #5539 was closed by upstream (2026-07-16) yet its code still lives in your leading commits — a rejected feature you forget about still drifts and still costs merge time. Track upstream rejections here the moment they happen. (Contrast #5466: self-withdrawn and fully reverted, so it carries **no** local footprint — see the Withdrawn table.)
- **The `'project'` token in `MENTION_MARKUP_SOURCE` is NOT a #5466 revival.** `a75305c27` (skill-mention cluster) added `'project'` to the markup-source enum purely for backend parity/completeness — there is no `@project` UI and no typed-mention code behind it. A future reviewer grepping `'project'` may misread it as #5466 (withdrawn @project typed mention) coming back. It is not; do not "clean it up" by removing it.

## v0.4.3 → v0.4.6 upgrade action list (audited 2026-07-21)

> ✅ **EXECUTED 2026-07-21** — merge `36dbc22ba`, base now `v0.4.6-145-g36dbc22ba`. Actuals vs plan: only 7 conflicts (the predicted high-conflict `41315989b` cost just comment-input/reply-input at 1 hunk each — content-editor/issue-detail/comment-card all auto-merged clean); readonly actor+skill chips re-applied to `rich-content.tsx` in one edit; 2 post-merge type fixes (file-viewer unused `SkillFrontmatter` import; provider-logo `qwenLogo` via `as unknown` matching the in-file `antigravityLogoSrc` pattern); `migrate up` applied only `202` (119/158/159/160 collisions unchanged); services restarted via `go run` + `pnpm dev:web`. Verification green: typecheck (6) / go build / pnpm test (2887) / pnpm build (3); frontend `/` → 200, backend `/healthz` → 200. DB backed up at `~/multica-backups/v0.4.6-pre-migrate-*.dump`. **Skipped:** `make test` / `make start` — both call `ensure-postgres.sh` which needs Docker, unavailable on this Homebrew-pg self-host. The plan below is kept for the record.

Pre-merge audit for the next upgrade. Local `main` sits at `v0.4.3` (`git describe --tags`); upstream is at `v0.4.6` — 59 commits behind / 134 ahead of `origin/main`. Overall difficulty is **far below the v0.3.42 ActorAvatar refactor** (that was 35 commits / 50+ files): one high-conflict commit, three big Go customizations untouched. Strategies A/B/C/D per SOP Step 4. Sourced from a 3-agent fan-out audit plus independent verification.

### Workload concentration — the one real cost center

| Commit | What it does | Local hot files hit | Strategy | Difficulty |
| --- | --- | --- | --- | --- |
| **`41315989b`** fix(editor): prevent incorrect comment autolinks | Refactors `ContentEditor` `defaultValue` → `defaultValue\|value` union; renames `lastDefaultValueRef`→`lastSyncedValueRef` | `content-editor.tsx`, `issue-detail.tsx`, `comment-card.tsx`, `comment-input.tsx`, `reply-input.tsx` (all carry local @skill / pin / identifier-badge changes) | **C + D** | **High** |
| `content-editor.tsx` (three-way) | — | hit by `5a11232c4` (preprocess call) **+** `41315989b` (signature) **+** local #5346 (+58 gesture) | three-way manual merge | High |

### Mention cluster — readonly re-apply (decision 2026-07-21: re-apply, strategy C)

Upstream `5a11232c4` "unify Chat and Issue/Comment on one RichContent renderer" **hollows out `readonly-content.tsx` (556 → ~40-line wrapper)** and moves read-only render into the new `packages/views/rich-content/rich-content.tsx`. The blow is **narrower than feared** — it hits only the **readonly face**; the editable face (`mention-view.tsx`, `mention-hover-card.tsx`, `skill-agent-picker.tsx`, `comment-trigger-chips.tsx`) is **zero-touched** by upstream.

- **Renderer move, NOT a native mention system** (see Drift notes). Re-apply both readonly chips in ONE edit to `rich-content.tsx`'s `RichLink`: restore the actor-chip dispatch (deleted `readonly-content.tsx:297-320` → `MentionHoverCard` + `ActorMentionChip`) and the skill-chip branch (deleted `:321-338` → `MentionHoverCard` + `SkillMentionChip`). Resolve #5199 and #5346 together — same code site.
- The chip components themselves survive upstream untouched.
- **Caveat:** upstream's static `COMPONENTS` map is deliberately anti-fork ("no second render branch"); re-introducing a branch is architecturally tense and will recur every RichContent refactor. Decision: re-apply anyway to keep full readonly UX.
- **Mechanical must-do:** `preprocessMarkdown` signature became required `{ cdnDomain: string; ... }`. Patch the 3 call sites — `readonly-content.tsx:511` (will move with the renderer), `content-editor.tsx:442`, `content-editor.tsx:617`. No other call sites exist (`grep -rn "preprocessMarkdown(" packages/` confirmed).

### Untouched by upstream — strategy B, keep as-is

The three heaviest local Go customizations are **zero-conflict**: `comment.go` (@skill + #5309, +456 lines), `skill.go` / `cmd_skill.go` / `skill.sql` (#2669), admin/invitation handlers (#4118). Upstream's 59 commits do not touch them.

### router.go — strategy D (orthogonal)

Local 3 edits (provenance `officialBaseline`, `/api/admin` group, `/import/batch`) vs upstream 3 new routes (`/query` from `002ea0d87`, `/cron-preview` from `465546b83`, `/gc-check` from `18d41151e`) sit in **different route groups** — git will likely auto-merge or need minimal manual touch.

### Migrations — DO NOT renumber (see Drift notes)

Upstream adds only `202_runtime_profile_add_qwen`; local head is `201`. No new collision. Local's 4 known duplicate-prefix collisions (119/158/159/160) stay tolerated via the lint fixture.

### Secondary conflicts (low–medium)

- `002ea0d87` configurable issue table view (6000+ lines): ~90% of files have zero local footprint; hotspots are `router.go` one route (D), `client.ts` different methods (D), `mutations.ts` per-line (C). Medium.
- `f8bf6cd8b` Qwen runtime: `packages/core/types/agent.ts` is also locally touched (#5309 type sync) — per-line (C). Medium. Also brings the `202` migration (no collision).
- `ce1530049` agent working-chip colour tiers: local untouched in the hit files (`button.tsx`, `workspace-agent-working-chip.tsx`, etc.); only `issues.json` overlaps → take-both (B). Low.
- locales (`issues.json` / `editor.json` × several commits): trivial, keys don't overlap → take-both (B). Watch `002ea0d87`'s `issues.json` +68-line nested object — merge keys at the same level, don't drop local skill keys into a new upstream object.

### Ledger corrections applied in this audit

- Drift-note migration section rewritten (was stale "#5309 carries 158/159/160/166-168, renumber").
- Drift-note mention section: added "renderer move, not native mention" clarification.
- Registered previously-untracked `identifier-badge click-to-copy` (Pure-local table).
- Added `'project'` token anti-misread note (Drift notes).

## Related

- `docs/solutions/workflow-issues/safe-upstream-upgrade-with-local-customizations.md` — the per-upgrade merge mechanics this ledger feeds into.
- `docs/solutions/workflow-issues/upstream-api-divergence-cherry-pick-port.md` — why an upstream API change turns a trivial carry into a re-port.
- `docs/solutions/workflow-issues/unapplied-migrations-after-upstream-upgrade.md` — post-merge migration renumber/apply step.
