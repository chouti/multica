---
title: "从 Self-host Fork 准备干净的 Upstream PR"
date: 2026-07-29
module: "git/development_workflow/fork-upstream-pr"
problem_type: "workflow_issue"
component: "development_workflow"
severity: "high"
applies_when:
  - "将已合并进 self-host fork main 的本地定制整理为独立 upstream PR"
  - "需要从包含 meta-merge 和无关提交的历史中筛选原子提交"
  - "需要剥离 fork 内部 ticket、代号、迁移编号和源码注释引用"
  - "upstream main 持续推进并造成迁移号、组件或类型检查冲突"
  - "需要同时满足 backend、web、desktop 和 mobile 的跨基线 CI"
related_components:
  - "database"
  - "testing_framework"
  - "tooling"
  - "documentation"
tags:
  - "git"
  - "fork"
  - "upstream-pr"
  - "cherry-pick"
  - "rebase"
  - "migration-renumber"
  - "commit-hygiene"
  - "ci-parity"
---

# 从 Self-host Fork 准备干净的 Upstream PR

## Context

Self-host fork 中已经完成并合入 `main` 的功能，通常不能直接把原开发分支推给上游。这个 fork 同时承载本地定制、上游同步提交、内部计划代号和已经落库的迁移历史；一个看似完整的 feature merge，可能把大量与功能无关的提交一起带进 upstream PR。

本次 `archived` issue status 功能就是典型案例：fork 上有 12 个原子提交，另有一个包含 49 个提交的 meta-merge（在 `feat/archived-issue-status-v2` 分支的 tip 上）。直接采用 meta-merge 会多带约 37 个无关 cherry-pick。最终做法是在最新 `origin/main` 上建立专用 `feat/*` PR 分支，只逐个 cherry-pick 12 个真正属于该功能的原子提交，并在移植过程中清理 fork 内部语境、补齐跨基线测试缺口、处理迁移号竞争、吸收上游 UI type-scale 重构，以及补齐 mobile parity。

专用 `feat/*` 分支不是形式要求，而是本地定制 5 步工作流的一部分：它把"fork 可运行历史"与"上游可审阅历史"分开，使重排、amend、rebase 和迁移重编号不会污染 fork `main`。功能对上游具有普适价值时，再按 PR-by-universality 原则提交上游 (auto memory [claude]: `project_local_customization_workflow`)。

最终产物是 upstream PR `#6106`，12 个提交，backend、frontend-build、frontend-test、mobile、windows-execenv、installer 和 changes 检查全部通过。本文记录的是可重复执行的 upstream PR 准备方法，而不是某个单点 bug 的修复说明。

## Guidance

### 1. 从 upstream 基线重建，不从 fork 的 meta-merge 继续

先确认 remote 角色，再从 `origin/main` 建立干净分支。这里 `origin` 是官方 `multica-ai/multica`，`fork` 是 `chouti/multica`：

```bash
git remote -v
git fetch origin
git switch -c feat/archived-issue-status-upstream origin/main
```

不要 cherry-pick 汇总 feature 的 meta-merge；先列出原子提交及其文件范围，再按依赖顺序逐个移植：

```bash
git log --oneline --reverse <feature-base>..<fork-feature-tip>
git show --stat <commit>
git cherry-pick <commit-1> <commit-2> ...
```

如果文件在 fork 分支上的路径不适合 upstream PR，可先在 PR 分支执行 `git mv`，再 cherry-pick 或手工承接对应内容。目标是让每个提交都表达一个可独立审阅的上游价值，而不是忠实复制 fork 的拓扑。

### 2. 清除 fork 内部代号，包括提交历史和 committed 文件

每次 cherry-pick 后立即 amend，重写 subject 和 body，去除 `FZG-*`、`KTD*`、`U*`、`R*` 等只在 fork 内成立的引用：

```bash
git commit --amend
```

源码注释和测试标题也必须清理。不要只查 working tree；应查询 PR 相对 upstream 的 committed 内容：

```bash
git diff --name-only origin/main...HEAD \
  | xargs grep -nE 'FZG-[0-9]|KTD[0-9]+|(^|[^A-Za-z])U[0-9]+|(^|[^A-Za-z])R[0-9]+' || true

git log --format='%h %s%n%b' origin/main..HEAD \
  | grep -nE 'FZG-[0-9]|KTD[0-9]+|(^|[^A-Za-z])U[0-9]+|(^|[^A-Za-z])R[0-9]+' || true
```

内部决策本身若对理解代码必要，应改写成领域语言。例如，不写"fork 内部代号（KTD/U/R 系列）"，而写"`archived` is closed but not completed"。PR 分支中的分类定义明确为 `closed = done | cancelled | archived`、`completed = done | cancelled` (`packages/core/issues/config/status.ts:28-35`；`server/internal/issueguard/issue_status.go:13-17`，均以 PR `#6106` 分支内容为准)。

### 3. 把 cherry-pick 当成跨基线移植，而不是机械复制

相同提交在不同基线上可能暴露不同失败。本次 CLI 提交在 fork main 上受测试包既有 init panic 遮蔽；移到已修复该 panic 的 upstream main 后，`TestValidIssueStatuses` 才暴露 expected map 少了 `archived`。正确期望集有 8 项，CLI 接受列表也有 8 项 (`server/cmd/multica/cmd_issue_test.go:2686-2703`；`server/cmd/multica/cmd_issue.go:362-364`，PR `#6106` 分支)。

因此，每完成一层移植就运行该层最窄测试，不要等所有提交结束：

```bash
(cd server && go test ./cmd/multica -run TestValidIssueStatuses -count=1)
(cd server && go test ./internal/migrations -run TestMigrationNumericPrefixesStayUniqueAfterLegacySet -count=1)
pnpm --filter @multica/core typecheck
pnpm --filter @multica/views typecheck
```

测试失败时，先判断它是提交本身缺陷、上游基线新增约束，还是冲突解决遗漏；补丁应 fixup 到引入该责任的提交，除非它代表独立的跨平台能力（mobile parity 就适合独立提交）。

### 4. 迁移号在本地历史与 upstream PR 中采用不同策略

这是最关键、也最反直觉的规则：

- **fork 本地已执行的迁移不重编号。** 本地 `schema_migrations` 已记录 213/214；改文件名不会改数据库事实，反而会造成迁移重放或历史不一致 (auto memory [claude]: `project_fork_213_214_migration_collision`、`project_migration_duplicate_prefix_no_renumber`)。
- **尚未合入 upstream 的 PR 迁移必须改用 upstream 当前空白号。** PR `#6106` 准备期间，`#6107` 占用了 234，最终 archived-status 迁移使用 235/236。PR 分支中的文件为 `server/migrations/235_issue_status_archived.{up,down}.sql` 和 `server/migrations/236_issue_status_classifier_functions.{up,down}.sql`；唯一前缀约束由 `TestMigrationNumericPrefixesStayUniqueAfterLegacySet` 检查 (`server/internal/migrations/migrations_lint_test.go:74`)。

重命名示例：

```bash
# 假设 PR 分支当前为 234/235 占号状态，下面命令把目标号迁移到上游空白号
# （目标路径 235/236 在本 fork worktree 不存在——属于 PR `#6106` 分支文件）
git mv server/migrations/234_issue_status_archived.up.sql \
       server/migrations/235_issue_status_archived.up.sql
git mv server/migrations/234_issue_status_archived.down.sql \
       server/migrations/235_issue_status_archived.down.sql
git mv server/migrations/235_issue_status_classifier_functions.up.sql \
       server/migrations/236_issue_status_classifier_functions.up.sql
git mv server/migrations/235_issue_status_classifier_functions.down.sql \
       server/migrations/236_issue_status_classifier_functions.down.sql
```

然后同步所有写死迁移号的源码注释和测试说明。重点搜索 `status.ts`、`status.test.ts`、`issue_status.go`、`child-progress.ts` 等相关文件：

```bash
rg -n 'migration[- ]?(234|235)|234_|235_' \
  packages/core server/internal packages/views
```

不要修改本地数据库的 `schema_migrations` 来"配合"PR 重编号；PR 分支的编号服务于未来 upstream 安装路径，本地 fork 的既有编号服务于已经发生的生产历史。

迁移 235 的 CHECK 值经源码验证为 `backlog`、`todo`、`in_progress`、`in_review`、`done`、`blocked`、`cancelled`、`archived` (PR `#6106` 分支文件 `server/migrations/235_issue_status_archived.up.sql`，本 worktree 不含此路径——本地 fork 仍为 `213_issue_status_archived`)。

### 5. Rebase 冲突要同时保留功能语义和 upstream 规范

PR 开发期间 upstream `#6108`（MUL-5451）重构了 type scale。冲突集中在：

- `packages/views/issues/components/board-card.tsx`
- `packages/views/issues/components/issue-detail.tsx`
- `packages/views/issues/components/issues-page.tsx`
- `packages/views/issues/components/list-row.tsx`

统一解决原则是：

1. 保留 PR 的 archived 行为、closed/completed 分类和视觉弱化逻辑；
2. 丢弃 fork 的 ad-hoc 字号写法；
3. 使用 upstream role token，例如 `text-micro`、`text-caption`、`text-body`。

这些 token 在冲突文件中实际使用，例如 `board-card.tsx:185-220`、`issue-detail.tsx:694-759`、`issues-page.tsx:61-106`、`list-row.tsx:84-164` (PR `#6106` 分支)；lint 自身提示使用 `text-micro … text-display`，以及 `text-sm -> text-body` (该 lint 规则位于 upstream PR `#6108` 引入的 `apps/web/app/type-scale.test.ts`，文件本身尚未合入本 fork worktree)。

Rebase 后只检查整个仓库容易被既有代码噪声淹没，应该限制到 PR diff：

```bash
git diff -U0 origin/main...HEAD -- '*.tsx' '*.ts' \
  | grep '^+' \
  | grep -nE 'text-xs|text-sm|text-\[[0-9]+px\]' || true
```

本次正是靠 type-scale lint 发现 `issues-header.tsx` 遗漏的一处 `text-xs`，随后改为 `text-caption` 并 fixup 到相关 web 提交。

### 6. 扩展共享 enum 后主动检查所有 exhaustive maps

`IssueStatus` 增加 `archived` 会让 mobile 中的 `Record<IssueStatus, string>` 变成不完整映射。PR `#6106` 分支经源码验证有四处需要补键：

- `apps/mobile/components/ui/status-icon.tsx:25` 的 `STATUS_COLOR`
- `apps/mobile/components/inbox/detail-label.tsx:28` 的 `STATUS_LABEL`
- `apps/mobile/lib/format-activity.ts:20` 的 `STATUS_LABEL`
- `apps/mobile/lib/issue-status.ts:25` 的导出 `STATUS_LABEL`

使用结构搜索或文本搜索找全 exhaustive maps：

```bash
rg -n 'Record<IssueStatus, string>' apps/mobile packages apps
rg -n 'switch \(.*status|IssueStatus' apps/mobile packages/core packages/views
```

mobile parity 是独立平台能力，因此本次用独立提交 `feat(mobile): mirror archived issue status for parity` 表达，而不是偷偷塞进 web 或 server fixup。

### PR 准备 checklist

- [ ] 切 `feat/*` 工作分支，在 PR 分支上执行必要的 `git mv`，再逐个 cherry-pick 原子提交；不采用携带无关历史的 meta-merge。
- [ ] 每个 commit 都 amend，重写 subject 和 body，去除 `FZG`、`KTD`、`U`、`R` 内部引用。
- [ ] 对所有 committed 文件运行 `grep -nE "FZG-[0-9]"`，结果为空；同时检查 commit subject/body。
- [ ] 修复跨基线 cherry-pick gap，例如把 `TestValidIssueStatuses` 的期望集同步为 8 项并包含 `archived`。
- [ ] 将 migration 文件重命名到 upstream 当前空白号；绝不修改本地已执行数据库的 `schema_migrations`。
- [ ] 同步所有引用迁移号的源码注释，包括 `status.ts`、`status.test.ts`、`issue_status.go`、`child-progress.ts` 等。
- [ ] 做 mobile/web 同步检查：搜索 `Record<IssueStatus`，为所有 exhaustive maps 补 `archived`。
- [ ] Rebase 到最新 `origin/main`，解决 type-scale token 冲突：保留 PR 逻辑，同时把 fork 的 ad-hoc font size 换成 upstream token。
- [ ] 在 PR diff 内运行 `grep -rn "text-xs\|text-sm\|text-\[[0-9]+px\]"` 等价检查，结果为空。
- [ ] 运行 core/views/web 的 `pnpm typecheck`、Go build 和相关 `pnpm test`，全部通过。
- [ ] 等待 upstream CI 全绿，包括 backend、frontend、mobile 和发布相关 jobs。
- [ ] 在 fork `docs/customizations.md` 增加 `OPEN-PR` 行；该 ledger 更新 commit 到 fork `main`，但不 push 远端，除非用户另行授权。

最后一项用于保持本地定制 ledger 与上游贡献状态一致：未来升级时可以知道该定制仍需保留、已被 upstream 接受，还是可以删除 (auto memory [claude]: `project_local_customization_workflow`)。本环境另有 git guardrails 阻止 `push`、`reset --hard`、`clean -f`、`branch -D` 等高影响命令；不要绕过它，应把"本地 commit"和"远端 push"视为两个独立授权步骤 (auto memory [claude]: `feedback_git_guardrails`)。

## Why This Matters

干净 upstream PR 的难点不是把最终代码复制过去，而是同时维护三种真实性：

1. **审阅真实性**：每个提交只包含上游真正需要理解的变化，不泄漏 fork 内部项目管理语境。
2. **历史真实性**：本地生产数据库继续承认已执行的 213/214，upstream 新安装路径则使用未被占用的 235/236；两边都不伪造迁移历史。
3. **基线真实性**：PR 必须满足当前 upstream 的测试、type scale 和 mobile exhaustiveness，而不是只证明它曾在旧 fork 基线上工作。

忽略任何一项都会产生高成本返工：meta-merge 会制造无法审阅的 diff；直接重编号本地迁移会破坏部署历史；不补 exhaustive maps 会让 mobile typecheck 失败；冲突时保留旧字号会触发 upstream lint；只清 commit message 而不清注释，会把内部代号永久带进公共代码。

## When to Apply

- fork 中的功能已经合入本地 `main`，现在需要整理为官方 upstream PR。
- feature 分支混有 upstream cherry-pick、同步 merge、内部文档或其他本地定制。
- PR 含数据库迁移，而 fork 数据库已经执行过不同编号的同一逻辑迁移。
- upstream 在 PR 准备期间继续合并迁移、lint、design token 或类型系统变更。
- 共享 enum/type 的修改横跨 server、CLI、web、desktop 或 mobile。
- 本地提交含内部 issue、KTD、验收矩阵或阶段代号，不适合公开上游审阅。

## Examples

### 示例一：错误地沿用 meta-merge vs 从 upstream 重建

**Before：**

```bash
git switch feat/archived-issue-status-v2
git push upstream feat/archived-issue-status-v2
```

这会把 `feat/archived-issue-status-v2` tip 处的 49-commit 拓扑和约 37 个无关 cherry-pick 暴露给 reviewer。

**After：**

```bash
git fetch origin
git switch -c feat/archived-issue-status-upstream origin/main
git cherry-pick <12 atomic commits in dependency order>
git log --oneline origin/main..HEAD
```

结果是 `#6106` 的 12 个可审阅提交，而不是 fork 的同步历史。

### 示例二：迁移号"统一" vs 按历史边界分别处理

**Before：** 为了让 fork 和 PR 文件名一致，重命名本地 213/214，并试图编辑 `schema_migrations`。

**After：** fork 保留已执行的 213/214；仅 PR 分支因 `#6107` 占号而从 234/235 调整为 235/236，并更新源码注释。数据库历史和 upstream 新安装路径各自保持真实。

### 示例三：选择冲突一侧 vs 语义合并

**Before：** 在 `board-card.tsx` 冲突中整块选择 fork 版本，保留 archived 逻辑，也保留 `text-xs` 或 `text-[11px]`。

**After：** 手工保留 archived 的状态判断和弱化样式，但将字号替换为 `text-micro`、`text-caption`、`text-body`，再用 `apps/web/app/type-scale.test.ts` 和 PR-diff grep 验证。

### 示例四：只修 web enum vs 查找所有 exhaustive consumers

**Before：** 给共享 `IssueStatus` 增加 `archived` 后只更新 web status picker。

**After：** 搜索 `Record<IssueStatus, string>`，补齐 mobile 的两处 `STATUS_LABEL`、导出 `STATUS_LABEL` 和 `STATUS_COLOR`，再以独立 mobile parity commit 提交。

## Lessons Learned

- "在 fork main 上测试过"不等于"在当前 upstream main 上可移植"；cherry-pick 后必须重跑窄测试，尤其是以前被 init panic 或其他基线故障遮蔽的测试。
- migration 编号不是功能身份，而是某条部署历史中的顺序标识。已执行的 fork 编号不能改；未合入的 upstream PR 编号可以且必须避让。
- rebase conflict resolution 不是二选一。正确结果通常是"保留功能语义 + 接受 upstream 新规范"。
- 共享 union/enum 的新增值应立即触发 exhaustive-map 搜索；mobile 常因独立构建链而成为最后暴露缺口的平台。
- lint failure 可能揭示原始 feature commit 的遗漏，而不只是 rebase 新冲突；应把修复 fixup 到最合适的责任提交。
- `docs/customizations.md` 的 `OPEN-PR` 状态是升级治理数据，不是发布说明。PR 建好后要更新 ledger，但本地 commit 不自动意味着允许 push。
- PR 和相关 upstream 变更应优先用稳定编号引用：本次为 `#6106`、迁移占号变更 `#6107`、type-scale 重构 `#6108`（MUL-5451）；commit SHA 会随 rebase 改写。编号映射亦见 auto memory [claude]: `reference_upstream_multica_issues`。

## Related

- Upstream PR `#6106`：add archived issue status。
- Upstream PR `#6107`：引入 `234_agent_task_queue_retired_session_id`，触发迁移号避让；该描述 per this session's conclusion。
- Upstream PR `#6108` / MUL-5451：type-scale 重构；该关联 per this session's conclusion，token 与 lint 规则已由源码验证。
- Fork ledger：`docs/customizations.md`。
- 迁移唯一前缀测试：`server/internal/migrations/migrations_lint_test.go:74`。