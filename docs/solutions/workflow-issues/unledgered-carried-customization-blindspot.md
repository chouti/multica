---
title: "Un-ledgered carried customization blind spot at upstream merge"
date: 2026-08-12
category: workflow-issues
module: git
problem_type: workflow_issue
component: development_workflow
severity: high
applies_when:
  - "Self-host fork carries local customizations tracked by a ledger and is merging a new upstream release"
  - "A customization was landed locally but never recorded in the ledger"
  - "Resolving merge conflicts on files an un-ledgered customization touches"
tags: [upstream-upgrade, local-customizations, merge-conflicts, ledger, blind-spot, self-hosted]
---

# Un-ledgered carried customization blind spot at upstream merge

## Context

self-host Multica fork 用 `docs/customizations.md` 作为"我们 carry 什么"的 ledger，升级 SOP（`docs/solutions/workflow-issues/safe-upstream-upgrade-with-local-customizations.md`）和每次升级的预合并审计都以这份 ledger 为真相源：查 PR 状态、按 ledger 的"Active customizations"表分配 per-file 策略。**但 ledger 是手工维护的，可以有缺口**——一个落地到本地 main、却从未被记进 ledger 的 customization，对这个审计流程完全不可见。SOP 假设 ledger 完整，所以没有任何步骤去发现"ledger 没记录但确实在 carry"的定制。

危险不在审计阶段本身，而在**冲突解析阶段**：如果这个盲点 customization 恰好住在一个 merge 冲突文件里，而解析者不知道它存在（ledger 没告诉它），就可能用一种把它丢掉的方式解析——最典型的是对整个文件 `git checkout --theirs`，静默抹掉 fork-only 的路由注册、locale key、类成员，且常常没有 build/test 失败来示警（被删的东西只是"消失了"）。

(auto memory [claude]) 这与 [[feedback_fork_customization_invariant_set]] "fork 定制是不变量集合、3-way merge 抓不到所有碰撞" 是同一家族的风险，但角度不同：那条讲 merge 工具的局限，本条讲**知识源（ledger）本身有盲区**。

## Guidance

预合并审计加一条独立的 **ledger-coverage lane**，并在解析 + 验证阶段加两道兜底：

1. **预合并：ledger-coverage lane（fan-out 的第三路）。** 不要只做"最高 churn vs fork 热区"和"上游特性 + 跨切面危害"两路；加一路专门验 ledger 完整性：
   - `git log --oneline <merge-base>..HEAD` 列出 fork 的全部 ahead-commits，按 scope（顶层目录 / conventional-commit scope）聚类。
   - 对每个有体量的 cluster，确认 `docs/customizations.md` 有对应一行。**重点标记触碰 upstream-own 文件、但 ledger 没记录的 cluster**——那就是盲点。
   - 把 `comm -12 <(git diff --name-only <MB>..HEAD | sort) <(git diff --name-only <MB>..<tag> | sort)`（双方都改的文件交集）与 ledger 对照：交集里的每个文件，都应该能追溯到某个 ledger 记录的 customization；追溯不上的，就是盲点碰了冲突文件，**解析时高危**。

2. **解析：盲点存在时，绝不用整文件 `--theirs`。** 盲点的本质是"你不知道文件里还有 fork-only 成员"。所以对交集文件一律用**外科式 per-hunk 工具**（`git merge-file` 三方合并，或 `sed` 只清冲突标记区），保留文件其余部分。详见 `merge-conflict-checkout-theirs-drops-fork-only-members.md`。

3. **验证：post-merge 枚举路由/符号/exports 作兜底。** 即便用了外科式工具，auto-merge 仍可能因 context 重叠丢掉一个注册点。对热点文件（router、handler 注册表、locale、barrel exports）merge 后 grep 一遍关键符号，确认 fork 的定制 + 上游的新增**都在**。这是"auto-merge ≠ 语义正确"的最后一道闸。

## Why This Matters

本轮 v0.4.22 → v0.4.23 升级是这条盲点的活样本。fan-out 审计的第三路（ledger-coverage）发现 fork 有一个完整的 **VCS 自托管 Git provider 簇**——支持 Forgejo/Gitea/GitLab 作为 GitHub 之外的 Git provider（PR #5006 / #5888，含 self-host-only 收敛、迁移撞号修复 #5883 / #5868；**未合并入上游 v0.4.23**，本轮 fork-only carry）。这个簇有新建文件 `server/internal/handler/vcs.go`、`packages/views/settings/components/vcs-tab.tsx`、`vcs_webhook.go`，并触碰 `server/cmd/server/router.go`（注册 5 个路由 + VCS secretbox 初始化）和 `packages/views/locales/*/settings.json`（每语言约 41 个 key）。

而 `docs/customizations.md` **完全没有这一行**——可用 `grep -ciE 'vcs|forgejo|gitea|gitlab|MUL-3772' docs/customizations.md` 验证（返回 0）。这意味着：

- **router.go 是本轮最热文件**——ledger 记录的 4 个 fork 路由定制（#5539 provenance、#2669 skills、#4118 admin、#5539）都在这里注册，加上游新增的 WeCom 媒体路由（MUL-5906）。**但第 5 个（VCS）ledger 没记**。如果解析者只看 ledger 就以为 router.go 有 4 个 fork 定制，对着冲突标记用 `--theirs`"清理"，5 个 VCS 路由 + secretbox 会被静默删除，且 `go build` 通过、测试通过（路由只是不存在了，编译器不会报缺）。
- **本轮实际幸存**：auto-merge 因为 fork 与上游在 router.go 的改动区域不相交，干净保留了全部 5 个 VCS 路由（`r.Post("/api/webhooks/vcs/{connectionId}", h.HandleVCSWebhook)`、`r.Get("/vcs/connections", h.ListVCSConnections)`、`r.Post("/vcs/connections", h.ConnectVCS)`、`r.Post("/vcs/connections/{connectionId}/rotate-webhook", ...)`、`r.Delete("/vcs/connections/{connectionId}", ...)`）。但这是**运气（hunk 不相交），不是设计**。下一轮若上游在 router.go 同一区域改动，auto-merge 就可能丢。

(auto memory [claude]) 这条与 [[feedback_negative_claim_must_prove_user_invariant]] 的核心教训同构：审计里的"无 X"结论（"ledger 覆盖了所有 cluster"、"router.go 只有 4 个 fork 定制"）是最危险的，必须用原始命令验，不能靠读 ledger 就下结论。

## When to Apply

- 每次 self-host fork 合并上游 release，且 fork 有可观 ahead-count（本 fork 288 commits ahead → 盲点概率高）。
- ledger 是手工维护、且历史上确实漏记过定制（本 fork 在 v0.4.23 才发现 VCS 簇这个缺口）。
- 交集文件里出现"追溯不到任何 ledger 行"的 fork 改动时——这是盲点碰了冲突文件，解析前必须搞清楚那是什么定制。

## Examples

**发现盲点（本轮实际命令）：**

```bash
# fork 的 ahead-commits 里，有触碰交集文件、但 ledger 没记录的 cluster 吗？
git log --oneline --no-merges <merge-base>..HEAD --grep='vcs\|MUL-3772\|#5006\|#5888' -i
# → 命中 PR #5006 / #5888 / #5883 / #5868 对应的 commits（VCS 簇确实在 fork HEAD；引 PR 号而非 SHA——本地 commit 会被 rebase/squash 改写）

grep -ciE 'vcs|forgejo|gitea|gitlab|MUL-3772' docs/customizations.md   # → 0（ledger 没记 = 盲点确认）
```

**post-merge 路由枚举兜底（确认盲点定制幸存）：**

```bash
# merge 后，router.go 里 VCS 的 5 个路由注册都还在吗？
grep -nE 'vcs|VCS|forgejo|gitea|gitlab' server/cmd/server/router.go
# → 命中 r.Post("/api/webhooks/vcs/{connectionId}", h.HandleVCSWebhook) 等 5 行 + secretbox 初始化
```

本轮这 5 行全部存活 → 盲点未造成损失。但发现后**必须回填 ledger**（已在本轮 Phase 7 把 VCS 簇补进 `docs/customizations.md` 的 Open PRs 表），让下一轮审计不再对它盲目。

## Related

- `safe-upstream-upgrade-with-local-customizations.md` —— 升级 SOP，其 Step 4.5 假设 ledger 完整；本条是给该 SOP 补的"ledger 可能不完整"审计 lane。
- `merge-conflict-checkout-theirs-drops-fork-only-members.md` —— 解析阶段为什么绝不能用整文件 `--theirs`（盲点放大这个风险）。
- `fork-customization-invariant-set-upstream-test-collision.md` —— fork 定制作为不变量集合的视角。
- `negative-claim-must-prove-user-invariant.md` —— "审计的'无 X'结论必须用原始命令验"的总方法论（本条是其在 ledger-coverage 维度的具体应用）。
- 升级实例留档：`docs/upgrades/v0.4.23-plan.md`（VCS 盲点的完整发现 + 验证记录）。
