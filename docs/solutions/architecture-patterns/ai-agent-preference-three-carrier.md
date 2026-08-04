---
title: "AI agent preference three-carrier landing pattern (CLAUDE.md + memory + governance trace) for CE plugins that do not forward CLAUDE.md"
date: 2026-07-28
last_updated: 2026-08-04
category: architecture-patterns
module: "ce-tooling"
problem_type: "architecture_pattern"
component: "tooling"
severity: "medium"
applies_when:
  - "A third-party plugin (or any agent runtime) is installed whose sub-agents do not read the host project's CLAUDE.md and cannot be modified"
  - "You need a permanent, cross-session preference to reach an agent that does receive user auto-memory (memory forwarding hook present in exactly one skill)"
  - "You want future maintainers to discover why a preference is layered across multiple carriers, not just what the carriers are"
  - "The preference must survive plugin upgrades and version drift, with each layer verified by an empirical matrix"
tags: [ce, claude-md, memory, governance-trace, three-carrier, ai-agent-preference, upgrade-survivable, sub-agent-context]
---

# AI agent preference three-carrier landing pattern (CLAUDE.md + memory + governance trace) for CE plugins that do not forward CLAUDE.md

## Context

当一个不可修改的编排插件会派发子 agent，却既不承诺把仓库级 `CLAUDE.md` 载入子 agent，也没有可用的 `system_prompt` 注入点时，永久 AI 偏好不能靠"把规则再写强一点"解决。规则是否持久，与规则是否进入某类 agent 的实际运行时上下文，是两个问题。

> **Updated 2026-08-04 (CE plugin drift):** installed CE plugin is **v3.21.0** (`~/.claude/plugins/cache/compound-engineering-plugin/compound-engineering/` contains 3.19.0 / 3.20.0 / 3.21.0), but this doc's evidence + Arrival-matrix were captured at **v3.20.0**. The plugin's own KTD9 trigger (paragraph below) requires re-running the matrix on the new version. The `last_updated:` field is bumped; the v3.20.0 SKILL.md path is preserved as the documented path. **Re-verification of the Arrival-matrix under v3.21.0 is pending** — it requires running `claude -p "<skill>"` headless, which auto-memory `feedback_skill_creator_runloop_proxy` flags as unreliable in this proxy env. Treat the v3.20.0 evidence as still authoritative until manually re-verified.

compound-engineering v3.20.0 展示了这个边界：`ce-compound` 会检查主会话的 auto-memory，并把相关摘录传给 Phase 1 的 Context Analyzer 与 Solution Extractor；该流程缺失或处于非 Claude Code 平台时会跳过，且 memory 只被视作补充上下文（`~/.claude/plugins/cache/compound-engineering-plugin/compound-engineering/3.20.0/skills/ce-compound/SKILL.md:103-118`）。这不是所有 skill 的通用注入契约。

因此，应把永久偏好设计成三个职责不同的 carrier，而不是假定三个文件构成三重运行时保障：

1. **规范 carrier**：仓库指令文件，服务于主 agent 及会主动读取仓库约定的第三方 IDE bot。
2. **注入 carrier**：用户级、项目作用域的 memory，服务于主会话及明确转发 memory 的编排路径。
3. **证据 carrier**：可检索的 `docs/solutions` 条目，记录边界、决策、验收结果与重评触发器；它默认不是运行时提示词。

## Guidance

### 1. 先按 agent 类建覆盖矩阵

不要用"已写入三个位置"代替覆盖分析。矩阵至少区分静态契约和实测到达：

| agent 类 | 规范 carrier | 注入 carrier | 证据 carrier |
|---|---|---|---|
| 主 agent | 有效 | 有效 | 仅供检索 |
| 明确转发 memory 的编排子 agent | 无保证 | 有效，但仅限已声明阶段 | 仅供检索 |
| 其他编排 skill 子 agent | 无保证 | 无契约保证 | 仅供检索 |
| 会读取仓库指令的第三方 bot | 有效 | 通常无效 | 仅供检索 |

"无契约保证"与"本次没有到达"不同。当前受控环境中，四个代表 skill 的子 agent 都实测收到了仓库规则和 memory；这是一项经验事实，不能升级成插件接口承诺。双层设计仍应保留，因为主 agent 与第三方读取者确有冗余，而 memory-forwarding 路径的覆盖域不同；对没有契约的子 agent，则应明确写成零个可依赖的运行时层。

### 2. 让每个 carrier 自包含且职责单一

- 规范 carrier 写完整、可执行的主规则、冲突优先级、例外白名单和歧义消解规则。不要只链接到 memory。
- 注入 carrier 的元数据摘要应能单独作为 system-prompt 摘录使用；正文保留给维护者阅读的镜像说明。不要依赖子 agent 再打开正文文件。
- 证据 carrier 记录版本化边界、覆盖矩阵、验收方法和失败阈值。它负责可追溯性，不应被宣传成运行时防线。
- 三者表达同一偏好，但不相互依赖才能被正确解释；任一 carrier 单独到达时都不应产生相反行为。

### 3. 把偏好写成可判定规则

自然语言偏好应包含：默认行为、优先级、允许保持原样的标识符类别、混合输出的判定方法，以及无法判断时的 tiebreaker。语言偏好可用主体文本密度阈值，而不是要求文件路径、API 字段、命令或逐字 CLI 输出也被翻译。这样验收结果可重复判读，且不会破坏技术准确性。

### 4. 用经验矩阵验收到达与行为

每个代表性派发路径都应记录两项独立结果：

1. **上下文到达**：子 agent 是否看到了规范摘录和／或 memory 摘录。
2. **行为符合**：最终产出是否满足偏好，同时正确保留豁免内容。

矩阵必须来自分别执行的真实路径，不能用"同一插件下应该一样"代替。此次设计通过 `bash claude -p "/<skill-name> <sub-prompt>"` 分别验证了 `ce-brainstorm`、`ce-plan`、`ce-code-review`、`ce-simplify-code`；4/4 均观察到两类上下文并生成符合规则的中文主体输出。具体四行证据见 `docs/solutions/workflow-issues/2026-07-28-002-ce-zh-language-guardrail-solution.md:74-87`。

### 5. 设置事件驱动的受控接受

对未受插件契约保障、但当前实测可用的路径，不要宣称永久解决，也不必立即 fork 插件。记录接受条件，并在以下事件发生时重评：

- 编排插件升级；
- 模型平台或宿主改变跨 agent 的 memory／仓库上下文转发；
- 验收矩阵连续两行同时出现"规则未到达"和"不符合偏好"的产出。

连续两行阈值可过滤单次模型波动，又能在系统性退化时触发架构决策。触发后再比较 fork 插件、增加 skill prompt prefix 或接受缩小覆盖域的成本。

## Why This Matters

单一仓库文件容易制造虚假的全局覆盖感；单一 memory 又绑定特定宿主和转发实现；只写解决方案文档则完全不改变运行时行为。三 carrier 架构把**规范权威性、运行时可达性、治理可追溯性**拆开，使每层失败都可被定位。

这种拆分也避免两个相反错误：一是因四次成功实测而把偶然的上下文转发当作稳定 API；二是因六类 skill 缺少静态契约，就删除对主 agent 和第三方 bot 真正有效的冗余层。覆盖矩阵让维护者知道每项保证属于哪个 agent 类、来自接口承诺还是环境观测。

此次落地还用以下命令形状验证了承载物结构，而不是仅验证模型输出：

- `grep -F '**语言要求**' CLAUDE.md` 保证原始权威规则未被改写；`grep -c '60%' CLAUDE.md` 与 `git diff CLAUDE.md | wc -l` 检查 tiebreaker 完整性及变更边界。
- `python3 -c "import yaml; ...; assert d['metadata']['type']=='feedback'"` 与 `grep -F 'feedback_zh_guardrails' MEMORY.md` 检查注入 carrier 的类型及索引可发现性。
- `python3 -c "import yaml; ...; assert d['module']=='ce-tooling'; assert d['problem_type']=='workflow_issue'"` 与 `wc -l SOL` 检查证据 carrier 的分类及紧凑度。
- `awk '/^\| 2026-07-28/ {c++} END' SOL` 得到 4，证明 Arrival matrix 是四条真实记录，而非汇总结论。

这些命令是该设计已经采用的规范证据形状；新偏好可替换具体字段和断言，但应继续分别验证内容不变量、carrier 元数据、索引可发现性和实测行数。

## When to Apply

- 第三方编排器会创建隔离子 agent，但不能修改其插件、manifest 或派发 prompt。
- 偏好需要跨会话长期存在，例如语言、审查风格、安全边界或输出格式。
- 仓库指令、用户 memory 与子 agent 上下文的读取范围不一致。
- 当前环境观察到隐式转发，但上游没有把它声明为稳定契约。
- fork 插件的升级维护成本高于暂时接受有限覆盖的成本。

若编排器提供稳定、可测试的统一 system-prompt 注入接口，应优先使用该接口；此模式仍可保留规范和证据 carrier，但不必把 memory 当作关键运行时桥梁。

## Examples

已落地的中文语言偏好是一个完整实例：仓库 `CLAUDE.md` 承载权威规则和例外，项目 auto-memory 承载可转发摘要，`docs/solutions` 承载覆盖边界和 Arrival matrix。具体规则、失败方案、四次受控验收及重评条件见 `docs/solutions/workflow-issues/2026-07-28-002-ce-zh-language-guardrail-solution.md`。

同一模式也可用于"所有安全审查必须列出证据等级"：仓库规则定义等级和豁免，memory 摘要提醒可转发的审查子 agent，solution 记录哪些审查器实际收到规则。若某个第三方 IDE bot 只读仓库文件，它仍能遵循规范；若某个编排子 agent 只收到 memory，它也能执行最小完整规则；两者都不应依赖治理文档进入 prompt。

## Related

- `docs/solutions/workflow-issues/2026-07-28-002-ce-zh-language-guardrail-solution.md` — this pattern's canonical worked instance (Chinese-language guardrail). Cross-references the same files (`CLAUDE.md`, `feedback_zh_guardrails.md`, `MEMORY.md`, this `architecture-patterns` directory) and arrives at the same three-carrier layout, but frames it as a workflow_issue → specific fix. The new architecture_pattern doc is the generalization.
- `docs/solutions/architecture-patterns/runtime-build-provenance.md` — precedent for "one rule across multiple independent carriers, each with its own audit / rejection logic" (release tag stamped in shell, frontend TS, and Go backend). The same meta-claim applies; the carrier count and shapes differ.
- `docs/solutions/architecture-patterns/resumable-upgrade-plan-artifact.md` — precedent for "rely on a typed on-disk artefact, not conversation memory". The docs/solutions governance trace carrier is a smaller instance of this principle.
- `docs/solutions/developer-experience/run-loop-proxy-unusable.md` — corroborates the CE v3.20.0 "verbatim-prompt-pass / no `system_prompt` injection" mechanism that motivates this pattern in the first place.
