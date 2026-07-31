---
title: "Local customization ledger — tracking divergent commits and upstream PR status"
date: 2026-07-17
last_updated: 2026-07-30
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

*Audit 2026-07-31:* all tracked PR states unchanged since 2026-07-17 (no new merges/closes); **✅ v0.4.14 → v0.4.15 upgrade EXECUTED 2026-07-31** (merge `6f21b01a0`, base now `v0.4.15`); 8 manual + 2 rerere + 0 semantic + ~30 type-scale fork-only cleanup; **zero new migration, zero backend conflict**; ledger stale `data-branch` note for #5160 refuted and removed. Per-file strategy, verified negative claims (17: 16 confirmed + 1 refuted), and actuals-vs-plan live in `docs/upgrades/v0.4.15-plan.md` (see "Last upgrade").

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

> **@skill mention — bind-run decoupling (EXECUTED 2026-07-24).** Plan: `docs/plans/2026-07-24-001-fix-skill-mention-bind-decouple-plan.md`. Reverses review finding #4 ("bind-without-run weapon"): `bindDesignatedSkillsForTriggers` no longer filters on `source == mention_skill`, so an agent the implicit path already selected (and which the R5 dedup therefore kept in place of the skill duplicate) is STILL bound to the designated skill — bind is decoupled from which trigger source runs the agent (CONCEPTS.md "Skill Mention Gesture"). Triggered by YUP-407: a `@skill` designation on an already-active conversation agent silently failed to bind, because dedup rewrote the trigger's source to implicit and the bind then skipped it. Frontend trigger-preview (`use-comment-trigger-preview.ts`) now surfaces the designation row when an agent is both implicit and skill-designated, so the chip reflects "will run carrying the skill" (R5). Hot files: `handler/comment.go` (`bindDesignatedSkillsForTriggers`, `triggerTasksForComment` comments), `handler/skill_mention_trigger_test.go` (renamed `_NoBindWithoutRun` → `_BindsDespiteDedup`, assertion reversed 0→1; added `_SuppressedDesignatedAgentStillBound`), `issues/hooks/use-comment-trigger-preview.ts`, `issues/hooks/use-skill-designated-preview-agents.ts`. **R6 (forced-skill prompt callout) deferred** — needs a cross-layer handler→task→daemon→prompt signal for the designated skill; tracked in the plan's Scope Boundaries.

> **@skill mention / autopilot authority — known pre-existing test failures (RESIDUAL, 2026-07-24).** `go test ./server/internal/handler/` on self-host reports 7 pre-existing failures unrelated to finding #4: `TestAutopilotDelegationAuthority_LineageBinding`, `TestClaimTask_ManualRetryReusesWorkdir`, `TestCreateComment_AutopilotLeaderMentionEnqueuesPrivateWorker`, `TestCreateComment_AutopilotWorkerResultWakesSquadLeader`, `TestEnqueueSkillMention_NoDesignationIgnoresAssignee`, `TestReconcileCommentsOnCompletion_AutopilotDelegationRestoresAuthority`, `TestUpdateComment_AutopilotAuthorityReStampedToEditingTask`. Verified **not** a v0.4.9 regression (same fail list in v0.4.8 worktree). Most likely cause: tests assume self-host's production-DB-like seed history that the fresh-migrated test DB (`:5432`) doesn't carry — failure path centers on `autopilotDelegationAuthority` lineage lookup via `comment.source_task_id`. **NoDesignationIgnoresAssignee** also reflects the R4 silent-not-suppressive design (see `comment.go:2260-2264`) clashing with a stale test expectation. Documented in plan as **Pre-existing Test Failures (Residual)**. Not in scope for any current plan; treat as separate bug if pursued.

### Open PRs — feature additions

| Feature | PR | Status | Key upstream files | Action on next merge |
| --- | --- | --- | --- | --- |
| Run-comment "View run" affordance | [#5309](https://github.com/multica-ai/multica/pull/5309) | OPEN (no review) | `handler/comment.go`, `migrations/158-160_backfill_comment_source_task_id*`, comments UI | Carry. Upstream `comment.go` is **untouched** in v0.4.3..v0.4.6 — zero conflict this round. The 158/159/160 backfills **collide with upstream's own 158/159/160** — tolerated via the duplicate-prefix lint map, do NOT renumber (see Drift notes). |
| Member display name mgmt (invite + super-admin rename) | [#4118](https://github.com/multica-ai/multica/pull/4118) | OPEN (no review, stale since 06-23) | `cmd_admin.go`, `cmd_workspace.go`, `cmd/multica/main.go`, auth/invitation handlers | Carry; touches CLI + Go handlers — medium conflict rate. |
| skills.sh 2-segment batch import | [#2669](https://github.com/multica-ai/multica/pull/2669) | OPEN (3 reviews — only PR with upstream engagement) | `handler/skill*.go`, `cmd/server/router.go`, `cmd_skill.go`, `core/api/client.ts` | Carry; most likely to merge eventually — re-check first. |
| Adaptive skill discovery (import dialog) | [#5160](https://github.com/multica-ai/multica/pull/5160) | OPEN (no review) | `skills/components/runtime-local-skill-import-panel.tsx`, `locales/*/skills.json` | Carry. **Ledger correction (v0.4.15 plan, refuted in audit):** earlier claim that "fork never implemented `data-branch` so its tests fail pre-existing" is stale — HEAD `runtime-local-skill-import-panel.tsx:1115` renders `data-branch={isSummaryMode ? "summary" : "search"}` and tests are consistent. If tests fail, check the search-input-placeholder-in-summary-mode path instead. |
| Add `archived` issue status | [#6106](https://github.com/multica-ai/multica/pull/6106) | OPEN (supersedes #4931) | `migrations/235+236_issue_status_{archived,classifier_functions}` (fork was 213/214, renumbered in PR), `handler/issue*.go`, `issueguard/issue_status.go` (new), `pkg/db/queries/{issue,inbox,project}.sql`, `core/types/issue.ts`, `core/issues/config/status.ts`, `views/issues/components/{status-icon,issues-page,issues-header,issue-detail,table-view}.tsx`, `views/editor/extensions/mention-suggestion.tsx`, `locales/{en,zh-Hans,ja,ko}/issues.json`, **mobile** `components/{ui/status-icon,inbox/detail-label}.tsx` + `lib/{issue-status,format-activity}.ts` | Carry. PR branch `pr/upstream-archived-issue-status` is a clean 12-commit replay onto `origin/main` (no FZG refs, no plan doc, no merge-commit noise) — see `docs/plans/2026-07-24-002-feat-archived-issue-status-plan.md` for the original design. Migration renumbered 213/214→235/236 on the PR branch (234 was taken by upstream mid-PR); **local fork still uses 213/214** (do NOT renumber local — see Drift notes + `project_fork_213_214_migration_collision`). Also carries a `feat(mobile)` parity commit (4 `Record<IssueStatus>` maps). All 9 CI checks green on 2026-07-29. Supersedes upstream #4931 (Jonamora91, 0-review). On MERGED → `Adopted upstream` and drop local `213/214` in favor of upstream's landed numbers. |

### Adopted upstream — eliminate local version

| Feature | PR | Status | Key upstream files | Action on next merge |
| --- | --- | --- | --- | --- |
| Agents list access-scope column/filter/bulk-edit | [#5393](https://github.com/multica-ai/multica/pull/5393) | **MERGED 2026-07-15** | `agents/components/inspector/access-picker.tsx` (+21 files) | **Drop local commits** (forwardRef→onChange, draft-reset, bulk-dialog fixes are subsumed by upstream's `onChange`+`invocationTargets`). Take upstream verbatim per SOP Step 4.5. Verify no local follow-up still needs to land. |

### Rejected / local-only — own forever

These will never auto-resolve. Keep them as non-invasive as possible; prefer new files over editing upstream files.

| Feature | PR | Status | Key upstream files | Action on next merge |
| --- | --- | --- | --- | --- |
| Runtime build provenance (official baseline in Help menu) | [#5539](https://github.com/multica-ai/multica/pull/5539) | **CLOSED 2026-07-16** | Own file `server/cmd/server/provenance_baseline.go` (zero conflict); `router.go` reduced to a single `ServerVersion:` field line (refactor `8aa05cfb2`); plus `api/client.ts` (2-line) + `help-launcher.tsx` | Own forever. Low-medium invasiveness: logic lives in a dedicated file, only 3 upstream files touched, hottest is `router.go` now down to one line. Recently rejected — confirm intent to keep maintaining locally. **Upgrade gotcha:** `main.version` defaults to `"dev"`; `officialBaseline` maps dev/describe-suffix → `""`, so a backend started without `-ldflags "-X main.version=<clean-tag>"` shows "version unavailable" in Help. Re-stamp on every upgrade (frontend `.env NEXT_PUBLIC_APP_VERSION` too). See memory `project-version-stamp-on-upgrade`. |

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
| `truncateFallbackCommentBody` build-fix (fills symbol left dangling by upstream merge `24ea38dcb`; GH [#5455](https://github.com/multica-ai/multica/issues/5455), closed upstream 2026-07-16) | — | LOCAL | own new file `server/internal/service/fallback_comment_truncate.go` (24 lines, zero conflict) | Own; **duplicate-symbol risk** — if upstream later ships its own impl of `truncateFallbackCommentBody` / `maxSynthesizedFallbackCommentRunes`, this new file redeclares them and breaks the package build. On next merge, `grep` upstream for the symbol first; if defined, drop the local file and take upstream's. **Import-gap risk (materialized v0.4.12, 2026-07-28):** moving the symbol out of `task.go` also stripped `import "unicode/utf8"` from task.go (unused after the move). Upstream MUL-5268 later added a *similar but not same-named* `utf8.RuneCountInString` guard in task.go:4435 → merge broke `go build` (`undefined: utf8`), 0 text conflict — fixed by re-adding the import. **Lesson: when a local move strips an import, grep upstream's new additions in that file for the import's package symbols before assuming clean; `go build` is the only reliable catcher.** |
| Self-host production deploy (standalone frontend + launchd-supervised backend/frontend) | — | LOCAL | new dir `scripts/selfhost/` (5 files: `build-frontend.sh`, `run-backend.sh`, `install.sh`, `com.fengzhao.multica-{frontend,backend}.plist`) | Own forever; **pure addition, zero upstream conflict** (no upstream file touched). After upgrade: re-run `bash scripts/selfhost/install.sh` to rebuild the standalone frontend + `-ldflags`-stamped backend binary and reload the launchd jobs. **Gotcha:** the live plists (`~/Library/LaunchAgents/com.fengzhao.multica-*.plist`) and `/opt/homebrew/etc/Caddyfile` are host-level, outside this repo — back them up separately (dotfiles); `install.sh` re-deploys the plist templates but does not touch the Caddyfile. See `docs/solutions/runtime-errors/caddy-standalone-launchd.md`. Commits `890ac42d8` / `ae4d21bde`. |

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

- **Migration numbering — duplicate-prefix collisions are tolerated, do NOT renumber.** Local carries **6 known duplicate-prefix collisions** (each number has two unrelated files): `119` (`invitation_invitee_name` [#4118] vs upstream `user_created_at_index`), `158`/`159`/`160` (#5309 `backfill_comment_source_task_id*` vs upstream `agent_task_queue_chat_input_task_id` / `chat_message_message_kind` / `chat_message_input_owner_index`), **`213`/`214`** (fork archived-status `issue_status_archived` / `issue_status_classifier_functions` [FZG-340-343] vs upstream `task_usage_authoritative_cost` / `chat_session_project`). These are **accepted legacy state**, tolerated via the `duplicate-prefix migration map` fixture in `server/internal/migrations/migrations_lint_test.go`. **213/214 added 2026-07-27 (v0.4.11 upgrade, merge `185d446d8`):** fork landed archived-status migrations 213/214 ahead of the release; upstream v0.4.10/11 independently reached 213-223 and self-renumbered (commits `3f2e1c68d`, `be7c3521a`), landing on 213_task_usage/214_chat_session. The fork's `213_task_usage`/`214_chat_session`/`215`-`223` are **byte-identical** to upstream's (fork had cherry-picked those same upstream commits ahead of release — MUL-5228/3772, #5868/#5883), so they merged clean and live `schema_migrations` already matches final numbering. **Earlier fix 2026-07-21 (eval-found bug):** the map previously listed only up to `119`/`128`, so `TestMigrationNumericPrefixesStayUniqueAfterLegacySet` was **failing red** on `158`/`159`/`160` — the three were added to `legacyDuplicateMigrationStems` (their stems), test now passes. **Do not renumber** — the migrations are already applied and recorded in `schema_migrations`; renumbering breaks the version trail on a running instance. Maintain the lint map if upstream changes the migration lint mechanism. No DB foreign keys; concurrent indexes in single-statement files (repo hard rules). **v0.4.12 (2026-07-28):** upstream added **224-230** (lark media ingest MUL-4934 + daemon codex gate MUL-5305), all > fork max 223 → **no new collision**; the 6 known collisions (119/158/159/160/213/214) stand unchanged; DB migrated 7. **v0.4.13 (2026-07-29):** upstream added **231-232** (`agent_task_queue_terminal_completed_at_index` + `channel_media_pending_object_due_index`, both `CREATE INDEX CONCURRENTLY`), all > fork max 230 → **no new collision**; the 6 known stand; DB migrated 2.
- **Locale files.** `packages/views/locales/*/{skills,issues}.json` are touched by several features (#5160, #2460) and by upstream constantly. Conflicts are frequent but trivial — take both key sets.
- **The mention cluster is the recurring cost.** If upstream ever lands a native mention-chip system, expect to drop #5199 and #5346 together and re-apply only the skill-mention gesture + bind-on-submit logic on top of upstream's version. **v0.4.6 status (audited 2026-07-21): that precondition has NOT occurred** — upstream `5a11232c4` is a *renderer move* (hollows `readonly-content.tsx`, relocates read-only render to the new `packages/views/rich-content/rich-content.tsx`), not a native mention system; the `project-mention-a11y.test.tsx` in the new dir is just an a11y fix (`<span onClick>` → `<AppLink>`), not a chip system. So this round: re-apply the readonly chips into `rich-content.tsx` (the editable face — `mention-view.tsx` etc. — is untouched by upstream). The shared hot file is `packages/views/editor/extensions/mention-view.tsx`; the 7-17 @skill redesign widened the cluster's surface further into `content-editor.tsx`, `comment-input.tsx`, `comment-draft-store.ts`, and several new gesture files (see the redesign note under the mention cluster table, and `docs/upgrades/v0.4.6-plan.md`).
- **Rejected features compound silently.** #5539 was closed by upstream (2026-07-16) yet its code still lives in your leading commits — a rejected feature you forget about still drifts and still costs merge time. Track upstream rejections here the moment they happen. (Contrast #5466: self-withdrawn and fully reverted, so it carries **no** local footprint — see the Withdrawn table.)
- **The `'project'` token in `MENTION_MARKUP_SOURCE` is NOT a #5466 revival.** `a75305c27` (skill-mention cluster) added `'project'` to the markup-source enum purely for backend parity/completeness — there is no `@project` UI and no typed-mention code behind it. A future reviewer grepping `'project'` may misread it as #5466 (withdrawn @project typed mention) coming back. It is not; do not "clean it up" by removing it.

## Last upgrade — v0.4.14 → v0.4.15 (EXECUTED 2026-07-31)

✅ **EXECUTED 2026-07-31** — merge `6f21b01a0`, base now `v0.4.15`. Clean merge-base `v0.4.14`, 27 upstream commits. **8 手动冲突 + 2 rerere + 0 auto-merge 语义修复 + ~30 处 type-scale fork-only 文件清理**。

Resolved: **mention-hover-card.tsx** modify/delete — keep fork deletion（fork 已搬到 `views/editor/mention-hover-card.tsx` 含 profile-card dispatch，#5199）+ 手动 port upstream token（text-sm→text-body）到新位置；**mention-view.test.tsx** add/add — union fork skill-gestion suite(297 行) + upstream MUL-5456 modifier-click suite(171 行)，upstream `renderMention` 改名 `renderMentionWithAdapter` 避与 HEAD 冲突，2 调用点更新；**issue-detail.tsx** 2 blocks + **board-card/list-row** (rerere 验证非 stale) — 全取 HEAD `formatProgressText(...)` + 采纳 `text-micro`；**issues-page.tsx** 取 HEAD archived 空态重构 `renderEmpty`→`IssuesEmptyState`；**members-tab.tsx** 保 fork #4118 `invitee_name` 行 + 采纳 token；**runtime-local-skill-import-panel.tsx** 保 fork #5160 `data-branch`+条件搜索 + `text-body`；**file-viewer.tsx** Strategy A 取 upstream MUL-5443 掏空版（新 mode/readOnly API），fork `skill-detail-page.tsx` auto-merge 已用新 API 不用重接；**selfhost-config.test.sh** add/add keep-ours（provenance no-dev 块）+ graft upstream `MULTICA_PUBLIC_URL` 块。

**type-scale fork-only 清理（~30 处）：** MUL-5451 role-named type scale 重构横扫 views+ui，upstream 已全迁 fork-overlap 区，但 **fork 独有文件**（actor-mention-chip/skill-mention-chip/user-management-page/skill-agent-picker/skill-profile-card/skill-mention-context 的 import-panel）+ mention-suggestion 的 `text-xs`/`text-sm`/`text-[11px]`/`text-[10px]`/`text-xl` 是 merge-tree 看不见、typecheck 看不见、**只有 `apps/web/app/type-scale.test.ts` 守卫能抓** 的「auto-merge 干净 ≠ 语义正确」。BSD sed 不支持 `\b` 词边界（前批替换无效），改 `[[:>:]]`/空格界定后全清。

**Headline — zero new migration, zero backend conflict.** v0.4.15 在 `server/migrations/` 零新增，max 仍 234，**migrate 是 no-op**；6 已知撞号（119/158/159/160/213/214）完好。后端零冲突：upstream handler/auth/admin 零触碰，task.go duplicate-symbol 确认未复发（upstream task.go byte-identical v0.4.14↔v0.4.15，三方合并采纳 fork 无符号版；merged tree 全包扫 `func truncateFallbackCommentBody` 定义 = 1，sole 在 `fallback_comment_truncate.go` cap=200）。

**【非阻塞 watch-item】task.go 死代码分歧：** 合并后 task.go 调用点直接 `redact.Text(body)` 不做截断，fork 200-rune cap 变死代码（仅自测覆盖），与 upstream 8000-rune-cap 路径行为不同——延续 v0.4.13 悬而未决的 cap 8000 产品问题。本轮不动，fork owner 决断 keep/re-wire/drop。

**Deploy (Phase 6) executed:** pg_dump 备份 pg17：`~/multica-backups/v0.4.15-pre-migrate-20260731-113224.dump`；migrate up no-op（0 应用，全 skip）；版本 re-stamp：先 commit merge `6f21b01a0`（`git describe`→`v0.4.15-258-g...`）→ `.env NEXT_PUBLIC_APP_VERSION=v0.4.15` → `install.sh` 全量 rebuild standalone frontend + ldflag backend + reload plists（FIXED 缺陷后裸跑安全）；health check backend `/healthz` 200（attempt 1）、frontend `/` 200、`/api/config server_version=v0.4.15`。

**Calibration (actuals vs audit prediction):** merge-tree 预测 10 冲突（含 issue-detail 双块计 2）；实际 8 手动（rerere 吸收 board-card/list-row）+ 0 语义错误 + ~30 处 type-scale 后续清理。**文本预测准**；type-scale fork-only 清理是**新变量**——之前审计只验「MUL-5451 对 overlap 区纯机械」，未料 fork 独有文件违反 design system 不变量。**教训：未来 type-scale 类重构审计需扫 fork 独有文件清单 + 验证 type-scale.test.ts 守卫。**

The full per-file strategy, verified negative claims（17 条：16 confirmed + 1 refuted ledger stale 注记）, and Phase-by-Phase record:

→ **`docs/upgrades/v0.4.15-plan.md`** (frontmatter `upgrade_contract: selfhost-upgrade/v1`, `phase: done`)

## Related

- `docs/solutions/workflow-issues/safe-upstream-upgrade-with-local-customizations.md` — the per-upgrade merge mechanics this ledger feeds into.
- `docs/solutions/workflow-issues/upstream-api-divergence-cherry-pick-port.md` — why an upstream API change turns a trivial carry into a re-port.
- `docs/solutions/workflow-issues/unapplied-migrations-after-upstream-upgrade.md` — post-merge migration renumber/apply step.
