---
title: "Skill Mention Bind-Run Decoupling - Plan"
date: 2026-07-24
type: fix
topic: skill-mention-bind-decouple
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-brainstorm
execution: code
related_plan: docs/plans/2026-07-17-001-feat-skill-mention-agent-gesture-plan.md
origin_issue: YUP-407
---

# Skill Mention Bind-Run Decoupling - Plan

## Goal Capsule

- **Objective:** 让 `@skill` 手势指定真正生效——designated agent 在评论提交时 durable 绑定 skill，当次运行就携带 skill bundle；消除「implicit 与 designated 指向同一 agent 时绑定被 dedup 冲走」的静默失败。
- **Product authority:** 本 plan 只 owns 这个语义修正（bind 与运行解耦 + trigger-preview 一致性）。bind-on-submit 整体方案由 `docs/plans/2026-07-17-001-feat-skill-mention-agent-gesture-plan.md` 定义且已实现，不在 active scope。
- **Open blockers:** 无。R6（forced-skill prompt callout）在 planning 阶段发现需跨层数据流，经用户确认 defer 到 follow-up（见 Scope Boundaries）。

---

## Product Contract

*Product Contract preservation: R1–R6、KD1–KD4 含义与 ID 保留。唯一 scope 变化——R6（forced-skill callout）从 active 移至 Deferred to Follow-Up Work（planning 读 `writeSkills` 后发现需新建 handler→task→daemon→prompt 数据流，成本高、边际价值低，用户确认 defer）。R5 的实现路径在 planning 阶段确定为纯前端（KTD3）。*

### Summary

将 `@skill` 手势的「绑定」与「运行」解耦：designated agent 只要能被当前用户 invoke，提交时就 durable 绑定该 skill，当次运行携带完整 bundle。删除 finding #4 的 `source == mention_skill` 绑定过滤，回到 CONCEPTS.md 已确立的 Skill Mention Gesture 规范；并用 trigger-preview 一致性补全「指定 → 真用上」的提交前反馈。

### Problem Frame

YUP-407：用户与活跃 agent「kahneman」对话时 `@ce-plan` + 手势指定 kahneman。kahneman 因 conversation_continuation 被 implicit 路径选中（会运行），但 ce-plan 未绑定——它运行了却拿不到 ce-plan bundle，自己写了一份计划而非用 ce-plan 的结构化方法。日志三方互证：kahneman 走 implicit 的 `task enqueued`（非 `mention task enqueued`）、`force_fresh_session=false`、`agent_skill` 表无 ce-plan 绑定。

根因是 review finding #4：入队去重保留 implicit trigger、丢弃 mention_skill trigger 后，`bindDesignatedSkillsForTriggers` 只绑定 `source == mention_skill` 的 trigger，而被去重改写成 implicit source 的 kahneman 因此跳过绑定。这个保护针对的是「绑定一个不会运行的 agent」的滥用担忧，但它的过滤条件描述的是触发路径（source 标签）而非危害本身（是否运行），而 dedup 恰好会改写路径标签——结果它防了一个虚假威胁，漏防了真实威胁，并偏离了 CONCEPTS.md 已写明的规范。这是主路径——「与活跃 agent 对话、顺手 `@skill` 让它用某技能」——上的静默失败。

### Key Decisions

- KD1. **Bind 与运行解耦**（session-settled: user-directed — 在「只防不运行 agent 被绑」与「什么都不用防」之间选后者：durable bind 的语义是「指定即生效、未来可用」，suppress 只管当次跑不跑，不该撤销绑定）。Governs R1, R3.
- KD2. **推翻 finding #4，不保留任何 weapon 防护**（session-settled: user-directed — finding #4 防虚假威胁、漏防真实威胁、且偏离 CONCEPTS.md；用户判定连「不运行却绑」也不构成危害）。Governs R1.
- KD3. **回到 CONCEPTS.md 规范，规范本身不改**：实现偏离了已确立的 Skill Mention Gesture 定义，修正实现即可。Governs R4.
- KD4. **trigger-preview 同步纳入本轮**（session-settled: user-directed — 选「连带做」以堵住「提交前以为生效」的反馈缺口）。Governs R5.

### Requirements

**绑定语义（与运行解耦）**

- R1. 用户手势指定的 agent，只要能被当前用户 invoke，在评论提交时 durable 绑定到该 skill，无论该 agent 是否同时被 implicit 路径选中、是否被 suppress、是否当次运行。
- R2. 不能被当前用户 invoke 的 designated agent 不绑定（保留现有 `canInvokeAgent` 与 workspace-scoping gate）。
- R3. suppress 一个 designated agent 只阻止其当次运行，不撤销其 durable 绑定。

**当次运行携带 bundle**

- R4. 绑定在 enqueue 之前完成，使 designated agent 的当次 task 携带该 skill 的完整 bundle（SKILL.md / references / scripts），符合 CONCEPTS.md「Skill Mention Gesture」规范。

**闭环反馈**

- R5. 评论提交前，trigger-preview 在 implicit 与 designated 指向同一 agent 时，反映该 agent 会被触发且携带该 skill——预览与实际提交行为一致。
- R6. *(deferred to follow-up)* designated skill 在 agent 的运行 prompt 中被显式点名。

### Key Flows

- F1. `@skill` 手势提交
  - **Trigger:** 用户在评论 composer 用 `@skill` chip + popover 指定一个 agent 并提交。
  - **Steps:** `parseSkillMentionAgents` 解析指定映射 → `bindAndEnqueueSkillMentions` 对每个 designated agent 过 `canInvokeAgent` / archived / runtime gate → 基于 skill 映射 durable 绑定（独立于去重与 suppress）→ 与 implicit triggers 合并 → 入队去重（仅影响 enqueue，不回溯撤销已发生的绑定）→ `filterSuppressed`（仅控制当次是否运行）→ enqueue → daemon 经 bound-skill 管道把 bundle 写入当次执行环境。
  - **Outcome:** designated agent 当次携带 skill 运行，且此后持久绑定该 skill。
  - **Covers:** R1, R2, R3, R4.

### Acceptance Examples

- AE1. **implicit + designated 同一 agent（YUP-407 场景）**
  - **Given:** agent X 是某 issue 的活跃对话 agent（会被 conversation_continuation 选中），用户 `@skill S` + 手势指定 X。
  - **When:** 评论提交。
  - **Then:** X 恰好入队一次（去重保留 implicit）、`agent_skill(X, S)` 行被创建、X 的当次 task 携带 S 的 bundle。Covers R1, R4.
- AE2. **designated 但被 suppress**
  - **Given:** 用户 `@skill S` 指定 X，同时 suppress X。
  - **When:** 评论提交。
  - **Then:** X 不当次运行，但 `agent_skill(X, S)` 行仍被创建。Covers R3.
- AE3. **designated 但不能 invoke**
  - **Given:** 用户指定了无权 invoke 的 agent X。
  - **When:** 评论提交。
  - **Then:** X 不绑定、不入队，且不泄漏其是否存在。Covers R2.
- AE4. **plain `@skill` 无手势**
  - **Given:** 评论含 `@skill S` 但未指定 agent。
  - **When:** 评论提交。
  - **Then:** S 不触发、不绑定；其他 implicit trigger 行为不变。Covers R1（反向边界）。

### Scope Boundaries

- 不改 CONCEPTS.md（规范本就正确，KD3）。
- 不改入队去重逻辑（去重防止双入队，正确）。
- 不改 mention 节点 / markdown 语法（沿用原 plan KTD3）。
- 不引入解绑机制（R3：绑定是持久的）。
- bind-on-submit 整体方案不在 active scope（原 plan 已实现）。

**Deferred to Follow-Up Work**

- R6（forced-skill prompt callout）：planning 读 `server/internal/daemon/execenv/runtime_config_sections.go:467` 的 `writeSkills` 后确认，prompt 点名需要把 designated skill 信号从 comment-submit 传到 task context 再到 daemon prompt（跨 handler / task / daemon / prompt 四层）。评论文本本身已含 `@skill` 提示、bundle 修复后也会到达，callout 边际价值有限。单独开 follow-up plan 评估，优先尝试复用 task 现有 metadata 机制以避免 schema migration。

### Outstanding Questions

- OQ1. *(resolved in planning)* trigger-preview 当前行为已厘清：后端 preview handler 不 routes on skills（`comment.go:1164-1229`，parse 后 intentionally discarded），显示完全由前端 `use-skill-designated-preview-agents.ts` 单独构造。R5 改法确定为纯前端（KTD3）。
- OQ2. *(resolved in planning)* callout 注入点确定为 `writeSkills`，但其跨层数据流成本导致 R6 defer（见 Scope Boundaries）。

### Pre-existing Test Failures (Residual)

本 plan 范围内的 Go handler 测试**全部 green**（U1 的两个反转/新增用例 + 其余 skill-mention 测试）。但全量 `go test ./internal/handler/` 在 self-host 上报 **7 个预存 fail**，**与本次 finding #4 修复无关**：

```
TestAutopilotDelegationAuthority_LineageBinding
TestClaimTask_ManualRetryReusesWorkdir
TestCreateComment_AutopilotLeaderMentionEnqueuesPrivateWorker
TestCreateComment_AutopilotWorkerResultWakesSquadLeader
TestEnqueueSkillMention_NoDesignationIgnoresAssignee
TestReconcileCommentsOnCompletion_AutopilotDelegationRestoresAuthority
TestUpdateComment_AutopilotAuthorityReStampedToEditingTask
```

**已排查的结论（2026-07-24）：**

- **不是 v0.4.9 回归**：在 v0.4.8 worktree（`/tmp/multica-v048`，已清理）跑同一组测试，**fail 列表完全一致**——这 7 个 fail 在 v0.4.8 时代就存在。
- **不是 merge 冲突解决错误**：v0.4.9 范围内的两个 commit（`6992c58de` Codex Fast mode、`fcb370edf` squads parent status）单独跑也都 PASS；只有当 fast-forward 到 bc2cd0d0a（merge commit）才出现完整 fail 列表——但 v0.4.8 自身已含此 fail 集合。
- **不是迁移未跑**：`schema_migrations` 同时含 4 个 159/160 条目（`159_backfill_direct_assignment_comment_source_task_id` + `159_chat_message_message_kind` 等），test DB（`:5432`）的迁移是完整的。
- **最可能的真因**：测试 fixture（`newAutopilotDelegationFixture` 等）假设 self-host 生产 DB（`:5433`）"已有 autopilot + agent + task + 历史评论"的 seed 数据；fresh migrate 的测试 DB（`:5432`）满足 schema 但没有这种"生产-like history"。失败的链路集中在 `autopilotDelegationAuthority`（`server/internal/handler/agent_access.go:245`）——lineage 验证走 `comment.source_task_id` 查 task，但 fixture 评论没 stamp 该字段。

**接手建议**（不在本 plan scope）：要么在 `internal/handler/handler_test.go` 的 `TestMain` 加 autopilot/agent/task seed hook（让 fresh DB 也能跑），要么把 fixture 改成 self-contained（不依赖外部 seed）。前者工作量小，但需谨慎——autopilot authority 是 security-critical（MUL-4857 "confused-deputy defense"），seed hook 不能让 authority 误授权。

### Sources & Research

- 代码：`server/internal/handler/comment.go:1491-1529`（triggerTasksForComment，bind 在 filterSuppressed 之前）、`:1536-1544`（dedupeTriggersByAgent）、`:1576-1689`（bindAndEnqueueSkillMentions，含 canInvokeAgent gate）、`:1698-1740`（bindDesignatedSkillsForTriggers，`:1718` 的 `source != mention_skill` 过滤即 finding #4）、`:1009-1018`（CommentTriggerPreviewRequest，read-only）、`:1164-1229`（preview handler）；`server/internal/handler/handler.go:467-493`（parseSkillMentionAgents）；`server/internal/handler/skill_mention_trigger_test.go:820-873`；`server/internal/daemon/execenv/runtime_config_sections.go:466-486`（writeSkills）；`packages/views/issues/hooks/use-skill-designated-preview-agents.ts`（前端 preview 构造）。
- 规范：`CONCEPTS.md`「Skill Mention Gesture」。
- 由来：`docs/plans/2026-07-17-001-feat-skill-mention-agent-gesture-plan.md`（R3 durable bind；finding #4 由 review 加入）。
- YUP-407 证据：`~/.multica/logs/backend.err.log` 21:22:45 段；`agent get` 显示 kahneman 仅绑 ce-ideate + multica。

---

## Planning Contract

### Key Technical Decisions

- KTD1. **bind 实现改为遍历 `skillBindings`，删除 source 过滤**（instantiates session-settled KD1/KD2）。`bindDesignatedSkillsForTriggers` 不再依赖 triggers 的 `source == mention_skill`，而是直接遍历 `bindAndEnqueueSkillMentions` 构造的 `skillBindings`（per-agent skill list，agent 已过 `canInvokeAgent`/archived/runtime gate），对每个 agent `UpsertAgentSkillEnabled` 其全部 designated skills。bind 位置保留在 `triggerTasksForComment` 的 dedup 之后、enqueue 之前（现有顺序），保证当次 task 带 bundle。Governs R1, R3, R4.
- KTD2. **不前置 `filterSuppressed`**（instantiates session-settled KD1）。用户判定「什么都不用防」——suppress 的 designated agent 也应绑定（R3）。bind 基于 `skillBindings` 与 suppress 无关，因此无需为 bind 调整 suppress 的位置；`filterSuppressed` 维持现有「仅控制当次 enqueue」的职责。Governs R3.
- KTD3. **trigger-preview 改法是纯前端**（instantiates session-settled KD4）。后端 preview handler 正确地保持 read-only（不 routes on skills），不动。前端在 composer（`comment-input.tsx` / `reply-input.tsx`）合并 designated agents 与后端 implicit triggers 时去重同一 agent，并把 designated 行的 reason 从泛泛的 "Skill mention designation" 改为反映新契约（携带 skill 运行）。Governs R5.

---

## Implementation Units

### U1. 后端 bind 与运行解耦 + 测试反转

- **Goal:** designated agent 无条件 durable 绑定 skill，与 dedup / source / suppress 解耦；反转固化旧行为的测试。
- **Requirements:** R1, R2, R3, R4（Covers AE1–AE4）
- **Dependencies:** none
- **Files:**
  - `server/internal/handler/comment.go`（`bindDesignatedSkillsForTriggers` 约 `:1716-1740`；`triggerTasksForComment` 约 `:1491-1529`）
  - `server/internal/handler/skill_mention_trigger_test.go`（`:820-873` 反转 + 改名 + 新增用例）
- **Approach:**
  1. 改 `bindDesignatedSkillsForTriggers`：去掉 `if t.Source != commentTriggerSourceMentionSkill { continue }` 分支，改为遍历 `skillBindings`，对每个 `agentKey → [skillUUID...]` 调 `UpsertAgentSkillEnabled`。`triggers` 参数若不再被使用则从签名移除或保留忽略（实现时定）。
  2. bind 调用点（`triggerTasksForComment` 内 `:1523` 附近）与顺序不动——仍在 dedup 之后、`filterSuppressed` 之前、enqueue 之前。
  3. 删除/修订 `bindDesignatedSkillsForTriggers` 与 `triggerTasksForComment` 里关于「designee 被 implicit 选中就不绑」的注释（`comment.go:1513-1516`、`:1698-1715`），改为说明新契约：bind 与运行解耦，只受 canInvokeAgent gate 约束。
- **Patterns to follow:** 现有 `UpsertAgentSkillEnabled`（单 SQL upsert，`ON CONFLICT DO UPDATE SET enabled=TRUE`）；`bindAndEnqueueSkillMentions` 内的 gate 序列（`canInvokeAgent` / archived / runtime）。
- **Test scenarios:**
  - Covers AE1. implicit（reply-parent / conversation_continuation）+ designated 同一 agent → `agent_skill` 行被创建 + 恰好一个 task（去重保留 implicit）。（反转现有 `:870` 的 `== 0` 断言为 `== 1`）
  - Covers AE2. designated + suppress 该 agent → 不入队但 `agent_skill` 行仍被创建（新增用例）。
  - Covers AE3. designated 但 agent archived / offline / 不可 invoke → 不绑、不入队、不泄漏（现有 `TestEnqueueSkillMention_UnavailableAgentSkippedOthersSurvive` 风格）。
  - Covers AE4. plain `@skill` 无 `skill_mention_agents` → 不绑、不触发（现有 `NoDesignationIsSilent` 保持）。
  - 已绑定 → `UpsertAgentSkillEnabled` 幂等，无重复行（现有 `AlreadyEnabledBindingIsNoOp` 保持）。
  - 多 skill 指定同一 agent → 全部绑定（现有 `MultipleSkillsDesignatedToSameAgentAllBound` 保持）。
- **Execution note:** test-first——先把 `:820` 测试的期望从「不绑」反转为「绑」（此时失败），再改 `bindDesignatedSkillsForTriggers` 使其通过，最后补 suppress-仍绑 用例。
- **Verification:** `make test` 绿；AE1–AE4 全部被测试覆盖；旧 `_NoBindWithoutRun` 测试改名（如 `_BindsEvenWhenImplicitAlsoTargets`）且注释反映新契约。

### U2. trigger-preview 前端一致性

- **Goal:** preview 在 implicit + designated 指向同一 agent 时去重显示，并明确标注该 agent 会携带 skill。
- **Requirements:** R5
- **Dependencies:** U1（行为一致；前端可并行开发，但语义跟随 U1 的新契约）
- **Files:**
  - `packages/views/issues/hooks/use-skill-designated-preview-agents.ts`
  - `packages/views/issues/components/comment-input.tsx`（`:65` 附近的 merge 点）
  - `packages/views/issues/components/reply-input.tsx`（`:83` 附近的 merge 点）
  - `packages/views/issues/hooks/use-skill-designated-preview-agents.test.ts`
- **Approach:**
  1. 在 composer 合并「后端 implicit triggers」与「前端 `skillDesignatedAgents`」处，按 agent id 去重：同一 agent 只保留一条行，若该 agent 既被 implicit 选中又被 designated，合并显示（标注携带 skill）。
  2. 把 designated 行的 `reason` 从 "Skill mention designation" 改为反映新契约的措辞（如「将携带该 skill 运行」），沿用 i18n glossary（`apps/docs/content/docs/developers/conventions.zh.mdx`）。
  3. 不动后端 preview handler 与 `CommentTriggerPreviewRequest`。
- **Patterns to follow:** 现有 `useSkillDesignatedPreviewAgents` 的 agent 解析与静默丢弃；composer 内 trigger-preview strip 的合并逻辑。
- **Test scenarios:**
  - implicit + designated 同一 agent → strip 只显示一条（不重复），标注携带 skill。
  - 仅 designated（无 implicit） → 显示，标注携带 skill。
  - 仅 implicit（无 designated） → 行为不变。
  - designated agent 已删除 / 跨工作区 → 静默丢弃（现有行为）。
- **Execution note:** 先看 composer 里 designated 与 implicit 的实际合并代码再定去重点；hook 与组件测试均需覆盖去重。
- **Verification:** `pnpm typecheck` + `pnpm test`（views）绿；去重与标注在前端测试中覆盖。

### U3. Ledger 登记

- **Goal:** 在本地定制 ledger 记录 finding #4 的修正，保持 self-host 工作流的可追溯性。
- **Requirements:** traceability（self-host 工作流）
- **Dependencies:** U1, U2（最终文件集已知后登记）
- **Files:** `docs/customizations.md`
- **Approach:** 更新 skill-mention 定制条目，标注 review finding #4（bind-without-run 过度防御）已被修正——bind 与运行解耦；指向本 plan；备注 R6（callout）defer 到 follow-up。
- **Test expectation:** none — documentation only.
- **Verification:** ledger 条目存在且指向本 plan。

---

## Verification Contract

| Gate | 命令 | 覆盖 |
| --- | --- | --- |
| Go 测试 | `make test` | U1：bind 解耦路径、反转的 `:820` 测试、新增 suppress-仍绑 用例、回归（已绑定/多 skill/不可 invoke/plain） |
| TS 类型 | `pnpm typecheck` | U2：`packages/views` |
| TS 测试 | `pnpm test` | U2：trigger-preview 去重与标注 |
| 手动 smoke（self-host） | — | 在 ≥2 agent 的工作区，对**活跃对话中**的 agent `@skill` + 手势指定一个未绑定技能 → 该 agent 绑定技能、当次带 bundle、preview 去重显示（复现 YUP-407 场景验证修复） |

---

## Definition of Done

- designated agent（含 implicit 同时选中，即 YUP-407 场景）在 submit 时 durable 绑定 skill，当次运行携带 bundle（AE1）。
- suppress 的 designated agent 仍被绑定，仅不当次运行（AE2）；不可 invoke 的不绑（AE3）；plain `@skill` 仍 silent（AE4）。
- `:820` 测试反转 + 改名 + 新增 suppress-仍绑 用例，`make test` 全绿。
- trigger-preview 在 implicit+designated 同 agent 时去重显示并标注携带 skill，`pnpm typecheck`/`pnpm test` 绿。
- finding #4 的 `source == mention_skill` 过滤删除；CONCEPTS.md 不动。
- ledger（`docs/customizations.md`）更新，R6 defer 记录在 Scope Boundaries。
