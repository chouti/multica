---
title: "Fork flag block re-registers invite flags the upstream base already defines — pflag panics at package init before every repo-built CLI run and go test, invisible to go build / go vet / Docker-gated make test"
date: 2026-08-17
last_updated: 2026-08-17
category: runtime-errors
module: server/cmd/multica
problem_type: runtime_error
component: tooling
severity: high
symptoms:
  - "Every repo-built CLI invocation dies before main with `panic: invite flag redefined: role` (pflag AddFlag panicking at Go package init)"
  - "`go test ./cmd/multica/` panics in package init before any test executes — the test binary never reaches a single test"
  - "`go build ./...` and `go vet ./...` both stay green: the duplicate is a runtime registration, not a compile error, and vet never executes the code"
  - "No production symptom on this host: the deployed daemon/CLI is the Homebrew multica build (upstream code, no fork flags), so the breakage stays latent"
  - "`make test` cannot catch it on this host because it requires Docker, which is absent"
root_cause: logic_error
resolution_type: code_fix
applies_when:
  - "Fork PR work registers cobra/pflag flags on a command whose flags the upstream base already registers (here: workspaceMemberInviteCmd upstream role+output vs fork block email/role/name/output in server/cmd/multica/cmd_workspace.go)"
  - "Verifying a fork CLI commit or an upstream merge-tree export where static gates (go build, go vet) are green — only actually executing a test binary exercises package init"
  - "Self-host deployments where the production binary comes from Homebrew upstream builds, so repo-built CLI breakage never surfaces in production"
related_components:
  - cobra
  - pflag
  - upgrade-audit-phase1
  - homebrew-cli
tags: [pflag, cobra, duplicate-flag-registration, package-init-panic, flag-redefined, go-test, fork-divergence, upgrade-audit]
---

# Fork flag block re-registers invite flags the upstream base already defines — pflag panics at package init, invisible to go build / go vet / Docker-gated make test

## Problem

fork 提交 215f833df（`feat(cli): add workspace member invite --name and admin update-user`，author date 2026-06-14，commit date 2026-07-09 落入分支；该工作是尚未合入的上游 PR #4118 的 fork 侧实现）在 `server/cmd/multica/cmd_workspace.go` 的 `init()` 里为 `workspaceMemberInviteCmd` 追加了 email/role/name/output 一组 flag 注册，而树里已有的基座注册块（在 215f833df 的 diff 中作为 context 行可见）此前已为同一条命令注册过 `role` 和 `output`。pflag 对同一 flagset 内的重复 flag 名直接 panic，于是整个包在任何测试或 main 逻辑运行之前的 package init 阶段就崩溃，报 `panic: invite flag redefined: role`。影响：`go test ./cmd/multica/` 在任何测试开始前死亡，repo 自建 CLI 二进制每次调用都 panic；该包的测试在此后的本地例行验证中从未执行过、也从未跑绿过（2026-07-10 fork 远端 CI 曾执行并以同一 panic 失败，无人查看——见 What Didn't Work），直到 2026-08-17 才被发现并修复。

## Symptoms

- `go test ./cmd/multica/` 在 package init 阶段即崩溃，输出 `panic: invite flag redefined: role`（d5428bc26 提交信息原句），任何测试函数都没来得及运行。
- repo 自建的 CLI 二进制每次调用都 panic——`init()` 先于 `main` 执行，不是某个子命令才触发。
- 生产环境完全无感：本机生产 daemon/CLI 是 Homebrew 的 multica（上游构建，不含 fork flag），repo 构建的 CLI 从不在生产运行。
- 常规验证门（`go build`、`go vet`、`make test`）要么显绿要么跑不起来，没有任何一条信号指向这个 bug（见 What Didn't Work）。

## What Didn't Work

这里失败的不是某次修复尝试，而是整个既有检测面——一个多月里每道门都"通过"了，bug 却一直在：

- `go build`：只编译非测试代码，不编译 `*_test.go`；而且这是运行期 init panic 而非编译错误——重复注册 flag 在编译期完全合法，build 门结构性看不见。
- `go vet`：会编译（类型检查）测试文件，但从不执行测试二进制；测试二进制 package init 阶段的运行期 panic 对它同样不可见。
- `make test`：本机没有 Docker，`make test` 在这台 self-host 主机上跑不起来，全量 Go 测试从未作为例行门在这台机器执行。
- 生产回路：daemon 是 Homebrew 上游构建，不含 fork 的 CLI 代码，生产永远不会替你踩到这个 bug；部署后健康检查（`/healthz`、`/api/config`、daemon status）也只打 backend server 进程，从不打 CLI 入口。(session history)
- fork 远端（chouti/multica）并非没有 CI：`.github/workflows/ci.yml` 在 push main 时跑 `scripts/test-go.sh --race`。215f833df 落地次日（2026-07-10）的 push 触发的 CI run 29082363133 就执行了 `go test` 并以本 panic 大红失败（日志原句 `panic: invite flag redefined: role`）——信号当天就存在且响亮，只是无人查看。此后 push 停止、流程转纯本地，例行路径上才真正没有任何东西执行 `go test`。这不是"没有门"，而是第三种失效：门在例行视野之外亮了红灯，红灯没人读。
- **近距离擦过**：v0.4.23→v0.4.24 升级（2026-08-13）时 `cmd_workspace.go` 就在 24 个双侧交集文件里，被归入"另外 18 个交集文件全部 auto-merge 干净"清单放行——无冲突标记、无编译错误恰恰是这类语义碰撞的形态；同期审计对 PR #4118 的追踪只到 handler/router 层（router.go 的 admin 路由组），从未交叉引用到 CLI flag 面，Strategy D 签名扫描的文件列表也不含 cmd_workspace.go。(session history)
- **gate 清单的演化方向强化了盲区**：v0.4.22 升级的复盘把"调用点存活性零覆盖"记为跨轮复发的盲点，但补强方向全部是全编译门（typecheck / go vet）；v0.4.25 里 typecheck 抓到 schemas.ts 重复符号、go vet 抓到 fork 测试 arity 漂移，两次"只有 Phase 5 抓到"反而巩固了"编译器/linter 是兜底"的模型——运行级验证（go test、执行二进制）从未进入讨论。(session history)

结果：从 2026-07-09 到 2026-08-17，v0.4.20（2026-08-07）到 v0.4.25（2026-08-14）连续多个升级周期都带着这个 bug 通过了各自的 Phase-5 验证（远不止两次；session history 显示 panic 窗口内约十轮升级会话全部由同一套 gate 清单驱动放行，无一例外）。

## Solution

2026-08-17 的 v0.4.25→v0.4.26 升级 Phase 1 审计中，一个审计 agent 把 merge-tree 结果导出到 /tmp 并在其上真正执行了 `go test ./cmd/multica/`——超出标准 build/vet 门的一步——复现出同一 panic；回到 plain HEAD 同样复现，证明这是 fork 既有的 bug 而非本次 merge 引入。

修复提交 d5428bc26（`fix(cli): stop double-registering member-invite flags that panic at package init`，2026-08-17）：删除基座那对注册（修复前 `server/cmd/multica/cmd_workspace.go` L123-124，`role` 默认 "member"/"Member role to grant..." 与 `output` 默认 "table"），保留 fork 块。净 diff 恰为 2 行删除。当前树的注册块（server/cmd/multica/cmd_workspace.go:124-128）：

```go
workspaceMemberInviteCmd.Flags().String("email", "", "Invitee email address (required)")
workspaceMemberInviteCmd.Flags().String("role", "member", "Role to assign: member or admin")
workspaceMemberInviteCmd.Flags().String("name", "", "Display name for the invitee (optional; applied at registration time)")
workspaceMemberInviteCmd.Flags().String("output", "json", "Output format: table or json")
_ = workspaceMemberInviteCmd.MarkFlagRequired("email")
```

验证：`go test ./cmd/multica/ -run 'Workspace' -count=1 -v` 全部 PASS——TestWorkspaceMemberInviteCommandIsRegistered（cmd_workspace_test.go:691）、TestRunWorkspaceMemberInvitePostsInvitation（:706）、TestRunWorkspaceMemberInviteUsesWorkspaceArgAndRoleFlag（:751）、TestRunWorkspaceMemberInviteRejectsOwnerRole（:783）、TestRunWorkspaceMemberInviteRejectsUnknownRole（:805）等。这是 215f833df 以来这批测试第一次真正执行，全绿说明 fork 的 flag 语义自洽。`go vet ./cmd/multica/` 干净。当前 HEAD 复核 `go test ./cmd/multica/ -run TestNothingMatches -count=1` 输出 `ok github.com/multica-ai/multica/server/cmd/multica ... [no tests to run]`，package init 已无 panic。

## Why This Works

pflag 的 `FlagSet.AddFlag` 对同一 flagset 内重复 flag 名直接 `panic("<flagset> flag redefined: <name>")`；cobra 给命令的 flagset 取名就是命令 `Use` 的首词——`workspaceMemberInviteCmd` 的 `Use: "invite <email> [workspace-id|slug|prefix]"`（cmd_workspace.go:64）——所以第二次注册 `role` 时在 `init()`（cmd_workspace.go:101-137）里抛出 `invite flag redefined: role`，早于任何测试函数或 main。删除重复后，每个 flag 名只注册一次，init 正常完成；这解释了为什么修复只需 2 行删除、无需触碰任何命令逻辑。

保留 fork 块而非基座块是语义选择而非任意取舍，两块并不等价：基座块 `output` 默认 `"table"`、无 `--email` 必填、无 `--name`；fork 块 `output` 默认 `"json"`、通过 `MarkFlagRequired("email")` 强制邮箱、支持 `--name`。`runWorkspaceMemberInvite` 的 fork 实现（构造含 `invitee_name` 的请求体、表格输出展示 Display name）依赖的正是 fork 块的语义；测试全绿也确认了 fork 块与测试期望一致。

## Prevention

- fork CLI 定制规则：给一条 cobra 命令加 flag 前，先 grep 同一 `init()` 里该命令的既有注册块；同名 flag 必须替换基座行，绝不并列追加一组。215f833df 的 diff 里基座两行就以 context 行形式出现在新增块正上方——提交前看一眼 diff 就能拦住。
- 识别信号：`go test` 输出里 package init 阶段的 `panic: ... flag redefined: ...` 是 flag 双注册的确定性症状，不是环境问题或 flake，不要往环境方向排查。
- 本机结构性门洞：`go build`（不编译测试）+ `go vet`（编译但不运行）都看不到测试二进制里的运行期 init panic，`make test` 又依赖本机没有的 Docker。升级审计应对至少 fork 改动过的 CLI 包（或 /tmp 的 merged-tree 导出）实际执行 `go test`，把"编译过"升级为"执行过"。
- 负面结论必须靠执行验证，不能靠门设计推理："build/vet 都绿所以测试没问题"的推理在本案被证伪——这与 docs/solutions 中 negative-claim、upgrade-audit collision 两条既有教训同族，本案补上了"运行期 init panic"这一 build+vet 双盲的碰撞形态。
- 「无人读的红灯等于不存在」：远端 CI 2026-07-10 就以本 panic 失败过，信号存在一个多月无人查看。纯本地流程要么把 CI 结果纳入例行确认，要么在本地补上执行级门——两者同时缺位才让盲区闭合。
- 上游侧联动：引入提交是未合入的上游 PR #4118 的 fork 侧实现（gh 复核 2026-08-17 仍 OPEN）；待该 PR 上游合入后做升级 merge 时，需重新核对上游自带的 flag 注册块与 fork 块不会叠出同名注册。

## Related Issues

- `docs/solutions/workflow-issues/auto-merge-semantic-collisions-same-symbol-and-fork-test-signature.md` — 同族"哪道门抓什么"阶梯（typecheck → go vet）；本案补上 go vet 之下的最低档：package init 期 panic 只有执行 go test 才能暴露。
- `docs/solutions/workflow-issues/fork-to-upstream-pr-preparation.md` — 其第 86 行曾把本 panic 作为未解释的"测试包既有 init panic"引用（掩盖了 #6106 CLI 测试），根因即本文档所记。
- `docs/solutions/architecture-patterns/member-display-name-management.md` — PR #4118 定制族的架构文档；其 `multica workspace member invite --email/--role/--name/--output` 示例在 215f833df 至修复窗口期内实际不可运行。
- `docs/solutions/test-failures/migration-lint-duplicate-prefix-whitelist-gap.md` — 平行的隐形机制：红的 Go 测试在 self-host 上因 `make test` Docker 门从未被执行而长期无人察觉。
- `docs/solutions/architecture-patterns/daemon-cli-version-drift-detection.md` — 解释"生产无感"的拓扑：daemon 跑 Homebrew CLI，独立于 repo 构建。
- `docs/upgrades/v0.4.26-plan.md` — 发现本案的 Phase 1 审计记录（pre-existing bug 注记 + merge 前独立修复 d5428bc26）。
- `docs/customizations.md` — fork 定制 ledger；PR #4118 行携带 cmd_workspace.go。
