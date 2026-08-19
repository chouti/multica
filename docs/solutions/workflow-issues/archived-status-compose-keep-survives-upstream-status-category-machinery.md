---
title: "收口谓词的传递性 — v0.4.28 的 compose-and-keep 补丁在 v0.4.29 的 status-category 机制里零重放存活，前端只剩两个手动轴"
date: 2026-08-19
category: workflow-issues
module: upstream-upgrade-merge
problem_type: workflow_issue
component: development_workflow
severity: high
applies_when:
  - "v0.4.29 之后每轮上游升级中 archived 第 8 伪内置状态的携带核对（上游 PR #6106 仍 OPEN）"
  - "upstream diff 触碰 server/internal/issuestatus/、packages/core/types/issue.ts、packages/core/issues/config/status.ts、packages/core/issue-statuses/、packages/core/issues/queries.ts 任一文件"
  - "upstream 在 IsBuiltIn / IsCategory / Effective 谓词族上新增消费方（过滤、分桶、响应填充）"
  - "合并审计中两侧同改同一 TYPE 声明区域，需要枚举 import/收窄轴（而不止成员轴）"
  - "upstream 重写 accepts-exactly-N 式测试钉（本轮 7→8 重钉）"
symptoms:
  - "TS2304 Cannot find name 'IssueStatus' ×5 —— 预测的 union 成员缺失未发生，真实失败来自 upstream 收窄类型导入"
  - "不带 include_archived 拉取 archived category 返回空集 —— fork archived-guard 与 upstream category 展开在 where 里 AND 组合成恒空谓词"
root_cause: type_divergence
resolution_type: code_fix
related_components:
  - server-issuestatus
  - frontend-issue-statuses
  - issues-queries
tags: [archived-status, compose-and-keep, upstream-upgrade, issue-status-category, zero-replay, auto-derive, pseudo-builtin, type-import-narrowing]
---

# 收口谓词的传递性 — v0.4.28 的 compose-and-keep 补丁在 v0.4.29 的 status-category 机制里零重放存活，前端只剩两个手动轴

## Context

本文是 `docs/solutions/workflow-issues/fork-archived-status-semantic-collision-compose-into-upstream-issuestatus.md`（v0.4.28 决策篇）的续篇：那一篇记录了「把 fork 的 `archived` 做成第 8 个伪内置、挂进 `issuestatus` 包的单一解析收口（`Resolve`/`IsBuiltIn`）」的决策；本篇记录该决策在**下一个 release** 上的第一次实证 —— 补丁不仅存活，而且**传递**（transmit）进了 upstream 在同一谓词族上继续盖出的新机制，server 面零重放、零新代码。

事件：v0.4.28 → v0.4.29 升级（2026-08-19），merge commit `895839b9a`（真 2-parent：fork HEAD `e8364fb2b` × tag `v0.4.29` `c670e0549`），过程工件 `docs/upgrades/v0.4.29-plan.md`（全 gate 翻绿，phase: done）。

背景不变量（沿用 v0.4.28 篇）：fork 的 `archived` 是第 8 个伪内置 issue status —— closed 但 **NOT** completed（FZG-341 KTD2 split：`closed = done | cancelled | archived`、`completed = done | cancelled`，`packages/core/issues/config/status.ts:42-44`；Go 侧 `server/internal/issueguard/issue_status.go` 同构）。上游对应 PR #6106 升级时仍 OPEN。`archived` 不是 `issue_status` catalog 行：category CHECK 只允许 7 类（`server/migrations/332_issue_status.up.sql:38-41`），且塞进 `cancelled` 类会完整继承 counts-as-completed 语义 —— 恰是 fork 拒绝的两条。生产数据：本 session 经 psql 直连 :5433 复核，`issue` 表 `status='archived'` 267 行、`issue_status` catalog 35 行（5 ws × 7）、`schema_migrations` 最新 343 —— 与 plan 记录一致。

v0.4.29 的威胁来自 upstream commit `14c2e4e83`（PR #7084，"MUL-6243 feat(issue-status): board fetches by category; archive retires without migration"）：前端把 union `IssueStatus` 改名为 `IssueStatusCategory`（upstream 侧 7 成员），旧名降级为别名 `IssueStatus = IssueStatusCategory`；server 侧上线 status-category 机制 —— `status_category` query param + `issuestatus.ExpandCategories` 把 category 展开成 status key 集合进 `ANY(...)` 谓词，board 按 category 分桶拉取。这套机制全部落在 fork 补丁所在的谓词族上。

结果摘要：server 面**零重放**（v0.4.28 的 5 处携带面 server 部分无需任何重放，plan negative claim 原文 "Fork's server carry surface needs NO re-application this round — the v0.4.28 compose pattern is transitive through upstream's IsCategory=IsBuiltIn"）；前端面大部分**自动派生**，人工轴只剩 2 个（`include_archived` + 测试钉）；验证全绿（`pnpm typecheck` 修 1 处 import 后 6/6、`pnpm test` 375 files / 4438 tests 零 fork×upstream-test 碰撞 —— v0.4.23 以来首个全净轮、`go build`/`go vet` exit 0、`make sqlc` 再生成零漂移、`pnpm build` 3/3、go test 残差集与合并前 baseline 集合相同，均见 plan Phase 5 记录）。

先例与同族判例（session history）：

- **测试钉人工轴有前史**。v0.4.26 轮的 refresh 调查曾发现 fork main 上 `TestValidIssueStatuses` 长期红：期望 map 只有 7 值，而 `validIssueStatuses` 实际返回 8 值（含 `"archived"`），且在 pflag 包 init panic 修复（`d5428bc26`）之前该测试从未真正执行过 —— 编译层 gate 对状态集漂移全盲。修复以独立 commit `e2448b159` 把期望补到 8 值钉死。「测试钉随系统演化重钉」由此已是 archived 轴的既有人工防线，本篇前端 7→8 重钉是同一防线的第二次兑现。
- **import 轴的执行方向镜像**。同族前端失败模式见 `docs/solutions/test-failures/whole-module-vi-mock-shadows-new-named-export.md`（commit `e8364fb2b`）：整模块 vi.mock 遮蔽新增命名导出，typecheck 全绿、只有执行测试暴露 —— 与本篇的 import 收窄（compile 方向）互为镜像。若自派生改动触碰任何被 mock 模块（如 `STATUS_ORDER` / `BUILT_IN` 所在模块）的导出面，这是已验证会复发的模式。
- **基线对照判责**。Go 失败逐一切 pre-merge 基线对照，「一字不差同样失败」判为在案存量 residual 而非升级新引入 —— 本轮 go test 残差判定即用此法。

## Guidance

### 1. Server 面：为什么零重放 —— 收口谓词上的新机制自动认识伪内置

upstream 的 category 机制没有一个为 `archived` 写的分支，但它**处处以 `IsBuiltIn` 为键**，而 `IsCategory = IsBuiltIn` 是 upstream 自己的构造（`server/internal/issuestatus/issuestatus.go:120`：`func IsCategory(value string) bool { return IsBuiltIn(value) }`）。fork 在 v0.4.28 打进 `IsBuiltIn` 的特判（`issuestatus.go:109-115`）因此同时改写了 `IsCategory` 的判定集 —— 新机制的两条数据流全部流经它：

- **入向（过滤）**：`status_category` param（`server/internal/handler/issue.go:1169`，第二处 `:1745`）→ `issuestatus.ExpandCategories`（`issue.go:1266`）。`ExpandCategories` 先用 `IsCategory` 筛合法 category（`issuestatus.go:358-361`）—— `archived` 通过；再查 catalog 拿各 category 的 key（CHECK 约束保证没有 category='archived' 的行，查询返回空）；最后 self fill-in：「A category always contains at least its own canonical key」把 category 本身补进 key 集（`issuestatus.go:381-388`）。于是 `ExpandCategories(["archived"]) = ["archived"]`，谓词变成 `i.status = ANY('{archived}')`。
- **出向（响应）**：纯构造器 `issueToResponse` 对 built-in 直接填 `StatusCategory: i.Status`（`issue.go:273-276`，条件正是 `issuestatus.IsBuiltIn(i.Status)`）；Resolver 填充路径 `newStatusCategoryFiller` → `Resolver.Effective` 的 built-in 快路径同样原样返回（`issue.go:251-258`、`issuestatus.go:313-316`）。所以每个 archived issue 的响应自动携带 `status_category: "archived"`。

v0.4.28 的全部 server 触点 —— `Archived` 常量（`issuestatus.go:105`）、`IsBuiltIn` 特判、`ActiveKeys` 尾部 fill-in（`issuestatus.go:282-284`）、`validIssueStatuses` append（`issue.go:102`）、`status <> 'archived'` guard 尾巴（`issue.go:1277-1279`、`:1760-1761`）—— 一行未改，新机制全部认识（此 5 触点为 issuestatus.go + issue.go 两文件的枚举；其余 server 携带位点见前篇清单，本轮同零重放）。这是「挂进收口而不是逐调用点打补丁」的直接回报：upstream 在收口谓词上继续盖楼，楼层越高，免费搭车面越大。

### 2. 前端面：派生链 —— 两个源头改动让三个 category 函数零代码变正确

用户决策：教前端认识第 8 个 category（union 加 `archived` 成员），而不是把 archived 映射进 cancelled 类（后者继承 completed 语义，被拒）。派生链只改两处源头：

```typescript
// packages/core/types/issue.ts:12-20 — auto-merge 把 upstream 的 rename
// 与 fork 的成员拼在了一起：union 已是 8 成员（注释仍写 "exactly 7"，
// 是 upstream 原文未动的文字痕迹）
export type IssueStatusCategory =
  | "backlog"
  | ...
  | "cancelled"
  | "archived";

// packages/core/issues/config/status.ts:10-19 — STATUS_ORDER 补第 8 项
export const STATUS_ORDER: IssueStatusCategory[] = [
  "backlog", "todo", "in_progress", "in_review",
  "done", "blocked", "cancelled", "archived",
];
```

下游全部派生：`BUILT_IN = new Set<string>(STATUS_ORDER)`（`packages/core/issue-statuses/queries.ts:65`）派生出内置集，三个 category 函数随即全部正确 —— `isIssueStatusCategory`（`queries.ts:67-69`，`BUILT_IN.has(value)`）、`issueStatusCategory`（`packages/core/issues/status-category.ts:18-23`，server 值 `status_category` 优先、built-in key 回落自身）、`statusCategoryOfKey`（`status-category.ts:33-35`）。看板分桶、`STATUS_CONFIG` 展示查表（`packages/core/issues/config/status.ts:67` 有 archived 条目）、`hidden-columns-panel` 的 `statusCategoryOfKey` 查找（import 见 `packages/views/issues/components/hidden-columns-panel.tsx:4`，调用点 `:72`）零代码变更。

### 3. 人工轴 1 — `include_archived`（本轮真正的陷阱）

派生链覆盖不到的一处：`fetchFirstPages` 按 category 分桶拉取（`PAGINATED_CATEGORIES = ALL_STATUSES`，8 桶，`packages/core/issues/queries.ts:232`），archived 桶必须显式带上 flag：

```typescript
// packages/core/issues/queries.ts:244-258
async function fetchFirstPages(filter: MyIssuesFilter = {}, sort?: IssueSortParam): Promise<ListIssuesCache> {
  const responses = await Promise.all(
    PAGINATED_CATEGORIES.map((category) =>
      api.listIssues({
        status_category: category,
        limit: ISSUE_PAGE_SIZE,
        offset: 0,
        // The server composes the category expansion with an archived guard
        // (`status = ANY(...) AND status <> 'archived'` when include_archived
        // is unset), so the archived bucket must opt in explicitly.
        include_archived: category === "archived",
        ...
```

原因藏在 server 的 where 构造里，必须读源码才能证明：fork 的 guard 尾巴（`include_archived` param 与 `i.status <> 'archived'` 都是 fork 自有携带 —— upstream v0.4.29 的 issue.go 里 grep 不到任何一处）与 upstream 新落的 category 展开在合并后被拼成相邻谓词（`issue.go:1261-1279`）：

```go
if len(statusCategoriesFilter) > 0 {
    keys, err := issuestatus.ExpandCategories(...)   // :1266 → ["archived"]
    where = append(where, fmt.Sprintf("i.status = ANY(%s::text[])", addArg(keys)))  // :1272
}
...
if !includeArchived {
    where = append(where, "i.status <> 'archived'")  // :1277-1279 fork guard
}
```

不带 flag 的 archived-category 请求生成 `status = ANY('{archived}') AND status <> 'archived'` —— 恒空集。这不是补丁丢失，是**两个各自正确的语义在组合层的交互**，且类型系统、编译、任何 gate 都看不见（空结果集不报错）。这是本轮 2 处真实文本冲突之一（`queries.ts` 的 fetchFirstPages；另一处是 `hidden-columns-panel.tsx` 的 import 块 keep-both），冲突标记把它送到了必须人工裁决的位置。方法论：解冲突前先读 server 的 where 构造，证明「为什么必须带 flag」再写 flag —— 而不是先写再观察。

### 4. 人工轴 2 — 测试钉

`packages/core/issue-statuses/queries.test.ts:59-67` 的 "accepts exactly the N" 式测试，upstream 每加一个 category 就会重写一次，本轮从 7 重钉到 8：

```typescript
it("isIssueStatusCategory accepts exactly the 8 — 7 upstream + the fork's archived", () => {
  expect(isIssueStatusCategory("in_review")).toBe(true);
  // The fork carries "archived" as an 8th pseudo-builtin category (closed,
  // NOT completed), mirroring the server-side IsBuiltIn patch ...
  expect(isIssueStatusCategory("archived")).toBe(true);
  expect(isIssueStatusCategory("human_review")).toBe(false);
});
```

它与 server 侧 `TestUnseededWorkspaceStillAcceptsBuiltInStatuses`（`server/internal/handler/issue_status_test.go:148-152`，钉 `ActiveKeys` = 7 + archived）构成两面镜子：upstream 重写这些钉时，fork 必须跟着重钉，否则测试钉会把 8 值契约重新拉回 7 值。

### 5. 审计教训：预测错了失败轴

本轮唯一真实 typecheck 失败**不是**预测的「union 缺 archived 成员」—— auto-merge 早已把 rename 与 fork 成员拼好，union 在 typecheck 跑之前就是 8 值。真实失败更窄：upstream 收窄了 `packages/core/issues/config/status.ts` 的 type import（v0.4.29 侧只 import `IssueStatusCategory`），而 fork 的函数体仍命名 `IssueStatus` —— 该文件 5 处 body 引用（`BOARD_STATUSES`(L32)、`CLOSED_STATUSES`(L42)、`COMPLETED_STATUSES`(L44)、`isClosedStatus`(L46)、`isCompletedStatus`(L48)）→ TS2304 ×5。修复是恢复双名 import（`packages/core/issues/config/status.ts:1`，`import type { IssueStatus, IssueStatusCategory } from "../../types"` —— 两名都合法，因为 `IssueStatus = IssueStatusCategory` 是别名）。教训：**两侧改同一个 TYPE 声明区域时，审计要枚举 import/收窄轴，不能只枚举成员轴。**

两条审计 meta 教训（plan negative claims 留有 raw command 证据）：

- **diff hunk 头显示的是变更点之前最近的函数，不是被改的函数。** 一个 `@@ ... @@ func truncateFallbackCommentBody` 头一度被读成「modify/delete 碰撞」；raw `git diff v0.4.28..v0.4.29 -- service/task.go` 显示 +8 行是函数**之后**新增的无关常量（`RuntimeClaimFreshnessSeconds=150.0`），合并树中该函数只定义一次、调用点存活（plan negative claim 以 `git grep -c` 于 merge-tree 结果上证明）。
- **标题会说谎，blob 不会。** upstream commit `14c2e4e83` 标题 "archive retires without migration" 里的 retire 指 catalog 的 `archived_at` 退役机制（一个 status 从此不可再被指派，`issuestatus.go:237-241`），不是退役 fork 的 `archived` 状态值。按标题做影响面判断会得出「fork 的 archived 要被 upstream 删掉」的错误结论；按 blob（该 commit 对 fork 携带的 5 处 surface 零触碰）判断才是事实。

## Why This Matters

- **这是 compose-and-keep 押注的第一次事后兑付。** v0.4.28 决策篇的核心论点是「集中收口让未来升级的重放面最小」。v0.4.29 给出了实证：upstream 没有停手，而是在同一谓词族上继续加盖 category 过滤、category 分桶、category 响应填充三层新机制 —— 全部流经 `IsBuiltIn`/`IsCategory`，fork 补丁全部传递，server 零重放。若当年选择的是弥散补丁（五个破裂面各打一个），这三层新机制每一层都要重新审计、重新打一遍。
- **零重放 ≠ 零思考：陷阱轴发生了迁移。** v0.4.28 的问题是「补丁会不会被冲掉」（语义碰撞，全 gate 隐形）；v0.4.29 的问题是「两个各自正确的语义在新组合层怎么交互」（fork 的 archived-guard × upstream 的 category 展开拼出恒空谓词）。后者同样没有任何 gate 能抓 —— 空结果集不红不炸 —— 唯一暴露面是 fetchFirstPages 的**文本冲突标记**（运气：分桶拉取恰是 upstream 重写的核心区）和读 where 构造的人工推理。如果 upstream 下次改的是别处、冲突标记不出现，这类组合交互就全靠 Phase 1 领域审计问题：「fork 的谓词与 upstream 的新机制在同一 where 里如何组合？」
- **审计枚举必须覆盖命名面，不只是成员面。** 成员轴（union 里有没有 archived）被预测且被 auto-merge 化解；import 收窄轴没被枚举、成了唯一真实失败。这延续了 negative-claim 方法论：每个「不会坏」的结论都要有 raw command 证明，且失败模式预测清单本身要随「两侧都改过的区域类型」扩展 —— 这次新增的轴是「同区域 TYPE 声明的 import 行」。

## When to Apply

- upstream 继续演化 MUL-6243 category 机制（或任何以 `IsBuiltIn`/`IsCategory`/`Effective` 为键的新消费方）而 `archived` 仍是 fork 伪内置、PR #6106 仍 OPEN 的每一轮升级。
- 信号：upstream diff 触碰 `server/internal/issuestatus/`、`packages/core/types/issue.ts`、`packages/core/issues/config/status.ts`、`packages/core/issue-statuses/`、`packages/core/issues/queries.ts` 任一文件；或 upstream 重写 "accepts exactly N" 式测试钉。
- 重放检查清单（v0.4.29 后的最新形态，5 分钟走完）：① `issuestatus.go` 三触点存活（`Archived` 常量、`IsBuiltIn` 特判、`ActiveKeys` 尾巴）；② union 成员 + `STATUS_ORDER` 第 8 项在；③ `fetchFirstPages` 的 `include_archived: category === "archived"` 在；④ 两侧测试钉是 8 值（`queries.test.ts` + `issue_status_test.go`）；⑤ `pnpm typecheck` —— 它同时是新 import 收窄轴的第一捕捉器。
- 解 `queries.ts`/`status.ts` 一类「两侧都改」的冲突前，先读 server 的 where 构造证明组合语义，再落前端代码。
- **不再适用**：upstream 合入 #6106（archived 转正为原生第 8 category）、或 category 集本身扩容（CHECK 放开第 8 类）时 —— 届时 compose-and-keep 的「不可 seed」前提消失，需要重新决策（参考 v0.4.28 篇「拒绝的替代方案」节做反向评估）。

## Examples

**派生链全景**（两个源头 → 全部下游零代码正确）：

```text
packages/core/types/issue.ts:12-20        IssueStatusCategory 8 成员（auto-merge 拼 rename + fork 成员）
        ↓
packages/core/issues/config/status.ts:10  STATUS_ORDER[8]（含 "archived"）
        ↓
packages/core/issue-statuses/queries.ts:65  const BUILT_IN = new Set<string>(STATUS_ORDER)
        ↓ 派生
isIssueStatusCategory (queries.ts:67)   issueStatusCategory (status-category.ts:18)   statusCategoryOfKey (status-category.ts:33)
```

**server 面传递链**（零新代码，全走既有谓词）：

```text
入向: status_category=archived → splitCommaParam (issue.go:1169)
      → ExpandCategories (issue.go:1266): IsCategory("archived")=true (issuestatus.go:120→109)
      → catalog 无行 → self fill-in (issuestatus.go:381-388) → ["archived"]
      → i.status = ANY('{archived}') (issue.go:1272)
出向: issueToResponse: IsBuiltIn("archived") → StatusCategory="archived" (issue.go:273-276)
      Resolver.Effective built-in 快路径原样返回 (issuestatus.go:313-316)
```

**import 修复的 before/after**（本轮唯一 typecheck 失败，TS2304 ×5）：

```typescript
// upstream v0.4.29（收窄后）           // 合并树修复后（config/status.ts:1）
import type { IssueStatusCategory }     import type { IssueStatus, IssueStatusCategory }
       from "../../types";                     from "../../types";
```

**验证结果**（plan `docs/upgrades/v0.4.29-plan.md` Phase 5 逐项留痕 + 本 session 直查）：merge-tree 预测 2 处文本冲突 → 实际 2 处（连续第 10 次命中）；`pnpm typecheck` 修 1 处 import 后 6/6；`pnpm test` 375 files / 4438 tests 全绿、零 fork-code × upstream-test 碰撞（v0.4.20 曾有 14 处）；`go build`/`go vet` exit 0；`make sqlc` 再生成与合并树零漂移；`pnpm build` 3/3；go test 残差与合并前 baseline 集合相同（+2 个已留证的 timing flake）；生产 migrate 至 343、archived 267 行 / catalog 35 行完好、`/healthz` 200（本 session psql 与 curl 复核）。

## Related

- `docs/solutions/workflow-issues/fork-archived-status-semantic-collision-compose-into-upstream-issuestatus.md` — 前篇（v0.4.28 决策篇）：compose-and-keep 的判定与五处携带面清单；本篇是该决策的第一次升级实证（server 携带面零重放）。
- `docs/solutions/workflow-issues/auto-merge-semantic-collisions-same-symbol-and-fork-test-signature.md` — 碰撞分类学；本篇的 `include_archived` 组合交互是「补丁已存活之后」的新形态：不再是语义冲掉，而是语义组合。
- `docs/solutions/workflow-issues/run-typecheck-after-upstream-merge.md` — 本轮唯一的真实修复（恢复 `IssueStatus` import）由这道 tsc 门捕获，是该 gate 的最新判例；与 whole-module vi.mock 篇互为 compile / 执行两方向的镜像。
- `docs/solutions/test-failures/whole-module-vi-mock-shadows-new-named-export.md` — import 轴失败模式的执行方向镜像（typecheck 全绿、只有跑测试暴露）。
- `docs/solutions/workflow-issues/fork-customization-invariant-set-upstream-test-collision.md` — 两条人工轴之一的测试钉是「fork 不变量集合含测试」的前端实例。
- `docs/solutions/workflow-issues/negative-claim-must-prove-user-invariant.md` — 「每个 no-X 结论都要 raw command 证明」的方法论；本篇的 hunk 头误读与标题误读是它的两个新判例。
- `docs/solutions/workflow-issues/fork-to-upstream-pr-preparation.md` — #6106 备稿记录；upstream 若原生表达第 8 category，本文的「不再适用」条件即触发。
- `docs/upgrades/v0.4.29-plan.md` — 本轮升级的过程工件（Phase 1.4 逐文件策略表、14 条 negative claims、Phase 5 gate 记录），本文全部 session 事实的证据底稿。
