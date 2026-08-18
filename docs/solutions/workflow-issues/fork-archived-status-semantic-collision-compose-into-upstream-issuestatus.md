---
title: "Merge-clean semantic collision — fork archived status vs upstream MUL-6243 catalog: compose-and-keep as an 8th pseudo-builtin inside issuestatus, never a seeded category row"
date: 2026-08-18
category: workflow-issues
module: upstream-upgrade-merge
problem_type: workflow_issue
component: development_workflow
severity: high
applies_when:
  - "三方合并上游 release 时，上游用全新子系统替换 fork 定制所依附的旧机制（v0.4.28 MUL-6243：新 issue_status 表 + server/internal/issuestatus/ 包 + 7 个 canonical category 行为等价类），fork 定制（archived 状态，closed-NOT-completed 语义，267 行生产数据）与该系统语义相撞——文本几乎零冲突，纯上游代码会静默破坏 fork 数据语义"
  - "fork 的定制状态无法被上游新目录诚实表示：category CHECK 禁止第 8 个类；seed 成 cancelled 类的行会继承 counts-as-completed 语义（fork 明确拒绝）；上游 Resolve('archived') 返回 ErrUnknownStatus 使所有 archived 写入被 400 拒绝"
  - "在升级合并中决定 fork 领域语义在新上游系统上的存活形态：compose-and-keep（Archived const + IsBuiltIn 特例 + ActiveKeys 填充，作为第 8 个伪内置进新包）vs seed 为目录行 vs 死守旧守卫岛屿"
  - "v0.4.28 之后的每次升级需要重放 archived 携带面 5 处：issuestatus.go 补丁（Archived/IsBuiltIn/ActiveKeys 三触点）、issue.go 的 validIssueStatuses append 与搜索过滤尾巴、组合谓词位点（Go: github.go/issue_child_done.go 的 issueguard.IsClosedStatus(issuestatus.Effective(...))；SQL: issue.sql 三查询的 issue_effective_status(...) NOT IN ('done','cancelled') AND status <> 'archived'）、ChildIssueProgress archived 计数列、4 个重钉到合并后契约的测试"
  - "审计一个 merge-tree 报干净、但两侧领域语义（状态等价类、默认列表过滤、计数口径、写入校验）不相容的合并结果"
resolution_type: code_fix
tags: [upstream-upgrade, semantic-collision, fork-customization, issue-status, archived-status, compose-and-keep, issuestatus, three-way-merge]
related_components:
  - "server/internal/issuestatus/issuestatus.go"
  - "server/internal/issueguard/issue_status.go"
  - "server/internal/handler/"
  - "ChildIssueProgress archived count column"
---

# 上游在 fork 定制域「新建整个系统」时，零文本冲突 ≠ 语义兼容 —— 把 fork 的额外成员做成伪内置、挂进新系统的单一解析收口（Resolve/IsBuiltIn），而不是逐调用点打补丁

## Context（背景：本次遇到什么）

来自 v0.4.26 → v0.4.28 升级合并（全部改动在 v0.4.28 合并 `08c61c3ab` 中落地）。upstream MUL-6243 引入 per-workspace 自定义 issue status 目录：新表 `issue_status`（migration 332 起）、新包 `server/internal/issuestatus/`、一组配套 migration（332-340）。模型核心是 7 个 canonical category 作为**行为等价类**——category 的值就是 canonical status key，一个自定义 status 声明某个 category 就完整继承该 canonical 的平台行为（`server/internal/issuestatus/issuestatus.go:1-23` 的包注释）。

而 fork 一直带着自己的 `archived` 状态：fork migration `server/migrations/213_issue_status_archived.up.sql` 把它加进 status CHECK（DROP/重 ADD 包含 8 个值的 `issue_status_check`）。语义是 closed-not-completed——`closedStatuses = {done, cancelled, archived}` 而 `completedStatuses = {done, cancelled}`（`server/internal/issueguard/issue_status.go:28`、`:33`）——默认列表/看板/搜索里隐藏、不计入 done 统计、对 stage barrier 是终态。生产库有 267 行 archived issue（本 session 经 psql 验证，session-verified）；对应的 upstream PR #6106 仍处于 OPEN（session 查证）。

碰撞是**语义的，不是文本的**——但要精确地说清楚「哪里有冲突标记、哪里没有」：本次 23 处文件冲突中 11 处恰恰落在 status 域的**旧载体文件**（`cmd_issue.go`、`handler/{issue,github,issue_child_done}.go`、`queries/{issue,inbox,project}.sql` 等），冲突块就是被两侧反向改写的谓词行——这些是可见的，且会把解决者带到这个域。**真正零冲突的是新系统本体**：`issuestatus` 包与 migration 332-340 全是新增文件，无共同祖先、无冲突标记指向它们，而五个破裂面全部来自这些无冲突新文件与 fork 数据的交互。就算把 11 处谓词冲突「正确地」按文本解决（任选一侧），五个破裂面一个都不会消失——它们不是文本分歧，是模型分歧。纯 upstream 语义下，fork 的 archived 会在五个面上破裂：

1. `Resolve("archived")` 返回 `ErrUnknownStatus` → 每个写路径 400（CLI 写入同样走 API，一样炸）——`server/internal/issuestatus/issuestatus.go:218-242` 的 ErrNoRows 分支只对 7 个 canonical 放行；
2. 默认列表过滤 `issue_effective_status(...) NOT IN ('done','cancelled')` 让 archived 从 COALESCE fallback 漏回——migration 340 的 SQL 函数对未知 key 原样返回（`server/migrations/340_issue_effective_status_fn.up.sql:29-35`），archived 不在 done/cancelled 里，**重新出现在默认列表**；
3. archived 计为 active duplicate（重复检测认为它还活着）；
4. archived 子 issue 不算 terminal，永远卡住 parent 的 stage barrier；
5. `ChildIssueProgress` 丢掉 fork 的 archived 计数列。

「把 archived seed 成一条 catalog 行」走不通，且是被 upstream 模型本身堵死的：category CHECK 只允许 7 类（`server/migrations/332_issue_status.up.sql:38-40`），而挂到 `cancelled` 类意味着完整继承 cancelled 行为——counts-as-completed、auto-archive——**恰好是 fork archived 语义明确拒绝的两条**。第 8 个行为等价类在 upstream 的 one-to-one 模型里没有表达位。

用户决策：**compose-and-keep**——保留 fork 的 archived 语义，把它组合进 upstream 的新系统。

(session history) 这不是 fork 升级碰撞的第一个新类别，而是碰撞分类学阶梯的最新一级：此前四轮升级已逐级发现 checkout-theirs 静默丢失（v0.4.20）、add/add 盲点（v0.4.20）、同符号异区重复与 fork-test×upstream-签名（v0.4.25 形式化）、package-init panic（v0.4.26）——每一级首次出现时都恰好落在当时 gate 清单的盲区。模式先例则是 v0.4.24 的 Strategy-D compose 判例：upstream MUL-6050 接管 prefix 机制层、fork 的正交片段（`InviteeName`）在 upstream 框架内重新安放——本次只是把「正交片段」升级成了「与 upstream 新子系统同构的整个概念」。

## Guidance（正确解法：挂进新系统的单一解析收口）

**原则：当 upstream 在 fork 已有定制的领域新建了一个带「唯一合法入口」的系统时，fork 的额外成员要伪装成该系统认识的东西、挂进那个入口，而不是在每个出问题的调用点各打一个补丁。** 本次收口是 `Resolve`/`IsBuiltIn`：fork 对新包的改动集中在 `server/internal/issuestatus/issuestatus.go` 一个文件、3 个触点。

1. **`issuestatus.go` 三触点**：

   - `Archived = "archived"` 常量（`issuestatus.go:104`），注释明确它没有 canonical category、不进 `canonicalOrder`（`:97-103`）；
   - `IsBuiltIn` 特判 archived（`issuestatus.go:108-114`）——这是杠杆支点：`Effective` 的 built-in identity 快路径流经 `IsBuiltIn`（`:190-205`），所以 `Effective("archived")` 原样返回且零 DB 查询，**`Effective` 一行未改**；`Resolve` 的 ErrNoRows 分支里 `IsBuiltIn("archived")` 为真 → `builtInEntry` 合成一条 `Category: key` 的行（`:228-231`、`:248-255`），写路径放行。Category 不是 7 类之一，所以按 canonical category 消费的地方自动回落——`CategoryRank` 对未知名返回 `len(canonicalOrder)` 排最后（`:123-128`），与 issue 列表排序 CASE 里 `WHEN 'archived' THEN 7` 一致（`server/internal/handler/issue.go:1138`）；显示归 fork 前端 status config 所有；
   - `ActiveKeys` 尾部 fill-in 追加 archived（`issuestatus.go:279-284`），保证错误信息「永远不会漏掉一个 Resolve 接受的 key」。

   刻意保持 upstream 形状的部分：`Canonical()`/`canonicalOrder` 仍是 7（`:56-64`），migration 339 的 seed 仍只播 7 条（`server/migrations/339_seed_issue_status_catalog.up.sql:11-24`）——upstream 未来对 seeding、ranking、目录管理的演化不会与 fork delta 交叠。

2. **`server/internal/handler/issue.go`**：issue-table 分组/过滤用的 `var validIssueStatuses = append(issuestatus.Canonical(), issuestatus.Archived)`（`issue.go:99-102`；写路径不走它，走 `resolveIssueStatusKey` → `Resolve`，400 报错信息用 `ActiveKeys` 列出合法值，`issue.go:104-139`）。默认 open 过滤组合为「upstream 的 effective 谓词 AND fork 的显式排除」：`issue_effective_status(i.workspace_id, i.status) NOT IN ('done','cancelled') AND i.status <> 'archived'`（搜索路径 `issue.go:614-616`）。

3. **谓词组合模板**——fork 和 upstream 把同一行谓词往相反方向改写的两处（`server/internal/handler/github.go`、`server/internal/handler/issue_child_done.go`）——Go 侧统一为 `issueguard.IsClosedStatus(issuestatus.Effective(ctx, q, wsID, status))`，两套语义同时保住：archived 经 identity 路径映射回自己、被 closed 集合捕获（closed-not-completed）；自定义 done/cancelled 类 status 被 `Effective` 折叠成 canonical、变成 terminal。见 `server/internal/handler/github.go:1671-1677`（PR merged 重评估跳过 closed-not-completed）与 `server/internal/handler/issue_child_done.go:84-85`（stage barrier 的 terminal 判定，`isTerminalChildStatus` 直接委托 `issueguard.IsClosedStatus`，`:358-362`；fork archived 经 closed 集把 parent park 住，`:99-104`）。

4. **SQL 组合**（`server/pkg/db/queries/`）：

   - 需要双保险的（两个语义都要求排除 archived）：`issue.sql` 的 `FindActiveDuplicateIssue`（`:182-191`）、`FindRecentAutopilotDuplicateIssue`（`:193-211`）、`ListOpenIssues`（`:238-248`）——effective NOT IN 与 `status <> 'archived'` 两段并列，与 handler 搜索过滤同构；
   - 保留 fork 列的：`ChildIssueProgress` 在 upstream 的 effective done 计数旁边保住 fork 的 `COUNT(*) FILTER (WHERE status = 'archived')::bigint AS archived`（`issue.sql:400-408`）；
   - 直接取 upstream 形式的：`inbox.sql` 的 `ArchiveCompletedInbox`（`:144-151`）与 `project.sql` 的 `GetProjectIssueStats` done_count（`:61-67`）——两套语义在「archived 不算 completed」上天然一致，无需 guard。

5. **测试钉故意重写**（auto-merge 会产出互相矛盾的契约——测试也是不变量集合的一部分）：`TestValidateIssueStatusArchived`（`server/cmd/multica/cmd_issue_test.go:3741-3772`，MUL-6243 后 CLI 校验只管 format，钉 archived 本地通过、malformed 报错信息列出 archived）；`TestUnseededWorkspaceStillAcceptsBuiltInStatuses`（`server/internal/handler/issue_status_test.go:110-148`，钉 ActiveKeys = 7 + archived，`:143-147`）；`TestBuildSearchQuery_SingleTerm`（`server/internal/handler/search_test.go:8-44`，钉组合后的过滤串，`:38-43`）；`TestValidIssueStatuses` 钉 8 个成员（`cmd_issue_test.go:2743-2762`）。

**验证**（session-verified）：handler 集成测试跑在迁移 1-341 的全新 dev DB 上（刷新 dev DB 是本次 session 的支线任务），只有既档的 6 个 pre-existing residual、零新增；生产库 migrate 到 341 后 267 行 archived 完好；migration 337 按设计 DROP 掉 fork 在 213 里重建的 `issue_status_check`（`server/migrations/337_issue_status_open_check.up.sql:12-17`），留下的 format CHECK `^[a-z0-9][a-z0-9_]{0,31}$` 对 `archived` 恒真，全部 archived 行通过。

**拒绝的替代方案**：(a) 放弃 fork archived、把 267 行迁到 cancelled 类自定义 status——语义漂移（counts as done + auto-archived），否；(b) seed 成 catalog 行——被 category CHECK 和 cancelled 继承堵死（见 Context）；(c) 保留 fork 的 `NOT issue_status_is_closed(status)` 谓词原文——会静默丢掉 upstream 对自定义 status 的 terminal 处理（自定义 done 类 duplicate 会一直被当 active）。

## Why This Matters（为什么零冲突反而是最危险的信号）

3-way merge 对**文本 hunk** 推理。当 upstream 在 fork 已有定制的领域新建一个系统时，新系统的文件（全新、无共同祖先）不会产生任何冲突标记，而五个破裂面恰恰全部住在新系统的语义里；旧载体文件上的谓词冲突（本次 23 处中的 11 处）虽然可见，但冲突标记只告诉你「两侧改了同一行」，不携带「第 8 个成员在新模型里如何表达」的决策信息——按文本惯例选边解决（甚至选对边）也不能闭合破裂面。这与 Strategy D（同域签名碰撞，`go build` 可见）不同：模型分歧在 merge-tree、typecheck、go vet 里全部隐形，只有领域推理（「fork 的成员在新系统的词汇表里叫什么？」）能发现。检测面（跑 upstream 新测试，见不变量集合学习）与解法面（本学习的收口组合）是同一问题的两半。

(session history) 放进碰撞分类学阶梯看，这一级比之前所有级别都危险：同符号重复（typecheck 抓）、签名漂移（go vet 抓）、init panic（`go test` 抓）至少都有对应 gate；本类在合并后 typecheck/go vet/pnpm test **全绿**（3 个测试钉是被故意重写到组合契约的，没有任何东西失败）。换言之 Verification Gate Ladder 上没有任何一级能看到它——唯一防线是 Phase 1 审计里的领域级问题：「upstream 的新系统对 fork 已有数据意味着什么」。此前每轮新碰撞类首次出现时（v0.4.20 checkout-theirs、v0.4.25 同符号、v0.4.26 init panic）都恰好落在当时 gate 清单的盲区，这一规律本身已多次应验。

**集中 vs 弥散**：如果给五个破裂面各打一个补丁，fork delta 会弥散在 handler、SQL、CLI 各处，下次升级每一处都要重新审计，且每一处都可能被 upstream 的下一步演化再次冲掉。实际解法把 fork delta 收敛进新包一个文件的 3 个触点——一个布尔特判激活两条既有路径（`Effective` 的 identity 快路径、`Resolve` 的 ErrNoRows 放行）——`Canonical`/seed 保持 upstream 形状，未来升级该域的重放面最小。

**「不可 seed」是模型必然，不是工程懒惰**：upstream 的 one-to-one 模型里 category 就是行为等价类，archived（closed-not-completed）与 7 类中任何一个都**不**行为等价——挂进任何一类都是语义说谎。伪内置是唯一既让新系统认识它、又不让它说谎的位置：`Resolve`/`ActiveKeys`/`Effective` 认识它（可写、可列、identity），`canonicalOrder`/category 体系不认识它（不 seed、不排名、不进等价类）。

## When to Apply（什么时候遇到）

- 升级合并时，upstream **新建**的包/表/子系统落在 fork 已有定制的同一领域——尤其新系统带一个「唯一合法入口」函数（本次是 `Resolve`/`Effective`；同类信号：`ValidateKey`、`Ensure`、SQL 侧 mirror 函数 `issue_effective_status`）。
- 信号：该域**零文本冲突或极少冲突**。这不是安全信号，是该停下来问「fork 的成员在新系统的词汇表里叫什么」的信号。
- 判据：fork 的额外成员能否诚实表达为新系统的范畴（catalog 行/自定义类型）？若被约束（CHECK、唯一索引）或语义继承（继承 done/cancelled 行为）排除，则走伪内置组合。
- 已知重放清单（auto memory 记录，v0.4.28 起有效），共 5 处携带面：① issuestatus 补丁（`Archived`/`IsBuiltIn`/`ActiveKeys` 三触点）；② `issue.go` 的 `validIssueStatuses` append 与搜索过滤尾巴；③ 组合谓词位点（Go 侧 `github.go`/`issue_child_done.go`，SQL 侧 `issue.sql` 三查询的 guards）；④ `ChildIssueProgress` 计数列；⑤ 测试钉（`TestValidateIssueStatusArchived`/`TestUnseededWorkspaceStillAcceptsBuiltInStatuses`/`TestBuildSearchQuery_SingleTerm`/`TestValidIssueStatuses`）。未来每次 upstream 升级若重写 issuestatus 域，这 5 处就是不变量集合（同 invariant-set 学习），缺一处即复发对应破裂面。
- 次级规则：SQL 过滤若要同时保住两套语义，组合成「upstream effective 谓词 AND fork 显式排除」；若两套语义在该查询上天然一致（archived 在两边都不算 completed），直接取 upstream 形式，不加冗余 guard。
- (session history) 定向测试选择必须覆盖 fork 语义热点：`TestValidIssueStatuses` / `TestValidateIssueStatusArchived` 是编码 fork 8-status 语义的执行级测试（v0.4.26 曾因只跑 `-run 'Workspace'` 没碰到它们而漏掉红测试事件），升级 Phase 5 的 go test 选择要显式包含。

## Examples（实例：本次的组合面）

### 1. 收口：一个文件、三个触点

```go
// server/internal/issuestatus/issuestatus.go:104
const Archived = "archived"

// :108-114
func IsBuiltIn(key string) bool {
	if key == Archived {
		return true
	}
	_, ok := canonicalRank[key]
	return ok
}

// :279-284（ActiveKeys 尾部 fill-in）
if !seen[Archived] {
	keys = append(keys, Archived)
}
```

`Effective` 与 `Resolve` 一行未改却都「学会」了 archived：`Effective` 的 identity 快路径先查 `IsBuiltIn`（`:191`），`Resolve` 的 ErrNoRows 分支 `IsBuiltIn(key)` 为真时返回 `builtInEntry(workspaceID, key)`（`:228-231`）——合成行的 `Category: key`（`:248-255`）不是 7 类之一，category 消费方按 raw key 回落。这就是「挂进收口」的杠杆：一个布尔特判激活两条既有路径，五个破裂面同时闭合。

### 2. 谓词组合：反向改写的同一行

stage barrier 处，fork 与 upstream 把同一行谓词往相反方向改写——fork 要 archived 算 terminal，upstream 要自定义 done/cancelled 类算 terminal。组合式两边都赢：

```go
// server/internal/handler/issue_child_done.go:84-85
prevTerminal := isTerminalChildStatus(issuestatus.Effective(ctx, h.Queries, prev.WorkspaceID, prev.Status))
nowTerminal := isTerminalChildStatus(issuestatus.Effective(ctx, h.Queries, issue.WorkspaceID, issue.Status))
```

`isTerminalChildStatus` 直接委托 `issueguard.IsClosedStatus`（`:358-362`），closed 集 = {done, cancelled, archived}（`server/internal/issueguard/issue_status.go:28`）。archived 经 `Effective` 原样返回 → closed（park 住 parent，`:99-104`）；自定义 done 类经 `Effective` 折叠为 done → closed（关 stage）。`server/internal/handler/github.go:1671-1677` 的 PR-merged 重评估同构。

### 3. SQL：三种组合姿势

```sql
-- 双保险（issue.sql:246-247，ListOpenIssues；FindActiveDuplicateIssue :185-186 同构）
AND issue_effective_status(i.workspace_id, i.status) NOT IN ('done', 'cancelled')
AND i.status <> 'archived'

-- 保留 fork 列（issue.sql:403-404，ChildIssueProgress）
COUNT(*) FILTER (WHERE issue_effective_status(workspace_id, status) IN ('done', 'cancelled'))::bigint AS done,
COUNT(*) FILTER (WHERE status = 'archived')::bigint AS archived

-- 直接取 upstream 形式（inbox.sql:150，ArchiveCompletedInbox；project.sql:64 同）
AND issue_effective_status(workspace_id, status) IN ('done', 'cancelled')
```

第三种不需要补 `OR status = 'archived'` 之类的 guard：fork 语义里 archived 本来就**不**算 completed，两套语义在此收敛——guard 反而是噪音。判断标准回到判据本身：该查询在两套语义下要的答案是否相同。

## Related（相关文档）

- `docs/solutions/workflow-issues/auto-merge-semantic-collisions-same-symbol-and-fork-test-signature.md` — **最近亲**：该文档把 merge-tree 盲区形式化为两级碰撞类（同符号异区、fork-test×upstream-签名，分别由 typecheck/go vet 兜底）；本条是该分类学的**第三类**（fork-数据语义 × upstream-新系统）——前两类有编译 gate 兜底，本类在全部 gate（含执行级）隐形，只有 Phase 1 领域审计可见。
- `docs/solutions/workflow-issues/safe-upstream-upgrade-with-local-customizations.md` — 升级 SOP 总纲；本条的「收口组合」是其 Step 4 策略表（A-D）之外的新判例：upstream 新系统语义收编 fork 定制域时的第五种策略（compose-into-the-new-system）。
- `docs/solutions/workflow-issues/fork-customization-invariant-set-upstream-test-collision.md` — 姊妹篇：那条讲**检测面**（fork 定制是 code+test 不变量集合，只有跑 upstream 新测试暴露碰撞），本条讲**解法面**（碰撞暴露后如何把两个系统组合起来）。同一升级家族的两个面。
- `docs/solutions/workflow-issues/fork-to-upstream-pr-preparation.md` — #6106（fork archived 的 upstream PR，仍 OPEN）的备稿记录；v0.4.28 后该 PR 的下一次 rebase 除迁移重编号外还必须对 issuestatus catalog 做语义和解——fork 本地的 compose-and-keep 就是它需要原生表达的参考形态。
- `docs/solutions/workflow-issues/negative-claim-must-prove-user-invariant.md` — 本碰撞是该方法论的又一判例：所有代理信号（干净合并、typecheck、vet、绿测试）全绿，只有行为级审计问题（upstream 新系统对 fork 数据语义意味着什么）暴露碰撞。
- `docs/solutions/workflow-issues/upstream-orthogonal-signature-double-change-blindspot.md` / `upstream-single-sided-fork-param-convergence-merge.md` — Strategy D 同域**文本**碰撞族（签名级，`go build` 可见）；本条是零文本冲突的**语义**碰撞变体。
- `docs/solutions/workflow-issues/merge-keep-both-shared-context-brace-trap.md` — v0.4.18 时代 KEEP-BOTH 冲突里保下来的 `TestValidateIssueStatusArchived`，在本次被**故意重写**（MUL-6243 后 CLI 校验从成员制变 format-only）——测试钉本身也是要随系统演化重放的定制。
- `docs/solutions/workflow-issues/unledgered-carried-customization-blindspot.md` — 5 处携带面必重放清单的账本视角；本条给出该清单在 v0.4.28 后的最新形态。
- `docs/customizations.md` — 定制账本（archived 行 + 2026-08-18 顶部审计行）；`docs/upgrades/v0.4.28-plan.md` — 本次升级的过程工件（Phase 1 逐文件策略表 + verified negative claims），本条学习的证据底稿。
