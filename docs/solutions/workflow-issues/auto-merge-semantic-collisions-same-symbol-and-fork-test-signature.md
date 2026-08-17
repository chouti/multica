---
title: "Two auto-merge collision classes merge-tree and file-level audits miss — same-symbol-different-region duplicate (caught by tsc) and fork-only test file vs upstream signature drift (caught by go vet, not go build)"
date: 2026-08-14
last_updated: 2026-08-17
category: workflow-issues
module: upstream-upgrade-merge
problem_type: workflow_issue
component: development_workflow
severity: high
applies_when:
  - "三方合并上游 release 到带本地定制的 self-host fork，且 fork 与上游在同一文件的不相交区域各自添加了相同符号（无文本重叠 → 3-way auto-merge 各保一份 → 重复标识符 / 重复块）"
  - "上游给 Go service 方法签名增删了参数（如 TaskService.CompleteTask/FailTask 加 branchName），而 fork 持有调用该方法的 *_test.go 文件——上游更新了自己的测试调用点但够不到 fork-only 测试文件；go build 通过（不编译测试），go vet 失败"
  - "把 `git merge-tree` 的零冲突输出当作'语义干净合并'的证据——它只报告文本冲突，对同符号异区重复与 fork 测试签名漂移完全失明"
  - "设计升级合并的 Phase 5 代码门顺序：pnpm typecheck 抓跨侧重复标识符（TS2300）；go vet（而非 go build）抓 fork 测试文件的签名漂移"
  - "审计一个 Phase 1 grep + merge-tree 都报干净、但语义上仍然错误的三方合并结果"
resolution_type: workflow_improvement
tags: [upstream-upgrade, auto-merge, three-way-merge, merge-tree-blindspot, typecheck, go-vet, duplicate-identifier, fork-test-signature]
---

# Two auto-merge collision classes merge-tree and file-level audits miss

## Context

在 v0.4.24 → v0.4.25 upstream release merge 过程中，本 fork 遇到两类"git 3-way auto-merge 完全通过、零冲突标记、且不在预测冲突集"的语义碰撞。Phase 1 深度审计和 `git merge-tree --write-tree` 都没有发现它们，最终是 Phase 5 的代码闸门（`pnpm typecheck` 与 `go vet ./...`）把它们抓出来的。

关键点不在于这两个问题本身有多难——一旦 Phase 5 把它们暴露出来，修复都是几分钟的事——而在于它们**不在审计预测范围内**，因此是在 Phase 5 中途才浮出水面，而不是在 Phase 4（冲突解决）阶段就被处理掉。这个代价值得固化成可复用的检测模式。

(session history) 这两类并非孤立：在 v0.4.18→v0.4.20 升级里，**同一个 fork-only 测试文件** `task_source_task_id_test.go` 就因 `CompleteTask`/`FailTask` 签名漂移被 `go vet` 抓过一次，并被 `negative-claim-must-prove-user-invariant.md` 第 106 行引用为 `go vet` 抓陈旧测试调用点的范例。所以 Class 2 在 v0.4.25 是**复发**，不是首例；Class 1（同符号异区重复）则是首次被形式化记录。本仓库的 collision-family 文档（`negative-claim`、`fork-customization-invariant-set`、`upstream-orthogonal-signature-double-change-blindspot`）已各自覆盖了相邻的盲区，本文补上"编译器/linter 抓、merge-tree 抓不到"这一层。

两类碰撞的共同主线是：**auto-merge 在文件级 / hunk 级重叠上是可靠的，但它看不见"语义级"的重复与签名漂移。** `git merge-tree` 只看文本重叠；文件级人工审计看的是文件和 hunk；两者都无法感知 (a) 同一个导出符号在同一个文件的两个不相交区域被各自添加，或 (b) 一个 fork-only 文件调用了一个被 upstream 改了签名的函数。Phase 5 的全量编译门（`pnpm typecheck` 与 `go vet`）是这两类的可靠兜底（2026-08-17 补：编译门之下还有执行级 rung，见 Guidance 末节）。

## Guidance

在 upstream merge 进入 Phase 5 之前，对以下两类风险各加一道显式检测；不要依赖 `git merge-tree` 或裸 `grep`。

### 检测 1 — 同符号跨区域重复（Class 1）

对每一个"两侧都改过"的交集文件（intersection file），分别列出 fork 侧和 upstream 侧相对 merge base 新**增**的顶层符号，然后求交集：

```bash
# MB = merge base，HEAD = fork 当前，<tag> = upstream release tag
# 对每个交集文件 file：
git diff MB..HEAD -- <file> | grep -E '^\+(export )?(const|func|type) [A-Z][A-Za-z0-9_]*' | sort
git diff MB..<tag> -- <file> | grep -E '^\+(export )?(const|func|type) [A-Z][A-Za-z0-9_]*' | sort
# 两个 add-list 里同名符号 = merge 后必然重复定义。
```

只要某个名字同时出现在两侧的 add-list 里，3-way 合并后就是重复定义——即使两侧改动落在完全不重叠的行区间（因此零冲突标记）。重点扫 TypeScript 的 `export const`/`const`、Go 的 `func`/`type`，以及 import 块里同名 import 出现两次的情况。

(session history) "各保一份"的失效形态比"重复导出符号"更广，同一家族里还观察到：Go 同一函数体被 auto-merge 保留两份（`:=` 重声明，`go build` 抓）、连续两条 `return nil`（`go vet` 抓"unreachable code"）。检测 1 的 `grep` 形态可推广到"重复块/重复语句"：对 Go 交集文件，`git diff MB..<tag>` 与 `MB..HEAD` 的 add-hunk 若有相同的多行块，合并后即重复。

### 检测 2 — 签名变更的调用者扫描必须包含 `*_test.go`（Class 2）

当 upstream 在 merge range 内改了某个函数/方法的签名（增删参数），调用者扫描**必须覆盖测试文件**，绝对不能用 `grep -v '_test.go'`：

```bash
# 找 upstream 改了哪些签名（看 diff 里被删/被加的 func 行）
git diff MB..<tag> -- 'server/**/*.go' | grep -E '^[-+].*func \(s \*TaskService\)'

# 在整棵树（含 fork-only 文件、含 _test.go）里找调用点
git grep -n '\.CompleteTask(\|\.FailTask(' -- 'server/'
```

关键陷阱：`go build ./...` **不编译测试文件**，所以它能编译通过却让 `go vet ./...`（或直接跑测试）炸掉。也就是说，Phase 5 里"build 过了"不能当作"签名兼容"的证据，必须跑 `go vet`。尤其是 **fork-only 测试文件**——upstream 改签名时会更新它自己仓库里的所有测试调用点，但够不到一个它根本不存在的 fork 测试文件，3-way 合并对这种跨文件失配无能为力。

### Phase 5 全量编译门是编译语义的兜底（非运行级兜底）

无论审计做得多细，把 `pnpm typecheck` 和 `go vet ./...` 当成不可跳过的 Phase 5 闸门。它们分别捕获：
- `pnpm typecheck` → Class 1（TS2300 `Duplicate identifier`、TS2451 `Cannot redeclare block-scoped variable`）。
- `go vet ./...` → Class 2（`not enough arguments in call to ...`）。注意 `go build ./...` 抓不到，因为它不编译 `*_test.go`。

(session history) 这正是 upgrade skill 的 Phase 5 清单在 v0.4.20 之后从 5 项扩到 7 项的原因——新增了 `go vet` 和 `sqlc`，`go vet` 被显式列为"抓 test 签名漂移 + auto-merge 重复块"的唯一标准门。

### 执行级 rung —— 编译门之下的最低档（2026-08-17 补）

上述阶梯止于编译门，但 `go build`（不编译测试）与 `go vet`（编译测试但不执行）对**运行期**缺陷双盲：package-init panic（如 pflag flag 双注册）、只有执行测试二进制才会暴露的行为漂移，两道门都放行。`docs/solutions/runtime-errors/duplicate-pflag-registration-init-panic-invisible-to-static-gates.md` 记录了完整案例——fork CLI 的 invite flag 双注册在 build/vet 双绿状态下存活 39 天，唯一暴露方式是实际执行 `go test`。升级审计应对至少 fork 改动过的包（或 /tmp 的 merged-tree 导出）实际执行 `go test`，把"编译过"升级为"执行过"；CONCEPTS.md 的 **Verification Gate Ladder** 词条收录了完整阶梯与三种失效模式。

同一案例的另一半教训是**无人读的红灯等于不存在**：fork 远端 CI（`.github/workflows/ci.yml` → `scripts/test-go.sh --race`）2026-07-10 的 run 29082363133 就以该 panic 大红失败，一个多月无人查看；此后 push 停止、流程转纯本地，执行级门彻底退出例行视野。执行级门要么在本地例行跑、要么纳入被查看的 CI 回路——两者同时缺位时，阶梯的最低档是空的。

## Why This Matters

`git merge-tree --write-tree HEAD <tag>` 和文件级审计有已知盲区，它们只能看到 FILE 级和 HUNK 级重叠：

- 看不见"同一文件、不相交区域、同名导出符号被各自添加"（Class 1）。因为两个区域不重叠，merge-tree 不会产生任何冲突标记，文件甚至不会进预测冲突集。
- 看不见"fork-only 文件调用了一个 upstream 改了签名的函数"（Class 2）。因为 upstream 碰不到一个它仓库里不存在的文件，3-way 合并对此无能为力。

(session history) 更深一层：本仓库对"fork 成员丢失"的三层防御（定义 grep / `go build` / loss-scan）查的都是"**成员是否存在**"，而**调用点存活性（call-site liveness）是零覆盖维度**——这个盲区早在 v0.4.15 就被审计 agent 观察到、却只活在叙事文本里、从未进入任何 `verified_by` 字段或文档，于是跨四次升级反复出现，直到 v0.4.22 以"truncateFallbackCommentBody 调用点被静默丢弃、编译通过、测试全绿、运行时无界"的形态达到顶峰（见 `negative-claim-must-prove-user-invariant.md`）。本文的两类是这条线在"编译器可抓"一端的实例：定义都在、但合并结果是错的（重复定义 / 陈旧调用点）。把它们从"Phase 5 中断"降级为"Phase 4 顺手清掉"，并把 `go vet` 锁定为不可跳过的门，是切断这条复发弧的最直接手段。

## When to Apply

- 任何 upstream merge 中，fork 和 upstream 在**同一个文件**里各自添加了代码（哪怕改动落在完全不同的行区间）。→ 跑检测 1。
- 任何 upstream merge 中，upstream 在 merge range 内**改了函数/方法签名**（参数增删、参数顺序变化），而 fork 有自己的测试文件或调用点。→ 跑检测 2，且调用者扫描必须包含 `*_test.go`，尤其是 fork-only 测试文件。
- 任何 merge range 里 upstream 新增/删除了一个被广泛调用的导出符号时，按同样的"两侧 add-list 求交集"思路扩展扫描。
- Phase 5 永远跑 `pnpm typecheck` + `go vet ./...`；不要因为"`go build` 过了"就认为签名兼容，也不要用 `git merge-tree` 的零冲突输出当作语义干净的证据。编译门之下还有执行级 rung：对 fork 改动过的包（尤其 CLI 包）实际执行 `go test`——build/vet 双绿不证明测试能跑。

## Examples

### Class 1 — 同符号跨区域重复（`packages/core/api/schemas.ts`）

本 fork 的 batch-import 特性（PR #2669）和 upstream v0.4.25 的 refreshSkill 特性，各自**独立地**在同一个文件 `packages/core/api/schemas.ts` 里添加了同名符号 `SkillSchema` / `SkillFileSchema` / `EMPTY_SKILL`，但落在不相交的行区间。3-way merge 把两份都保留了，没有任何冲突标记，文件也不在预测冲突集里。

合并后跑 `pnpm typecheck` 直接报：

```
TS2300 Duplicate identifier 'Skill'.
TS2451 Cannot redeclare block-scoped variable 'SkillSchema'.
```

修复（已落在当前树，merge commit `2ca50e006`）：删掉 upstream 那一份重复定义，保留 fork 的定义。当前树里每种符号只剩唯一定义，且 fork 版本位于 `BatchImportResponseSchema` 之前，引用能正确解析：

- `packages/core/api/schemas.ts:1338` — `const SkillFileSchema`（唯一）。
- `packages/core/api/schemas.ts:1347` — `export const SkillSchema`（唯一）。
- `packages/core/api/schemas.ts:1365` — `BatchImportResponseSchema`，在 `:1369` 通过 `skills: z.array(SkillSchema).default([])` 引用 `SkillSchema`（验证保留 fork 版本能正确解析）。
- `packages/core/api/schemas.ts:1373` — `export const EMPTY_SKILL`（唯一）。

附带把 import 块里出现两次的 `Skill` import 去重。行为上无损：fork 的 `.default()` 与 upstream 的 `.optional().default()` 在 zod 里运行时等价，保留 fork 版本不丢任何行为。

### Class 2 — fork-only 测试文件对 upstream 签名变更盲区（`task.go` / `task_source_task_id_test.go`）

upstream v0.4.25 给 `TaskService.CompleteTask`（7 → 8 参）和 `FailTask`（8 → 9 参）插入了新参数 `branchName`，并更新了 upstream 自己的所有调用方。但本 fork 有一个 fork-only 测试文件 `server/cmd/server/task_source_task_id_test.go`（由 commit `e25917f8e feat(tasks): stamp source_task_id on synthesized completion comment` 引入），它仍然按旧 arity 调用。upstream 碰不到一个它仓库里不存在的文件，所以 3-way 合并对此无能为力。

结果：`go build ./...` **通过**（它不编译测试文件），但 `go vet ./...` 报：

```
not enough arguments in call to taskSvc.CompleteTask
```

Phase 1 审计当时确实扫了非测试调用方（`server/internal/handler/daemon.go`、`server/internal/daemon/daemon.go`——都是 upstream 自己改过的，Strategy D scenario B 干净），但用了 `grep -v '_test.go'`，把这个 fork-only 测试文件过滤掉了。

当前树的签名（已含 `branchName`，已验证）：

- `server/internal/service/task.go:3517` — `func (s *TaskService) CompleteTask(ctx context.Context, taskID pgtype.UUID, result []byte, sessionID, workDir, branchName string, sessionRolloutMissing bool, …)`，`branchName` 是插在 `workDir` 之后的新参数。
- `server/internal/service/task.go:3925` — `func (s *TaskService) FailTask(ctx context.Context, taskID pgtype.UUID, errMsg, sessionID, workDir, branchName, failureReason string, …)`，`branchName` 同样插在 `workDir` 之后。

修复（已落在当前树）：在该 fork 测试文件的 2 个调用点补 `branchName=""`（这些测试不涉及 branching，中性默认值即可），已验证：

- `server/cmd/server/task_source_task_id_test.go:91` — `taskSvc.CompleteTask(ctx, taskID, []byte(...), "", "", "", false, "")`，其中紧跟 `workDir` 之后的那个 `""` 即 `branchName=""`。
- `server/cmd/server/task_source_task_id_test.go:128` — `taskSvc.FailTask(ctx, taskID, "agent_error: crashed", "", "", "", "agent_error", false, "")`，同样在 `workDir` 之后补了 `branchName=""`。

教训：**调用者扫描必须包含 `*_test.go`，且 `go build` 通过不等于签名兼容——只有 `go vet`（或跑测试）能抓。** (session history) 这一文件并非首次触发：v0.4.18→v0.4.20 升级时它就因 `CompleteTask`/`FailTask` 签名漂移被 `go vet` 抓过，是同一碰撞类的复发。

## Related

- `docs/solutions/workflow-issues/fork-customization-invariant-set-upstream-test-collision.md` — 同 meta 家族（"干净 auto-merge ≠ 语义正确；fork 定制是跨 code+test+locale 的不变量集合"），但那篇的碰撞靠**跑上游行为测试**抓，本文两类靠**编译器/linter（tsc / `go vet`）**抓——这是最清晰的分界，故各自独立成篇而非合并。
- `docs/solutions/workflow-issues/negative-claim-must-prove-user-invariant.md` — 第 106 行已把 `task_source_task_id_test.go` 当作 v0.4.20 的 `go vet` 抓陈旧调用点范例引用；本文 Class 2 是其**复发 + 形式化**。那篇讲"验证什么（用户可见不变量 vs 符号代理）"，本文讲"用哪道门、什么启发式检测"。
- `docs/solutions/workflow-issues/upstream-orthogonal-signature-double-change-blindspot.md` — Strategy D scenario A（双侧改同一签名）。其 Guidance 第 68 行已开"跑 `go vet` 抓测试调用点"的处方；本文 Class 2 把它专门化为"upstream 单边改签名 + fork-only 测试文件够不到"的子变体。
- `docs/solutions/workflow-issues/run-typecheck-after-upstream-merge.md` — Class 1 的检测器。那篇唯一例子是"声明被丢"（auto-merge drop），本文 Class 1 是反面"声明重复"（both-add）；同一道 `tsc` 门，互补的碰撞形态。
- `docs/solutions/workflow-issues/upstream-type-scale-refactor-fork-only-files-blindspot.md` — 提供 meta 框架（"文本级 3-way 合并对跨区域/跨文件语义失明，模式可推广"）；本文两类是该推广的两个新层（TS 重复标识层 / Go fork-only 测试层）。
- `docs/solutions/workflow-issues/safe-upstream-upgrade-with-local-customizations.md` — 10 步升级 SOP（Strategy D 首次定义于 Step 4）；本文两条检测规则可插回该 SOP 的审计 + 验证步骤。
- `docs/solutions/runtime-errors/duplicate-pflag-registration-init-panic-invisible-to-static-gates.md` — 阶梯的最低档：package-init panic 对 build/vet 双盲，只有执行 `go test` 暴露；并把本文的"编译门兜底"模型补全为完整 gate ladder（含无人读的 CI 红灯这一失效模式）。
- Merge commit `2ca50e006` — 两类修复都已落在当前树。
- auto memory [claude] `feedback_upgrade_audit_collision_gaps` — 同期记录这两类碰撞的 auto memory 笔记（补充上下文，非首要证据；以本文件 + 已验证树为准）。
