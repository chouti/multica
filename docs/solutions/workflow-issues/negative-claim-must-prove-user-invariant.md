---
title: "Negative-claim verification must prove the user-visible invariant, not its symbol proxy — two blind-spot failures in one upgrade audit (silent call-site loss + D(b)→D(a) reversal)"
date: 2026-08-11
category: workflow-issues
module: upstream-upgrade-merge
problem_type: workflow_issue
component: development_workflow
severity: high
applies_when:
  - "Verifying a 'no X' negative claim during a self-host fork upgrade pre-merge audit (e.g. 'no duplicate-symbol hazard', 'no lost fork feature')"
  - "Running grep / ast / symbol-count / file-presence commands to confirm a fork-only definition or feature survived a 3-way auto-merge"
  - "Deciding whether a Strategy D(b) 'preserve fork feature' recommendation is warranted before reading upstream's replacement machinery"
  - "Any code review or audit step where the verification target is a proxy (definition, declaration, file presence, hook name) for a user-visible runtime invariant (call-site liveness, feature behavior, server-cursor coverage)"
  - "Adversarial verification of auto-merge output where both sides compiled clean and all tests passed but semantic correctness is still unverified"
tags:
  - upstream-upgrade
  - negative-claim
  - verification-discipline
  - pre-merge-audit
  - call-site-liveness
  - user-invariant
  - three-way-merge
  - self-host
---

# Negative-claim verification must prove the user-visible invariant, not its symbol proxy — two blind-spot failures in one upgrade audit (silent call-site loss + D(b)→D(a) reversal)

## Context

这份 learning 来自 self-host Multica fork 从 `v0.4.21` 升级到 `v0.4.22` 的合并审计（merge commit `7206599e2`，2026-08-11，reachable from current `main`；升级全过程留档于 `docs/upgrades/v0.4.22-plan.md`，持久化账本 `docs/customizations.md`，本次合并条目标记为 "Last upgrade — v0.4.21 → v0.4.22"）。

这个 fork 的每次升级都跑一套对抗式审计（adversarial pre-merge audit）：Phase 1 先对每个潜在碰撞点给出一个 negative claim（"本轮 X 危险没有触发"）外加一条 `verified_by` 命令作为证据；后续 Phase（Phase 4 的语义横扫 agent，即"C4"）再沿调用链反向复查这些 claim。这套流程已经沉淀在 `upgrade-upstream` skill 和大量 `docs/solutions/workflow-issues/` sibling 文档里，本不应再出问题。

但 `v0.4.21 → v0.4.22` 这一次，对抗式验证的纪律在**同一个 session 里连续失败两次**，而且失败的是同一类：**`verified_by` 命令证明的是"用户可见不变量"的代理（proxy），而不是不变量本身。** 两次失败各自的形态不同（一个是 call-site 静默丢失，一个是策略方向 D(b)→D(a) 反转），但根因是同一个：审计员回答了字面问题（"这个符号还在吗 / 唯一吗"），却没回答真正该问的问题（"用户依赖的那条运行时行为还活着吗"）。

事后回看 session history（见下文 Why This Matters），这个盲点并非 v0.4.22 的一次性事件——同样的 definition-count proxy grep 在 `v0.4.15 / v0.4.18 / v0.4.19 / v0.4.21` 四次连续升级里都被用来验证同一个 `truncateFallbackCommentBody` claim，v0.4.15 甚至明确发现过死代码分歧却没能让它沉淀成 gate。v0.4.22 只是第一次把它升格成正式方法论。

本 doc 不再重复 `upgrade-upstream` skill 里已有的冲突解决 SOP，也不重复 `docs/solutions/workflow-issues/upstream-orthogonal-signature-double-change-blindspot.md`（Strategy D 签名轴盲区）或 `fork-customization-invariant-set-upstream-test-collision.md`（fork 定制是不变量集合、用 upstream 新测试做探测器）。它专门讲**审计 Phase 1 写下 negative claim + `verified_by` 命令那一刻的方法论**：当你说"X 没了 / X 没触发"时，你写的那条 grep / build / test 命令到底证明了什么、漏掉了什么，以及如何在这一步就自我拦截。

## Guidance

**核心方法：写下任何一条 negative claim 时，强制跑三问自检。** 在 `verified_by` 命令定稿之前，对每一条 "no X" 结论，问下面三个问题。任一问答错或没答，这条 claim 就不能进入 Phase 1 的账本。

### 第 1 问：Proxy vs invariant —— 你的命令证明的是不变量，还是不变量的代理？

把 negative claim 翻译成"用户/生产真正依赖的那条行为是什么"，然后选一条**直接证明该行为**的命令，而不是证明某个符号的字面存在/唯一。

- 错误形态（`v0.4.22` task.go 这次就掉在这里）：claim 是"GH #5455 保护本轮没被破坏"，`verified_by` 却写成 `grep -c '^func truncateFallbackCommentBody' server/internal/service/task.go`（只数 `func` 定义行）。这条命令正确回答了"定义是否唯一"（=1），但**根本没触碰**"保护是否在运行时生效"这个真正的问题。
- 正确形态：`grep -n 'truncateFallbackCommentBody' server/internal/service/task.go` —— 不带 `-c`、不锚定 `^func`，**打印所有出现位置**（定义处的引用 + 调用点）。这条命令的输出里必须能看到调用点那一行，否则保护就是 disarm 的。

差别的物理意义：定义唯一 ≠ 保护生效。`truncateFallbackCommentBody` 可以在 `server/internal/service/fallback_comment_truncate.go:16` 定义得唯一且正确，但只要合成成功评论路径（`server/internal/service/task.go:3565`）没有 invoke 它，GH #5455 的执行流泄露保护就在生产里完全失效——而编译器不会吭声，测试也不会吭声（这条路径没有专门的 runtime 断言去校验"超长 dump 没进 timeline"）。

### 第 2 问：Replacement —— 我以为"丢了"的东西，是不是被一个等价/更强的机制替换掉了？

语义重构（semantic refactor）是这一问的高发区。当你发现"fork 的符号 X 没了"，在把它判为"功能丢失、需要 restore"之前，**必须先读 upstream 在同一区域引入的 replacement**，并验证这个 replacement 真的覆盖了同一个不变量。

- 错误形态（`v0.4.22` use-issue-surface-data.ts 这次就掉在这里）：Phase 1 发现 fork 的 per-status load-more hooks（`useLoadMoreByStatus`、`myIssuesOpts` / `myIssuesScope` / `myIssuesFilter`）从合并后的树里消失了 ~273 行，直接判"assignee 维度分组丢失"，推荐 Strategy D(b) "保留 fork 特性"，预估要手工恢复 ~6 个文件 ~500 行 + Phase 5 typecheck 循环引用风险。**这条推荐在被采纳之前，从没读过 upstream 的 replacement。**
- 正确形态：在写 D(b) 推荐之前，先打开 `packages/views/issues/surface/use-issue-group-branches.ts`，读 upstream 新引入的 `IssueGroupBranches` 形状。读过之后会看到：`pagination: Record<string, IssueGroupPageState>`（`use-issue-group-branches.ts:44`）+ `loadMoreGroups: () => void`（`:51`），是一套**服务端游标分页**，覆盖 status / assignee / project 三个维度、共享一个 server cursor、pagination state 服务端自洽。Fork 的那套 client-accumulating load-more 是它的严格子集。换句话说：**"hooks 没了"是对的，"功能没了"是错的。**

"X 没了"这条 negative claim 本身**没错**；错的是它的**隐含推论**"X 提供的能力因此也没了"。第 2 问就是用来拆掉这个隐含推论的：在 Phase 1 就强制读 replacement，能把一条 D(b)（~500 行手工恢复 + 循环引用风险）直接消解为 D(a)（~0 行恢复）。本次 session 最终就是用户读到 replacement 之后切到 D(a) 的。

### 第 3 问：Translate symbol → behavior —— 把"X 还在"翻译成"行为 Y 还成立"，选一条证明 Y 的命令。

前两问的实操落点。把 claim 重写成行为陈述，再选命令：

- "truncateFallbackCommentBody 定义唯一" → 重写为"合成成功评论路径仍在调用 truncateFallbackCommentBody 并把 `task.ID` 作为 source_task_id 透传"。证明命令：`grep -n 'truncateFallbackCommentBody\|createAgentComment' server/internal/service/task.go | grep -A1 truncateFallback`，或干脆 Read `task.go:3560-3566` 肉眼确认调用点。
- "use-issue-surface-data.ts 没有 fork 的 load-more hooks" → 重写为"看板仍按 assignee 分组、archived 默认隐藏、分页游标由服务端下发"。证明命令：先 `grep -n 'IssueGroupBranches\|loadMoreGroups\|pagination' packages/views/issues/surface/use-issue-surface-data.ts`（确认 replacement 在场），再打开 `use-issue-group-branches.ts:44-51` 确认它覆盖了 fork 原本覆盖的维度。

注意：第 3 问的命令通常**不止一条**，而且常常需要 Read 一个片段而不是 grep 一个符号。这是预期的——negative claim 的代价就该如此。"一条 grep 敲定"的 claim，往往就是 proxy-blindfold 的高危信号。

### 再查规则（re-examination rule）

如果一条 Phase 1 negative claim 在 Phase 4 被同一个 upstream 代码库的反向复查**推翻**（无论是"保护其实没生效"还是"功能其实没丢"），**修复动作绝不是只把新命令 append 到原 claim 后面**。正确的动作是：把 Phase 1 在同一 session 给出的**所有** negative claim 全部重新拉出来，按同一个 blind-spot class 再过一遍——因为它们是用同一套错位的 `verified_by` 方法论写出来的，一条暴露意味着其余的同类风险未暴露。

本次 session 的 task.go 那条 claim 在 Phase 4 被翻盘时，如果只 append 新命令、不回头扫，`use-issue-surface-data.ts` 的 D(b)→D(a) 错判就会一路带到合并提交。事实上这两条是在 Phase 4 里几乎同时被发现的——靠的就是"一条翻盘 → 立刻按同一 class 复扫其余 claim"的纪律，而不是各自独立的偶然发现。

## Why This Matters

这个失败模式在**每一层防御里都是静默的**，这是它比 sibling 文档里那些"至少有一层会叫"的失败更危险的地方。

先看 task.go 这一案。3-way auto-merge 在这里交出了完美答卷：fork 改的是定义区（把 `truncateFallbackCommentBody` 挪到 fork-only 的 `server/internal/service/fallback_comment_truncate.go`），upstream 改的是调用区（在 `task.go:3565` 包了一层 `truncateFallbackCommentBody(...)` 调用）。两侧改的是**同一文件的不同区域**，从 3-way merge 的视角每一边都"clean"——于是 auto-merge 老老实实把两边合并进同一棵树。这棵树：

- **编译通过**（定义还在、调用点引用的符号也存在，Go 不会报"未使用"或"未定义"——因为调用点的符号在 fork-only 文件里定义着，编译器只关心引用可解析，不关心调用点是否真的 invoke 了它）；
- **测试全绿**（本次 session 的审计记录显示合并后树通过了完整的测试套件——`pnpm test` 326 files / ~3867 tests——但没有任何一条断言"超长 dump 没进 timeline"这种运行时性质，所以 GH #5455 的保护被 disarm 这件事对测试是不可观测的；Go 侧的 `TestTruncateFallbackCommentBody` 只隔离测了截断函数本身，没测调用点是否仍 invoke 它）；
- **merge 报告 clean**（无 textual conflict）。

三层全绿，但生产里合成成功评论路径会原样把一份 200KB 的执行流 dump 灌进 issue timeline——GH #5455 当初要堵的那个东西，原封不动地回来了。唯一能发现它的是 Phase 4 那个沿调用链 Read 调用点的语义横扫 agent（C4），它读到 `task.go:3565` 发现 wrapping 不在，才把这条 disarm 揪出来。

再看 use-issue-surface-data.ts 这一案。Phase 1 的 negative claim "fork 的 load-more hooks 没了" **本身为真**——hooks 确实没了（当前树里 `grep -rn 'useLoadMoreByStatus\|myIssuesOpts\|myIssuesScope\|myIssuesFilter' packages/views/issues/surface/` 返回空，D(a) 已落地）。但它的**隐含推论** "assignee 分组能力因此丢了"为假——upstream 的 `IssueGroupBranches` + `pagination: Record<string, IssueGroupPageState>` + `loadMoreGroups` 是更强的 server-cursor 替代。如果 Phase 4 没有强制读 replacement，这个隐含推论就会变成一条 ~500 行的 D(b) 手工恢复任务，凭空把一个上游已经用更好方式解决过的问题重新解决一遍，还顺带引入 Phase 5 typecheck 循环引用风险。

### (session history) 这个盲点不是 v0.4.22 的一次性事件，而是跨 5 次升级的慢性病

事后用 ce-compound 的 session-history probe 回扫 `v0.4.15 → v0.4.22` 五次升级的会话记录，发现同一个 `truncateFallbackCommentBody` 死代码盲点在**四次更早的升级里**都被同一条 definition-count proxy grep 验证过：

- **v0.4.15**（2026-07-31）：审计 agent 其实**明确发现过**这个分歧，原话是"⚠️ 但发现一个**非阻塞行为分歧**：合并后 task.go 调用点直接 `redact.Text(body)` 不做截断，fork 的 200-rune cap 变死代码（仅自测覆盖）……留给 fork owner 决定 keep/re-wire/drop"。这就是 v0.4.22 那条 finding 本身——但被框成"非阻塞产品决策"。
- **v0.4.18**（2026-08-05）：进一步降级成"upstream 一直就自己实现 truncate (cap=8000)... fork 的 cap=200 是更保守的安全选择——这是产品决策不是合并问题"。call-site 死代码这条线从审计里消失，只剩"两个产品两个 cap，都能编译"。
- **v0.4.19 / v0.4.21**（2026-08-06 / 08-07）：只剩 definition-count grep（"全包只有一份定义，无 redeclaration"），死代码分歧彻底从审计 narrative 里消失。

为什么 v0.4.15 那次发现没能阻止后续四次复发？**(session history)** 因为那条发现**只活在 assistant 的 prose 里**，没有进任何 `verified_by` 字段、没有进 memory、没有进 solutions doc。negative-claim 账本里记录的是"no redeclaration ✓ verified_by grep"——一条关于**符号生存**的真 claim；而那条关于**调用点存活**的真问题，因为没有被写成 claim、没有被赋 `verified_by`，下一次审计的 agent 根本看不见它。**prose 里的发现不会自动在下一次审计里重新浮现；只有写进 `verified_by` / memory / solutions doc 的发现才会。** 这是本 doc 的一条次级教训：审计里任何一条"非阻塞观察"，只要它描述的是一个会在下次合并里复发的结构性事实，就必须把它升格成 claim（带 `verified_by`）或 memory，否则它就是一次性的。

### (session history) 仓库现有的三道 fork-member 防线，全部检查"在场"而非"被调用"

这个盲点之所以能连续穿透五次审计，是因为仓库里已有的三道防线**在结构上**都查的是成员在场（membership），不是成员可达（reachability）：

1. **Definition-count grep**（`grep -rn "func <symbol>"` 返回 1）—— 证明符号被定义，不证明任何运行时调用点还连着它。
2. **Phase 5 `go build` / `go vet`** —— 对 Strategy D 的**签名**错配有效（陈旧的 7 参调用对 9 参定义是编译错误，v0.4.20 的 `task_source_task_id_test.go` 就是这么被抓的），但对 truncate 这类**行为保持型**重接完全失明：`redact.Text(body)` 是一个完全合法、编译通过的调用，它只是静默绕过了 fork 的 cap。`go build` 对"调用图里少了一条边"是不可观测的。
3. **Loss scan `flat(fork) − flat(now) == ∅`**（v0.4.20 引入，见 `fork-customization-invariant-set-upstream-test-collision.md`）—— 对 locale key 和 code symbol 查的是"成员是否存在"。`fallback_comment_truncate.go` 文件在场、符号定义在、loss scan 就 pass。它找的是**缺失的成员**，找不到**在场但已无人调用**的成员。

**call-site liveness 不是 membership 的特例，是一个独立的、目前仓库方法论里没有任何 gate 覆盖的维度。** 本 doc 的三问自检（尤其第 1 问 + 第 3 问的"翻译成行为"）就是给这层维度补的第一个 gate。这不是把现有三道防线修一修就能覆盖的——它们的查询语义（"X 在不在树里"）和这条不变量（"X 还在不在运行时调用图里"）根本不同。

### 下游传播

negative claim 一旦从 Phase 1 进了账本，后续 Phase 默认不再 re-touch 它——审计流程对"已验证结论"是信任的。所以一条错的 negative claim 不是停在原地的一个污点，它会作为既成事实被后续每一步消费：Phase 3 的 risk register 抄它、Phase 5 的 typecheck 把它当 baseline、最终 PR description 把它当卖点。错位 `verified_by` 写下的那一刻，错误就已经开始向生产单向传播，中间没有任何自动 gate 会重新质问它。唯一能打断传播的是"Phase 4 沿调用链 / replacement 语义复查 + 同 class 复扫"这条纪律——也就是本 doc 的方法。

## When to Apply

在以下任一场景写 negative claim 时，强制跑三问自检 + 再查规则：

- **self-host fork 的任何一次 upstream 升级合并**（`v0.4.x → v0.4.y`）的 Phase 1 审计。尤其当 fork 在合并前已经把某个函数 / hook / 符号"搬过家"（搬到 fork-only 文件，或改过签名）——这是 proxy-blindfold 的高发结构，因为"符号唯一性"会和"调用点是否仍 invoke"解耦。
- **任何对抗式 code review / pre-merge audit** 里写下 "no X" 类结论时。典型信号词：`grep -c` 返回 1、"定义唯一"、"无 conflict"、"typecheck green"、"测试全绿"被当作语义不变量的证据使用时。
- **语义重构后的对比审计**（upstream 把一组 client-side 抽象换成 server-side 抽象、把一套 hooks 换成一套 context/store、把一组本地累加分页换成服务端游标）。这时"X 没了"几乎总是伴随 replacement，第 2 问（Replacement）是决定 D(a) 还是 D(b) 的关键。
- **Strategy D（orthogonal-region merge）场景**。两侧改同一文件的不同区域、auto-merge clean 的，是最容易产出"编译绿 + 测试绿 + 语义坏"之树的场景。`upstream-orthogonal-signature-double-change-blindspot.md` 讲的是签名轴的 D 类盲区，本 doc 讲的是验证命令本身的 D 类盲区——两者是相邻但不重叠的失败类。
- **审计里出现的任何"非阻塞观察"**，只要它描述的是一个会在下次合并里复发的结构性事实（"这个调用点没接上"、"这个 cap 被绕过"、"这个 fallback 路径没人走"）——必须升格成带 `verified_by` 的 claim 或 memory，否则它只活在当次 prose 里，下次审计看不见（见 Why This Matters 的 v0.4.15 教训）。
- **再查规则的触发时机**：Phase 4 反向复查**推翻** Phase 1 任一条 negative claim 的那一刻，立刻对同一 Phase 1 批次的所有其余 claim 按同一 blind-spot class 复扫，不要只修被翻盘的那一条。

不需要应用的场景：positive claim（"X 已经加了 / X 现在在场"）、纯文本 conflict 的手动解决（那有 `git merge-file` + flat(fork)-flat(now) 差集扫描兜底，见 sibling 文档）、以及 bug track 的 root-cause 复盘（那是事后，本 doc 讲的是事前 Phase 1 的方法论）。

## Examples

### 1. Manifestation 1 —— `truncateFallbackCommentBody` 静默丢失 call-site

**Phase 1 写下的 claim**（错位版本）：
> "truncateFallbackCommentBody duplicate-symbol hazard 本轮没触发。"
> `verified_by`: `grep -c '^func truncateFallbackCommentBody' server/internal/service/task.go` → `0`（fork 已把它挪到 fork-only 文件），fork-only 文件里 `grep -c '^func truncateFallbackCommentBody' server/internal/service/fallback_comment_truncate.go` → `1`。定义唯一。

这条 claim **正确回答了"定义是否唯一"**，但 Phase 1 真正该问的是"GH #5455 的保护是否在运行时生效"。

**正确的 `verified_by`**：

```bash
grep -n 'truncateFallbackCommentBody' server/internal/service/task.go
```

不锚定 `^func`、不 `-c`，打印所有出现位置。本次 session 的 Phase 4 agent 跑的就是这个——`task.go` 里 `truncateFallbackCommentBody` 的唯一一次出现是 `task.go:3565` 那个**调用点**（不是定义），定义在 `fallback_comment_truncate.go:16`。Read 当前树可以原样确认：

```go
// server/internal/service/task.go:3565
content := truncateFallbackCommentBody(redact.Text(body), maxSynthesizedFallbackCommentRunes)
s.createAgentComment(ctx, task.IssueID, task.AgentID, content, "comment", task.TriggerCommentID, task.ID)
```

调用点 invoke 了 `truncateFallbackCommentBody(redact.Text(body), maxSynthesizedFallbackCommentRunes)`，cap 常量 `maxSynthesizedFallbackCommentRunes = 200` 定义在 `server/internal/service/fallback_comment_truncate.go:9`（rune-based，对 CJK 公平）。GH #5455 的动机写在 `fallback_comment_truncate.go:6` 的注释里；`task.go:3560-3564` 的注释则写出 "View run" attribution 的动机。**这是 fix 已经合并后的当前树状态**——合并 commit `7206599e2`（2026-08-11，reachable from `main`）。

Phase 4 之所以能翻盘，是因为 auto-merge 在本次升级中**先**把 `task.go:3565` 的 wrapping 丢了（fork 动过定义区 143-160 + 挪到 fork-only 文件；upstream 动过 caller 区 3565；两侧各自 clean → auto-merge 合出一棵"编译绿、测试绿、保护 disarm"的树）。Phase 1 的 `grep -c '^func'` 对此**不可观测**——它只数 `task.go` 内的 `func` 定义行，对"调用点是否 invoke"这个性质是盲的。

**三问映射**：
- 第 1 问（Proxy vs invariant）：`grep -c '^func'` 是 proxy；invariant 是"合成成功评论路径仍 invoke 截断函数"。
- 第 2 问（Replacement）：本案不涉及 replacement，截断保护没有被换掉，只是被 auto-merge 抹了——所以第 2 问的答案是"无替代机制"，这本身就是一个需要明说的结论（不能默认"没替代"而不去验证）。
- 第 3 问（Translate）：把"定义唯一"翻译成"调用点 invoke"，命令从 `grep -c '^func'` 换成 `grep -n`（所有出现位置）。

### 2. Manifestation 2 —— `use-issue-surface-data.ts` 的 D(b) → D(a) 反转

**Phase 1 写下的 claim**（错位版本）：
> "`use-issue-surface-data.ts` 静默丢失 ~273 行 assignee-grouped 看板代码。fork 的 per-status load-more hooks（`useLoadMoreByStatus` / `myIssuesOpts` / `myIssuesScope` / `myIssuesFilter`）从合并后的树里消失。"
> 推荐：Strategy D(b) "保留 fork 特性"，跨 ~6 个文件恢复 ~500 行 + Phase 5 typecheck 循环引用风险。

这条 claim 的 negative 部分（"hooks 没了"）**本身为真**——当前树 `grep -rn 'useLoadMoreByStatus\|myIssuesOpts\|myIssuesScope\|myIssuesFilter' packages/views/issues/surface/` 返回空，D(a) 已落地。但 Phase 1 在没读 upstream replacement 的情况下，把"hooks 没了"直接外推成"assignee 分组能力没了"——这是错的那一步。

**正确的 `verified_by`**（Phase 4 实际跑的、应该 Phase 1 就跑的）：

```bash
# 1. replacement 是否在场
grep -n 'IssueGroupBranches\|loadMoreGroups\|pagination' \
  packages/views/issues/surface/use-issue-surface-data.ts
```

当前树的输出确认 replacement 在场：`use-issue-surface-data.ts:22` import `IssueGroupBranches` type、`:114` 字段 `serverGroupBranches: IssueGroupBranches`、`:396` 把 `serverStatusBranches.pagination` 透传成 `statusPagination`。

```bash
# 2. replacement 覆盖了 fork 原本覆盖的哪些维度
sed -n '40,55p' packages/views/issues/surface/use-issue-group-branches.ts
```

当前树 `use-issue-group-branches.ts:44` 是 `pagination: Record<string, IssueGroupPageState>`、`:51` 是 `loadMoreGroups: () => void`——服务端游标 + 多维度分页，是 fork 那套 client-accumulating load-more 的严格超集。Fork 的 hooks 是 subset，不是丢失能力的唯一载体。

**三问映射**：
- 第 1 问（Proxy vs invariant）：hooks 的字面存在是 proxy；invariant 是"看板仍按 assignee 分组、archived 默认隐藏、分页由服务端下发"。
- 第 2 问（Replacement）：`IssueGroupBranches` + `pagination: Record<string, IssueGroupPageState>` + `loadMoreGroups` 是更强的 server-cursor 替代——读 replacement 之后 D(b) 自动坍缩成 D(a)。
- 第 3 问（Translate）：把"hooks 在不在"翻译成"分页 + 分组能力在不在"，命令从 `grep -rn 'useLoadMoreByStatus'` 换成 `grep -n 'IssueGroupBranches\|loadMoreGroups\|pagination'` + Read `use-issue-group-branches.ts:40-55`。

**结果**：用户读到 replacement 之后切到 D(a)，接受移除。最终 D(a) ~0 行手工恢复，而 D(b) 本会是 ~500 行 + Phase 5 typecheck 循环引用风险。

### 3. 再查规则的一次性触发

这两个 manifestation 都是在 Phase 4 被同一个语义横扫 agent 翻盘的。task.go 那条先被发现——按再查规则，审计员立刻对同一 Phase 1 批次的其余 negative claim 按"proxy vs invariant + replacement"这个 class 复扫，use-issue-surface-data.ts 那条 D(b) 推荐几乎在同一轮被翻成 D(a)。如果当时只修 task.go、不回头复扫，D(b) 的 ~500 行手工恢复就会进合并 commit，凭空把一个 upstream 已经用更好方式解决过的问题重新解决一遍。

## Related

- `docs/solutions/workflow-issues/upstream-orthogonal-signature-double-change-blindspot.md` —— **相邻失败类**。那个讲的是 Strategy D 下"两侧都改同一函数签名"时 3-way merge 静默丢参数轴（检测器是 `go build`）；本 doc 讲的是验证命令本身证明的是 proxy 而非 invariant（检测器是 Phase 4 沿调用链语义复查）。两者在同一类"auto-merge clean + 工具链绿 ≠ 语义对"的家族里，但盲区位置不同：前者盲在 merge 的 hunk 对齐，后者盲在审计员写 `verified_by` 那一刻的方法论。
- `docs/solutions/workflow-issues/fork-customization-invariant-set-upstream-test-collision.md` —— **互补 surface**。那个讲"fork 定制是不变量集合（code + tests + 每种 locale），用 upstream 新测试做碰撞探测器"；本 doc 讲"negative claim 的 `verified_by` 必须证明不变量本身"。两者共享"invariant-set"这个抽象，但落点不同：那个是 about MEMBERS surviving a merge（哪些成员组成一个特性），本 doc 是 about VERIFICATION COMMAND 证对了东西。(session history) 该 doc 的 loss scan `flat(fork)−flat(now)==∅` 查的是 membership，对本 doc 的 call-site liveness 盲点同样失明——见 Why This Matters 的三道防线分析。
- `docs/solutions/workflow-issues/upstream-single-sided-fork-param-convergence-merge.md` —— Strategy D 镜像场景（upstream 单向收敛 fork 加参），auto-merge clean、`go build` 不报错、盲区从"编译"挪到"行为"。和本 doc 第 2 问（Replacement）共享"编译绿不等于行为对"这一前提。
- `docs/solutions/workflow-issues/merge-conflict-checkout-theirs-drops-fork-only-members.md` —— fork-only 成员的 whole-file 覆盖盲区（`git merge-file` 三方合并 + flat(fork)-flat(now) 差集扫描兜底）。和本 doc 的关系：那个是"merge 动作本身"丢了成员，本 doc 是"验证动作"证错了对象。
- `docs/solutions/workflow-issues/run-typecheck-after-upstream-merge.md` 和 `upstream-type-scale-refactor-fork-only-files-blindspot.md` —— post-merge 验证 gate 家族。`pnpm typecheck` / `go build` / 守卫测试是 necessary-not-sufficient；本 doc 补充的是"工具链绿"之上还有一层"验证命令证对了 invariant 没"的方法论 gate，工具链绿无法替代。其中 type-scale doc 的 Guidance step 5 + When-to-Apply 已经埋下过本 doc 的种子（"every negative_claims verified_by must ENFORCE the invariant, not only inspect it"），本 doc 把它从 design-token 实例推广成适用于任何 negative claim 的方法论。
- `docs/solutions/workflow-issues/safe-upstream-upgrade-with-local-customizations.md` —— 升级 SOP 总文档。本 doc 的三问自检 + 再查规则应作为其 Phase 1 审计步骤的前置方法论。
- 自动记忆 `feedback_negative_claim_must_prove_user_invariant`（type=feedback）—— 本 doc 的 SOURCE。memory 里的三问框架（proxy / replacement / translate symbol→behavior）是同一套，本 doc 在其基础上补齐了 memory 缺少的 grounded file:line 引用（`task.go:3565`、`fallback_comment_truncate.go:9,16`、`use-issue-surface-data.ts:22,114,396`、`use-issue-group-branches.ts:44,51`）、merge commit `7206599e2` 的 reachability / 日期上下文，以及 (session history) 跨 5 次升级的复发证据与"三道防线全部查在场不查可达"的结构性分析。
- 流程产物：`docs/upgrades/v0.4.22-plan.md`（Phase 记录）、`docs/customizations.md`（"Last upgrade — v0.4.21 → v0.4.22" 账本条目）。两者均为本仓库实际文件（2026-08-11 修改）。合并 commit `7206599e2`（2026-08-11 10:52:27 +0800）为本仓库 merge commit，verified ancestor of HEAD on this checkout。
- (session history) 跨升级复发证据来自 ce-compound 的 session-history probe 对 `v0.4.15 / v0.4.18 / v0.4.19 / v0.4.21` 四次更早升级会话的回扫（Claude Code sessions, 2026-07-31 至 2026-08-07）。v0.4.15 那次"非阻塞行为分歧"prose 发现是该盲点的最早记录，比 v0.4.22 早 12 天，但因未升格成 claim / memory 而在后续四次审计里逐次降级直至消失。
