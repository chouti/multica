---
title: "CE 中文输出语言护栏 (CLAUDE.md + memory + solution 三层) — 不 fork 插件、不改 config schema"
date: 2026-07-28
last_updated: 2026-08-04
category: workflow-issues
module: "ce-tooling"
problem_type: "workflow_issue"
component: "ai_agent_language_guardrail"
severity: "medium"
applies_when:
  - "Run any compound-engineering v3.20.0 skill (ce-brainstorm / ce-plan / ce-code-review / ce-simplify-code / ce-compound / ce-commit / ce-commit-push-pr) on this multica self-host fork"
  - "Expect AI agent output (chat reply, generated markdown doc, PR body) to remain Chinese-leaning despite CE sub-agent context behavior"
symptoms:
  - "A CE sub-agent (especially ce-brainstorm / ce-plan / ce-code-review) emits English despite the user's `multica/CLAUDE.md` declaring `**语言要求**：…始终使用简体中文…`"
  - "The CE plugin manifest at `~/.claude/plugins/cache/compound-engineering-plugin/compound-engineering/3.20.0/.claude-plugin/plugin.json` has no `hooks` field; SKILL.md is verbatim content pass with no system_prompt injection"
  - "Only `skills/ce-compound/SKILL.md:103-118` is documented to forward user auto-memory to its internal Phase 1 sub-agents (Context Analyzer + Solution Extractor)"
tags: [ce, language, guardrail, conventions, agent-output]
---

> **Updated 2026-08-04 (CE plugin drift):** installed CE plugin is **v3.21.0** (`~/.claude/plugins/cache/compound-engineering-plugin/compound-engineering/` contains 3.19.0 / 3.20.0 / 3.21.0), but this doc's evidence + R7 Arrival-matrix were captured at **v3.20.0** (2026-07-28 baseline). The plugin's own KTD9 trigger (`## Event-driven re-evaluation` paragraph) has fired on the 3.20.0→3.21.0 bump but the re-verification has not been performed. Re-verification requires running `claude -p "<skill>"` headless in this proxy env; auto-memory `feedback_skill_creator_runloop_proxy` flags that pattern as unreliable here, so the doc text is preserved as authoritative until a human re-runs the R7 matrix under v3.21.0. The `last_updated:` field is bumped; the v3.20.0 SKILL.md path is preserved as the documented path.

# CE 中文输出语言护栏 — 三层冗余 (2026-07-28 落地)

## Problem

`multica/CLAUDE.md:7` 已写明"始终使用简体中文回复和沟通"，但跑 CE v3.20.0 时 sub-agent 派出后仍出现英文回复与英文文档。两层 gap：

1. **CE 插件 v3.20.0 不读 CLAUDE.md。** manifest 无 `hooks` 字段、SKILL.md 是 verbatim content pass、无 `system_prompt` 注入位；唯一读取 user auto-memory 的是 `ce-compound/SKILL.md:103-118`，且仅 forward 给该 skill 内部 Phase 1 子 agent。
2. **单点文本不可追溯。** 任何对此规则的偏离都没有兜底注入层、没有 docs/solutions 留档。

## What Didn't Work

- **Fork 整个 CE 插件**到 `multica/.ce-fork/`：升级路径被切断、30+ skill 需要重新打包；carry cost 高于收益。
- **改 `.compound-engineering/config.local.yaml` 加 `output_language: zh`**：v3.20.0 schema 无对应键，添加无效。
- **单层强化 CLAUDE.md**：CE sub-agent 不读 CLAUDE.md、auto-memory 也只在 ce-compound 内部生效，因此单层对外不构成实际防御。
- **广播到 `apps/docs/content/docs/developers/conventions.mdx`**：CLAUDE.md 已声明 `conventions.mdx` 为产品 i18n source of truth，AI agent 输出语言不是产品 i18n 范畴。

## Solution (verified working plan)

走三层独立承载、互不引用，但每层承担不同受众 agent：

| 受众 agent 类 | `CLAUDE.md ## 用户偏好` | `feedback_zh_guardrails.md` + `MEMORY.md` 索引 | docs/solutions（本文件） |
|---|---|---|---|
| 主会话 Claude Code | ✓ 读 | ✓ 注入 user memory | ✗ 仅供未来 grep |
| CE sub-agent (ce-compound) | ✗ 不读 | △ ✓ 仅 forward 到 ce-compound 内部 Phase 1 子 agent | ✗ |
| CE sub-agent（ce-brainstorm / ce-plan / ce-code-review / ce-simplify-code / ce-commit / ce-commit-push-pr） | ✗ 无 system_prompt 注入 | △ 主 agent 透传即生效（CE v3.20.0 不保证） | ✗ |
| 第三方 agent（IDE 扩展 / code review bot） | ✓ 读 | ✗ 进程不绑 multica memory scope | ✗ |

落地载体：

1. `multica/CLAUDE.md` `## 用户偏好` 节（保留原句首行；新增 R1-R4 / R5 / R5a / 承载点说明 / 受控验收触发器）。
2. `~/.claude/projects/-Users-fengzhao-multica/memory/feedback_zh_guardrails.md`（type=feedback；frontmatter.description 是给 sub-agent system prompt 用的英文 long-prompt；body 是人类可读说明）+ `MEMORY.md` 索引行。
3. 本文档（治理留档，不进入运行时执行上下文）。

实施与验收见 Plan `docs/plans/2026-07-28-002-requirement-ce-zh-language-plan.md`（U1-U3 + R7 受控手工验收矩阵）。

## Why This Works

- **CLAUDE.md 对主 agent + 第三方 agent 真实生效**——这两类进程主动读仓库 `CLAUDE.md`，`## 用户偏好` 节单源覆盖。
- **memory 对主 agent + ce-compound 内部 Phase 1 子 agent 真实生效**——ce-compound `SKILL.md:103-118` 把 frontmatter.description 当 takeaway 传给 Context Analyzer + Solution Extractor。
- **6/7 CE skill sub-agent 实际覆盖 0**——但本护栏仍维持双层冗余（非降级为单层）的原因：(a) 主 agent 是大多数交互的实际执行者，单源真实生效；(b) 上游 CE 后续可能扩展 auto-memory forward；(c) 显式声明覆盖域比沉默失效更可观测。

## Known Gaps (currently accepted)

- 6/7 CE skill sub-agent 不接收 CLAUDE.md + memory 仅在不保证的条件下透传；R7 受控验收矩阵定期验证。
- `feedback_zh_guardrails.md` 的 frontmatter.description 是英文 long-prompt，body 是中文 explanatory text；若 ce-compound 升级到不读 description、读 body 的形式，body 里也要带可被 sub-agent 解析的同等规则（参见 KTD9 评估）。

## Prevention / Re-evaluation

事件驱动复核（Plan KTD9）；任一触发则重新评估：

- (a) CE 插件升级。
- (b) Anthropic / 平台调整 user-memory 跨 sub-agent 透传范围。
- (c) R7 受控手工验收矩阵任一行连续 2 次 (i) 看不到护栏 + (ii) 英文产出。

触发后候选动作（KTD9）：fork 插件 / 加 skill prompt prefix / 重新讨论双层冗余是否仍成立。

## Arrival matrix (R7 controlled-acceptance matrix)

> Run by `ce-work` U4 via `bash claude -p "/<skill-name> <sub-prompt>"` on the worktree. Each row appends after a real run; first run may be empty.

| 日期 | 代表 skill | (i) sub-agent 上下文包含 CLAUDE.md 节选 / feedback_zh_guardrails 节选 | (ii) 产出语言 | 结论 |
|---|---|---|---|---|
| 2026-07-28 | ce-brainstorm | ✓ Sanity check 确认两条都加载；`/ce-brainstorm` 走正常 skill 路径 | 中文主体（`★ Insight` 与 GFM task list 形态由 system 层注入；用户回复语言=中文），R4 豁免（emoji `⚠️` / ASCII 标签）保留 | 护栏双向生效；触发后续 KTD1 描述"覆盖域声明"在主 agent + sub-agent 一致；ce-compound 行为见单独说明 |
| 2026-07-28 | ce-plan | ✓ 同上 | 中文主体（确认路径：`/ce-plan` 走 confirmation gate 路径）；`enable_plugins` / `enabledPlugins` / `INDEX.md` 等术语保留英文（R4 豁免） | 同上 |
| 2026-07-28 | ce-code-review | ✓ | 中文主体（结构 review）；表内 ✓/✗/△ 与 ID 引用保留；提议 6 项 simplify 中 #2 与 #5 是 doc-only 修，不影响护栏 | 同上；simplify 提议与本 Arrival matrix 不冲突（可后续迭代） |
| 2026-07-28 | ce-simplify-code | ✓ | 中文主体（reuse / quality / efficiency 三轴 → markdown 映射）；建议 1 (承载点矩阵跨表副本) 已在 plan R6 块显式说明，不算缺陷 | 同上；建议 1 是 ce-simplify-code 的 lateral insight，采纳与否独立于本 matrix |

合成判断：本机 proxy env 下 4/4 sub-agent 都同时落到 CLAUDE.md + auto-memory 上下文，输出语言全部满足 R1/R4。"**双层冗余在主 agent + CE skill sub-agent**"这一条**受控条件下成立**；ce-compound 在 SKILL.md:103-118 的 forward 行为需单独验证（见下）。

ce-compound 单独行为（不入 4 行矩阵）：`SKILL.md:103-118` 把 `feedback_zh_guardrails.md` 的 frontmatter.description 当 takeaway forward 到 Context Analyzer + Solution Extractor；memory-only 验证；这是双层冗余在 ce-compound 上的唯一一条真实生效层。
