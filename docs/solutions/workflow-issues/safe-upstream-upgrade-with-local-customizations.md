---
title: "How to safely upgrade a self-hosted Multica instance with local customizations to a new upstream release"
date: 2026-07-10
last_updated: 2026-07-16
category: "workflow-issues"
module: "git"
problem_type: "workflow_issue"
component: "development_workflow"
severity: "medium"
applies_when:
  - "Self-hosted Multica instance with local customization commits on main"
  - "Upstream releases a new version with breaking API changes (e.g. ActorAvatar refactor)"
  - "Local customizations overlap with upstream feature areas (super-admin, skills, UI components)"
  - "PM2 manages both backend and frontend processes requiring restart after upgrade"
  - "Post-merge dependency mismatches need manual resolution (pnpm install)"
tags: [upstream-upgrade, self-hosted, local-customizations, merge-conflicts, post-merge, pm2, go-frontend, dependency-install]
---

# How to safely upgrade a self-hosted Multica instance with local customizations to a new upstream release

## Context

Self-hosted instances of Multica accumulate local customizations — feature additions, admin tooling, config struct fields, i18n tweaks — that sit on top of the upstream `main`. When upstream releases a new version with breaking changes (such as the v0.3.42 ActorAvatar refactor across 35 commits), the upgrade is not a simple `git pull`. The instance had 43 local customization commits spanning TypeScript UI code, Go backend config, SQL migrations, and test suites. A naive merge would produce dozens of conflicts and, if resolved carelessly, silently drop local work or introduce type errors from mismatched upstream APIs.

This document captures the full upgrade workflow as a repeatable practice, distilling the concrete steps, conflict-resolution strategies, and post-merge adaptation patterns into guidance for future upgrades.

## Guidance

Follow this sequence for every upstream release merge into a customized self-hosted instance. Each step has a specific purpose and must not be skipped.

### Step 1: Create a safety branch

Preserve the current state of `main` so you can always revert to it.

```bash
git branch main-backup-v0.3.42 main
```

This is your emergency rollback. If the merge goes badly, you can `git reset --hard main-backup-v0.3.42` and be exactly where you started.

### Step 2: Stash uncommitted local modifications

Uncommitted changes will block `git merge`. Stash them before starting.

```bash
git stash push -m "pre-upgrade"
```

This typically includes files like `AGENTS.md` with local agent instructions, `.env` overrides, or other working-tree modifications that are not yet committed.

### Step 3: Preview conflicts without committing

Attempt the merge with `--no-commit --no-ff` to see all conflicts without finalizing anything.

```bash
# Fetch latest upstream
git fetch origin

# Attempt merge without committing
git merge origin/main --no-commit --no-ff
```

If the conflicts look too severe or you are not ready, abort cleanly and restore your stash:

```bash
git merge --abort
git stash pop
```

If the conflicts look manageable, list them to understand the scope:

```bash
# List all conflicting files
git diff --name-only --diff-filter=U

# Count total conflicts
git diff --name-only --diff-filter=U | wc -l
```

### Step 4: Resolve conflicts using per-file strategies

Not all conflicts deserve the same resolution approach. Categorize each conflicted file and apply the appropriate strategy.

**Strategy A — Accept upstream for refactored APIs.** When upstream refactored a component you also customized, accept their version and adapt your local code afterward. Do not try to manually merge old size tokens with new ones.

```bash
# Accept upstream version for refactored files
git checkout origin/main -- packages/ui/actor-avatar.tsx
git add packages/ui/actor-avatar.tsx
```

Then update your local features that depend on the old API (see Step 5).

**Strategy B — Keep both for independent customizations.** When local changes and upstream changes touch completely different parts of the same file, combine them.

For example, a Go `Config` struct where you added `SuperAdminEmails` and upstream added LLM-related fields: both sets of fields are independent and should coexist.

```go
// After resolution — both local and upstream additions present
type Config struct {
    SuperAdminEmails []string // local customization
    LLMAPIKey        string   // upstream addition
    LLMBaseURL       string   // upstream addition
    LLMDefaultModel  string   // upstream addition
}
```

**Strategy C — Merge carefully for mixed files.** When both sides touched overlapping logic, read both sides and merge deliberately. Test suites are a common case: keep both test suites.

For `readonly-content.test.tsx`, the merge kept upstream's refactored test structure and appended the local admin-specific test cases. For `workspace.sql`, accept upstream's `DELETE` syntax improvement while preserving local admin queries.

**Strategy D — Orthogonal function-signature merge.** Local and upstream may each extend the same function's signature along independent axes (e.g. local adds a parameter, upstream adds a return value). Preserve both — the merged signature is the union, not either-or. Picking either side drops one set of functionality.

Canonical example: `triggerTasksForComment` in `server/internal/handler/comment.go` — local added a `skillMentionAgents map[string]pgtype.UUID` parameter (#5346, skill mention registry), upstream changed the return type from `error` to `[]CommentTriggerOutcome` (MUL-4525, partial-success response). The merged signature keeps both. Three call sites had to be adapted: pass the new arg AND assign the new return; a closure whose surrounding type now returns outcomes must `return` the call — a missing `return` compiles as a void body, with the type mismatch surfacing only when the closure is invoked downstream (not at `go build`). When NOT to apply: if both sides wanted to occupy the same parameter slot, this is a real conflict requiring a manual merge at that argument, not the orthogonal pattern.

### Step 4.5 — When your local PR was adopted upstream

Before the merge, audit your open local PRs against upstream:

```bash
gh pr list --repo multica-ai/multica --author <your-handle> --state all --limit 50
```

Any `MERGED` entry between your last sync and the new release means upstream shipped a version of your change. For those files, take upstream verbatim rather than porting your local commit on top:

```bash
gh pr view <num> --repo multica-ai/multica --json files --jq -r '.files[].path' | \
  xargs git checkout <tag> --
```

Then verify behavioural equivalence against your local fix's purpose (`git diff <tag>..HEAD -- <path>` should show only deliberate deltas, not redundant fix-trail). Drop the local fix commits; upstream's version often implements them in a cleaner form. Worked case from the v0.3.43 → v0.4.2 upgrade: PR #5393 (`feat(agents): add access-scope column, filter, and bulk edit to agents list`, MERGED 2026-07-14, 22 files) — upstream's `packages/views/agents/components/inspector/access-picker.tsx` uses `onChange` callbacks with `invocationTargets: AgentInvocationTarget[] | undefined`, which subsumes the three local AccessPicker follow-up fix commits on the fork (forwardRef→onChange, draft reset, bulk-dialog responsiveness) that had moved off `forwardRef`+`ref.commit`. No port needed. Skip this step if upstream's merge reverted behaviour you depend on, or if your local PR had follow-up commits that still need to land on top of upstream's version.

### Step 5: Adapt local features to upstream API changes

After resolving conflicts, local features that depended on refactored upstream APIs must be updated. This is critical: **adapt your local code to the new upstream API, not the other way around.**

Concrete patterns from the v0.3.42 upgrade:

```tsx
// BEFORE: numeric size prop (old upstream API)
<AvatarChip size={14} />

// AFTER: token-based size prop (new upstream API, ActorAvatar refactor)
<AvatarChip size="xs" />
```

```tsx
// BEFORE: rounded-square avatar shape
<Avatar shape="rounded-square" />

// AFTER: all avatars are circles per upstream MUL-4277
<Avatar shape="circle" />
```

Update test assertions to match the new behavior. For example, snapshot tests will differ because the rendered avatar DOM changed shape.

### Step 6: Install dependencies

After merge, run dependency installation. Upstream may have added packages to `package.json` that are not automatically installed.

```bash
pnpm install
```

Do not skip this. Missing dependencies cause build failures that are confusing to diagnose. See `docs/solutions/workflow-issues/pnpm-install-after-upstream-merge.md` for the detailed explanation.

### Step 7: Full verification

Run every verification step in order. Do not stop at the first pass.

```bash
# Backend: Go compiles cleanly
cd server && go build ./... && cd ..

# Database: apply any migrations the merge brought in. cmd/migrate reads
# DATABASE_URL (it defaults to localhost:5432/multica:multica — wrong for a
# self-hosted instance on :5433, so pass the value from .env). Confirm the
# run reaches "Done." with no unapplied migrations left; an upstream
# migration-number reshuffle can abort the run midway. See
# docs/solutions/workflow-issues/unapplied-migrations-after-upstream-upgrade.md
cd server && DATABASE_URL="<DATABASE_URL from .env>" go run ./cmd/migrate up && cd ..

# TypeScript: no type errors introduced by the merge
pnpm typecheck

# Unit and integration tests pass
pnpm test

# Frontend builds successfully
pnpm build
```

If any step fails, fix the issue before proceeding. The typecheck step will catch cases where local features still reference removed upstream APIs. The migrate step catches schema drift that would otherwise surface as 500s on endpoints whose queries reference new columns.

**7.5 — Pre-existing test failure disambiguation.** If a post-merge test fails, classify whether the merge introduced it before treating it as a regression:

```bash
git checkout main-backup-<version> -- <source-file>
# keep <test-file> at HEAD (post-merge)
pnpm test <test-file>
```

Still failing with the backup source → the failure is **pre-existing** in your local base (the test was already broken; the merge just surfaced it because you ran the full suite). Pass with backup source + fails with post-merge → **merge-introduced**, port or adapt. Apply per test file, not globally — the source-swap procedure partitions failures into the two buckets in seconds without a full rebase. Worked case: `packages/views/skills/components/runtime-local-skill-import-panel.test.tsx` had 5 failures attributable to the local base (#5160 adaptive skill discovery was never implemented — no `data-branch` attribute), while 4 other failures in `issue-detail.test.tsx` were genuine merge artifacts (official #5403 render overhaul doubled-rendered the issue title across the breadcrumb leaf + main header). Limitation: if the test file itself was modified by the merge, source-only checkout does not isolate the variable — copy the backup test to a scratch path and rerun with both source versions.

**7.6 — Re-stamp the release baseline (or the Help menu lies).** Step 7's `pnpm build` and `go build ./...` do NOT carry the version tag, so after restart the in-app Help menu shows a stale frontend version and "Backend unavailable". Two injection points must be re-stamped by hand (there is no `make upgrade` target in this checkout):

```bash
# Frontend: bump the hard-coded env, then rebuild (NEXT_PUBLIC_* is inlined at build time)
$EDITOR .env   # set NEXT_PUBLIC_APP_VERSION=vX.Y.Z (clean tag, not git describe)
pnpm build

# Backend: stamp main.version via -ldflags, then run the binary (NOT bare go run, which leaves "dev")
BASELINE=$(scripts/resolve-official-baseline.sh)   # emits a clean vX.Y.Z or exits non-zero
go build -C server -o bin/server -ldflags "-X main.version=$BASELINE" ./cmd/server
```

Use the **clean tag** — `git describe` on a checkout past the tag yields `vX.Y.Z-NNN-g<hash>`, and the provenance sanitizer (`officialBaseline`) deliberately maps `dev`, `-dirty`, and describe-suffixed values to empty, which `omitempty` drops from `/api/config`. That silent-failure is by design (never present a hash/"dev" as a release baseline), but it means a forgotten re-stamp looks like "backend broken" while the service is healthy. Verify: `curl /api/config` returns `server_version`, and the Help menu shows both rows. Full reasoning: `docs/solutions/workflow-issues/version-reporting-after-upstream-upgrade.md`.

### Step 8: Restart services and verify

```bash
pm2 restart multica-backend multica-frontend

# Verify services are responding
curl -s -o /dev/null -w "%{http_code}" http://localhost:3001  # frontend
curl -s -o /dev/null -w "%{http_code}" http://localhost:8081  # backend API
```

Both endpoints should return 200 (or 301/302 for frontend routing). If either fails, check pm2 logs for the specific process.

### Step 9: Restore uncommitted modifications

```bash
git stash pop
```

Resolve any minor conflicts between the merge result and your stashed changes. These are usually trivial since the stash contains non-overlapping working-tree edits.

### Step 10: Write a descriptive merge commit message

Document the resolution strategy in the commit message so future maintainers understand what happened.

```bash
git commit -m "$(cat <<'EOF'
merge(upstream): upgrade to v0.3.42 with local customization preservation

Conflicts resolved:
- actor-avatar.tsx: accepted upstream refactor (size tokens, all-circles),
  adapted local avatar-chip and R2-squad to new API
- Config struct: kept both local SuperAdminEmails and upstream LLM fields
- readonly-content.test.tsx: combined both test suites
- workspace.sql: accepted upstream DELETE syntax, kept admin queries

Post-merge: pnpm install, typecheck, tests, build all pass.
EOF
)"
```

## Tool-environment caveat — Bash cwd drift

The Bash tool's working directory persists across calls. A `cd server && go build` at the start of one turn leaves cwd at `server/` for every subsequent turn, so a later `grep server/pkg/db` resolves to `server/server/pkg/db` (empty) instead of `/Users/fengzhao/multica/server/pkg/db`. Two reliable mitigations across the whole Guidance section:

- **Absolute paths everywhere**: `grep -rn … /Users/fengzhao/multica/server/cmd/migrate/main.go`, `go build -C /Users/fengzhao/multica/server ./...`.
- **The `-C` flag** (Go 1.20+) on `go build` / `go test` / `go run` does not change cwd and works regardless of how cwd drifted earlier turns — preferred when chaining git/build/test across turns in agentic workflows.

## Why This Matters

A self-hosted instance with local customizations has no automated upgrade path. Every upstream release merge is a manual operation that requires judgment. Without a structured workflow:

- **Backups prevent catastrophe.** A `git branch` backup costs nothing but saves you from an irreversible bad merge.
- **Conflict preview prevents blind commits.** Running `--no-commit --no-ff` first lets you assess scope before making irreversible changes. If the conflict set is overwhelming, you can abort and prepare.
- **Per-file strategy prevents over-merging.** Treating every conflict the same leads to either dropping local customizations (accept upstream everywhere) or retaining stale API patterns (keep local everywhere). Matching the strategy to the file's situation preserves both local work and upstream improvements.
- **Adaptation direction matters.** Updating local code to match the new upstream API is forward-compatible. Modifying upstream code to match the old local API creates a fork that gets harder to maintain with each release.
- **Verification catches silent breakage.** A merge that compiles but fails tests still has defects. The full verification chain catches type mismatches, behavioral changes, and missing dependencies before they reach production.

## When to Apply

- Merging a new upstream release into a self-hosted Multica instance that has local customization commits on `main`.
- Any git repository where a fork has diverged significantly from upstream and needs periodic sync.
- Situations where `git merge` produces conflicts spanning both API-layer refactors and independent feature additions.
- Any upgrade where breaking API changes in upstream affect local feature code.

## Examples

### Complete upgrade from v0.3.41 to v0.3.42

Starting state: 43 local commits on `main`, 35 upstream commits in `origin/main` since last sync.

```bash
# 1. Backup
git branch main-backup-v0.3.42 main

# 2. Stash local modifications
git stash push -m "pre-upgrade"

# 3. Fetch and preview
git fetch origin
git merge origin/main --no-commit --no-ff

# 4. List and assess conflicts
git diff --name-only --diff-filter=U
# → packages/ui/actor-avatar.tsx, server/cmd/server/router.go,
#   packages/views/editor/readonly-content.test.tsx, ...

# 5. Resolve per-file (repeat for each conflict)
git checkout origin/main -- packages/ui/actor-avatar.tsx && git add packages/ui/actor-avatar.tsx
# ... manually resolve Config struct, test files, SQL files ...

# 6. Adapt local features
# Update AvatarChip size={14} -> size="xs"
# Update Avatar shape="rounded-square" -> shape="circle"

# 7. Install + verify (apply migrations between build and tests)
pnpm install
cd server && go build ./... && cd ..
cd server && DATABASE_URL="<from .env>" go run ./cmd/migrate up && cd ..
pnpm typecheck
pnpm test
pnpm build

# 8. Commit
git commit -m "merge(upstream): upgrade to v0.3.42 ..."

# 9. Restart and verify service health
pm2 restart multica-backend multica-frontend
curl -s -o /dev/null -w "%{http_code}" http://localhost:3001
curl -s -o /dev/null -w "%{http_code}" http://localhost:8081

# 10. Restore stash
git stash pop
```

### Abort and retry when conflicts are overwhelming

If the initial `--no-commit` merge reveals too many conflicts (e.g., 50+ files), abort and prepare by breaking the upgrade into smaller steps.

```bash
git merge --abort
git stash pop

# Option A: cherry-pick specific upstream commits in order
git cherry-pick <commit1> <commit2> ...

# Option B: wait until you can dedicate time to resolve all conflicts
```

## Related

- `docs/solutions/workflow-issues/git-staging-timing-checkout-edit.md` — A git staging pitfall encountered during this upgrade where `git checkout --` stages a snapshot rather than the working tree, causing unexpected behavior when editing files mid-merge.
- `docs/solutions/workflow-issues/upstream-api-divergence-cherry-pick-port.md` — Documents how upstream API divergence turns a simple cherry-pick into a porting exercise requiring feature adaptation, directly relevant to Step 5.
- `docs/solutions/workflow-issues/pnpm-install-after-upstream-merge.md` — The missing `pnpm install` step that causes confusing build failures after merging upstream package.json changes, addressed in Step 6.
- `docs/solutions/workflow-issues/unapplied-migrations-after-upstream-upgrade.md` — A sibling "post-merge step the workflow forgot": after the v0.3.42 merge `migrate up` had not been run, silently breaking the issue execution-log list (usage endpoint 200 while task-runs 500). This SOP's Step 7 now runs it.
- `docs/solutions/workflow-issues/version-reporting-after-upstream-upgrade.md` — Another "post-merge step the workflow forgot": Step 7/8 do not re-stamp the version baselines, so the Help menu shows a stale frontend tag and "Backend unavailable" until you bump `.env` + `-ldflags` rebuild. This SOP's Step 7.6 now covers it.
