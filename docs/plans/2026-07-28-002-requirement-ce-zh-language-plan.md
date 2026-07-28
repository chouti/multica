---
title: "CE 中文护栏（仓库+用户双层） - Plan"
type: docs
date: 2026-07-28
topic: ce-zh-language-guardrail
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-brainstorm
execution: code
---

# CE 中文护栏（仓库+用户双层） - Plan

> Product Contract preservation: restructured, no scope change. R6 改写为 "两处运行时承载点 + 一处治理留档" 双轨；新增 R5a（语言密度裁决）、R5 配套 AE4b（英文为主 中英混血 case）、R7（受控手工验收矩阵）；要求 Outstanding Questions 已空但保留节。

## Goal Capsule

- **Objective:** 在不 fork compound-engineering 插件、不改其配置 schema 的前提下，给 multica self-host 仓引入一条永久性"AI 输出语言护栏"，覆盖对话回复、CE skill 写出的产出文档两类产出；PR / GitHub Issue / commit message 等团队公开输出保持英文。
- **Product authority:** 本文定义对话与文档语言规则、豁免清单、覆盖失败模式。任何 CE skill 写出的 markdown 文档、对话回复必须遵循；技术标识符（commit prefix / API 字段名 / 文件路径 / 命令）按豁免清单保持英文。
- **Execution profile:** Documentation-only。三处独立承载、共四处文件：`multica/CLAUDE.md` 强化（U1）、`~/.claude/projects/-Users-fengzhao-multica/memory/feedback_zh_guardrails.md` 新增 + `MEMORY.md` 索引挂上（U2）、`multica/docs/solutions/workflow-issues/2026-07-28-002-ce-zh-language-guardrail-solution.md` 新增（U3——与同日 plan `2026-07-28-001-feat-cli-version-help-menu-plan.md` 同号不同类型）。**受控手工验收矩阵（U4）** 在主流程末尾跑：证明 CE sub-agent 是否真接收护栏。无代码改动、不动 CE 插件、不动 `.compound-engineering/config.local.yaml`。
- **Tail ownership:** 本 plan 写完后由 ce-work 执行 U1–U4；U4 的受控验收由 ce-work 子 agent headless 跑完，结果写入 `docs/solutions/.../2026-07-28-002-*.md` 的 Arrival matrix 节。
- **Stop conditions:** U1/U2/U3/U4 完成、CLAUDE.md 与既有 `## 用户偏好` 节不矛盾、`MEMORY.md` 索引挂上、R7 受控验收矩阵至少 1 行实际记录。如果未来 CE 插件升级到 v3.21+ 并显式读取 auto-memory 作为 sub-agent context，`feedback_zh_guardrails.md` 不需要重写即可自动生效。**事件驱动复核触发器**（任一触发即由人评估 KTD1 是否仍成立）：(a) CE 插件升级；(b) Anthropic / 平台调整 user-memory 跨 sub-agent 透传范围；(c) 受控手工验收矩阵（R7）任一行同时 (i) 看不到护栏且 (ii) 英文产出 ≥2 次连续。评估结果可触发：fork 插件 / 加 skill prompt prefix / 重新讨论 KTD1。
- **Open blockers:** 无。

---

## Product Contract

### Summary

为 multica self-host 仓引入一条永久性 "AI 输出语言护栏"：

- 对话回复：简体中文。
- 文档类产出（docs/plans / docs/solutions / CONCEPTS / docs/explainers / requirements-only plan）：简体中文。
- PR 公开输出（PR title/body、commit message、issue title/body）：保持英文（沿用 Multica 团队 4-locale 协作约定）。
- 用户中英混血提问：尊重用户文字，不主动重写、不主动提示翻译；以 R5a 的 60% 语言密度裁决输出主语言。
- 技术标识符一律英文：commit type/scope、API 字段、文件路径、命令、堆栈片段、YAML frontmatter key、REPL 报错原文。

实现靠仓库 + 用户两层冗余：

| 承载点 | 内容 | 防御对象 |
|---|---|---|
| `multica/CLAUDE.md` `## 用户偏好` 节 | 文本形式规则 + 豁免清单 | 读仓库 CLAUDE.md 的进程（主 agent / 第三方 IDE bot / code review tool） |
| `~/.claude/projects/-Users-fengzhao-multica/memory/feedback_zh_guardrails.md` + `MEMORY.md` 索引 | 同型规则 + 给 sub-agent 的显式指令片段 | 被自动注入 user-memory 的进程（主 agent + ce-compound sub-agent 显式 forward memory） |
| `multica/docs/solutions/workflow-issues/2026-07-28-002-ce-zh-language-guardrail-solution.md` | 留档：根因、选型、为何不 fork 插件、上游升级应对 | 治理留档：未来接手 / 升级时可检索（**不进入运行时执行上下文**） |

R6 给出更精细的覆盖域矩阵：双层冗余对主 agent + 第三方读仓库的进程是真实冗余；对 6/7 CE skill sub-agent 仅 Carrier 2（auto-memory）有限生效，回归 U3 治理留档不约束运行时——这一可见的失效模式比沉默失效更可观测。

### Problem Frame

CLAUDE.md 已写明"始终使用简体中文回复和沟通"，但实际跑 compound-engineering (CE) v3.20.0 时，sub-agent 派出去后常常出现英文回复与英文文档。两层 gap：

1. **CE 插件 v3.20.0 不读 CLAUDE.md。** 插件 manifest（`.claude-plugin/plugin.json:1-20`、root `plugin.json`、marketplace.json）均无 `hooks` 字段、无 SessionStart / UserPromptSubmit 预处理；SKILL.md 是 verbatim content pass，没有 `system_prompt` 注入位；唯一读取 user auto-memory 的位置是 `skills/ce-compound/SKILL.md:103-118`，其它 skill 是否透传未保证。
2. **现有 "中文" 规则是单点文本。** `multica/CLAUDE.md:7` 的 "**语言要求**：不论用户使用什么语言交互，始终使用简体中文回复和沟通" 写在 `## 用户偏好` 节，没有配套豁免、没有兜底注入层、没有 docs/solutions 留档。任何对此规则的偏离都不可追溯。

`docs/solutions/conventions.mdx`（CLAUDE.md 引为 i18n 与中文翻译的 source of truth）只覆盖产品 i18n，不覆盖 AI agent 输出语言；仓库无 `feedback_*` 类型的 zh 偏好 memory。

### Key Decisions

- **KTD1. 双层冗余而非单层强化。** (session-settled: user-approved "不明确/两者都有" — over single-layer) 用户 memory + 仓库 CLAUDE.md 双写，任何一层失效另一层仍生效。**双层不是对全部受众等同生效；二者覆盖域不同**（详见 R6 表格与 KTD8 受控手工验收矩阵）。Governs R1, R6。
- **KTD2. PR / commit / issue 保留英文。** (session-settled: user-directed — over 「主体中文 PR」 替代选项) PR 类公开输出与对话 / 文档输出分轨。Governs R2 + R3。
- **KTD3. 不 fork CE 插件。** (session-settled: user-approved "先调研再决定" — over fork 插件) 插件升级路径被切断需要 rebase 工作；30+ skill 都需要 patch；现有证据不足以证 "A 不够用"。Governs R4.
- **KTD4. 不改 `.compound-engineering/config.local.yaml`。** (paired with KTD3) v3.20.0 schema 无 `output_language` 键，加了等于无操作。Governs R4.
- **KTD5. 用户中英混血提问时主动权归用户。** (session-settled: user-approved "用户主导豁免" — over 严格护栏 / 不提醒). 不主动重写、不主动提示翻译。R5a 提供可观察的语言密度裁决。Governs R5 + R5a.
- **KTD6. 永久护栏、不画复查点。** (session-settled: user-approved "永久护栏" — over 复查验收点 / 暂锁 plan C) 与 `feedback_git_guardrails.md`、`feedback_plugin_lock_local.md` 同寿命。事件驱动复核触发器仍保留（见 KTD9）。Governs R4.
- **KTD7. 豁免清单的白名单必须显形。** (paired with KTD1 + KTD2). 列具体例子（`feat(server)`、`<HomePage />`、`pnpm dev:web`、`pnpm` stack trace）让 agent 在无法判定时落到白名单里。Governs R6 (豁免块).
- **KTD8. 受控手工验收矩阵（R7）作为护栏的运行时验证手段。** (paired with KTD1) 不入 CI / 不阻塞主 agent 流程；ce-work 子 agent 在 U4 跑代表 skill 集合（ce-brainstorm、ce-plan、ce-code-review、ce-simplify-code；ce-compound 因 forward memory 行为独立可观察），结果写 `docs/solutions/...-solution.md` 的 Arrival matrix 节。Governs R7 + Verification Contract U4 段.
- **KTD9. 永久护栏的事件驱动复核触发器。** (paired with KTD6) 触发点 = (a) CE 插件升级 / (b) Anthropic 平台调整 user-memory 透传范围 / (c) R7 矩阵任一行同时 (i)+(ii) ≥2 次。评估动作 = fork 插件 / 加 skill prompt prefix / 重论 KTD1。Governs Goal Capsule Stop Conditions (事件触发器段).

### Requirements

**主规则**

- R1. AI 与用户的对话回复默认简体中文，除非用户在文字中已表现出英文意图。R5a 给出此条例外情形的可观察仲裁。
- R2. CE skill 写出的内部 markdown 文档（docs/plans、docs/solutions、CONCEPTS、docs/explainers、requirements-only plan）默认简体中文。
- R3. PR title、PR body、commit message、GitHub Issue title/body 保持英文。

**豁免清单（白名单）**

- R4. 以下类别一律保持英文，无论上层规则：
  - commit type / scope：`feat`、`fix`、`refactor`、`docs`、`test`、`chore`、`server`、`packages/core`、`apps/web` 等。
  - 文件路径、API 字段名、命令名：`packages/views/HomePage.tsx`、`X-Workspace-ID`、`pnpm dev:web`、`make start`。
  - CLI / REPL 输出原文：`pnpm` 的 stack trace、`tsc` 编译报错原文、`go vet` 输出。
  - 代码块整体：被嵌入文档的代码片段以原文出现；不中文化 `function foo() { ... }` 等结构。
  - YAML frontmatter 字段名：`module`、`tags`、`problem_type`、`artifact_contract`、`artifact_readiness`。
  - 文档 H1 标题仍按英文 `Title - Plan` 模板。

**用户主导的边界**

- R5. 用户以中英混血提问（如 "帮我 rebase 这个 PR"、"plan 这个需求"）时：
  - 不主动中译英、英译中。
  - 不主动提示 "我应该用中文 / 英文回答"。
  - 把用户的混血视为其个人 voice 一部分，回应用与之匹配的语言密度。
- R5a（语言密度裁决）。输出语言以最近一条用户输入（句子级）为判定域：**中文字符占总字符（含标点、空格、英文术语）数 ≥60% → 中文为主，允许夹用英文术语；英文字符 ≥60% → 英文为主，允许夹用中文术语；其余情况视作中性，按主规则 R1 处理（默认中文）**。这条裁决覆盖 R1 的"英文意图"条件。

**承载点契约**

- R6. 三处独立承载规则内容、互不引用。U1/U2 是**运行时规则承载点**（影响主 agent 与（按 ce-compound 现状）某些 CE sub-agent）；U3 是**治理留档**（为未来接手者提供决策可检索性，不进入运行时执行上下文）。两处运行时承载点的覆盖域不互斥：

  | 受众 agent 类 | CLAUDE.md (U1) | memory (U2) | docs/solutions (U3) |
  |---|---|---|---|
  | 主会话 Claude Code 进程 | ✓ 读 `multica/CLAUDE.md` | ✓ 注入 user memory | ✗ 仅供未来 grep |
  | CE sub-agent (ce-compound) | ✗ SKILL.md 不读 CLAUDE.md | △ ✓ **只 forward 给 ce-compound 内部 Phase 1 子 agent**（Context Analyzer + Solution Extractor，`SKILL.md:103-118`），**不**通到其它 CE skill 的 sub-agent | ✗ |
  | CE sub-agent (ce-brainstorm / ce-plan / ce-code-review / ce-simplify-code / ce-commit / ce-commit-push-pr) | ✗ 无 system_prompt 注入位 | △ 仅在 claude code 主 agent 把 memory 透传到 sub-agent 时有效（CE v3.20.0 不保证） | ✗ |
  | 第三方读 CLAUDE.md 的 agent（IDE 扩展 / 自动 code review bot） | ✓ 读 CLAUDE.md | ✗ 进程不绑 multica 项目 memory scope | ✗ |

  决策层仍维持双层冗余而非降级为单层，理由：(a) 主 agent + 第三方 agent 共 2 条运行时路径真冗余；(b) 升级到 CE 插件后可能扩大覆盖；(c) 显式声明覆盖域比沉默失效更可观测。
  - `multica/CLAUDE.md` 在 `## 用户偏好` 节列本节的主规则 + 豁免清单；不重复 docs/solutions 的解释性叙述。
  - `~/.claude/projects/-Users-fengzhao-multica/memory/feedback_zh_guardrails.md`（type=feedback）写本节主规则。`frontmatter.description`（英文，关键文本作为 sub-agent system prompt 中的纯英文指令）写 "if you are processing a CLAUDE.md-anchored workflow and the user is the multica self-host owner, reply in Simplified Chinese except for the listed 豁免 categories"。`MEMORY.md` 索引同步挂上。MEMORY.md 索引是发现机制——把已生成的规则文件暴露给被自动注入 user-memory 的进程，索引本身不构成 R6 的规则依赖。
  - `multica/docs/solutions/workflow-issues/2026-07-28-002-ce-zh-language-guardrail-solution.md` 写本次根因、为什么是双层不是单层、为什么不动 CE 插件、不写 config、上游 CE 升级时怎么评估。该文件不约束运行时语言选择；仅承担治理留档职能。

**受控手工验收矩阵（不进入 CI）**

- R7. 护栏落地后，按以下矩阵受控手工跑一遍（不在 CI；不阻塞主 agent 流程）：
  - **代表 skill 集合**：ce-brainstorm、ce-plan、ce-code-review、ce-simplify-code（共 4 个；ce-compound 因已显式 forward memory 单独行为可观察）。
  - **观察项**：(i) sub-agent 是否在其 system prompt 或 prompt 注入里看到 CLAUDE.md 节选 / `feedback_zh_guardrails.md` 节选；(ii) 最终产出语言是否符合 R1/R2/R4。
  - **结果归档**：`multica/docs/solutions/workflow-issues/2026-07-28-002-ce-zh-language-guardrail-solution.md` 末尾追加一节 `## Arrival matrix YYYY-MM-DD`（每次跑记一次，含日期、sk 集合、观察项 i/ii、结论）。这构成 "已知 sub-agent 是否真接收护栏" 的证据链。
  - **ce-compound 单独行为**（不进矩阵）：ce-compound 在其 SKILL.md:103-118 仅 forward memory 给内部 Phase 1 "Context Analyzer" + "Solution Extractor" 两个子 agent，不通到其它 CE skill 的 sub-agent；KTD1 "双层对 ce-compound sub-agent 真正冗余" 这条描述在该表的 △ 列已收紧。R7 仅跑非 ce-compound 的 4 个代表 skill。
  - **失败信号**：若任一行 (i) 为 "否" 且 (ii) 为 "英文产出"，触发 KTD9 事件驱动复核。

### Acceptance Examples

- AE1. 对话全程中文回复
  - **Given:** 用户用中文提问 "为什么我的 CE 中文护栏没生效"。
  - **When:** AI 给出解释。
  - **Then:** 通篇简体中文；技术标识符（`SKILL.md`、`config.local.yaml`、`.compound-engineering`）保留英文。
  - **Covers R1, R4.**
- AE2. 内部 markdown 文档中文
  - **Given:** 用户触发 ce-brainstorm 写 `docs/plans/2026-XX-XX-...-plan.md`。
  - **When:** ce-brainstorm 写文档。
  - **Then:** Summary / Problem Frame / Key Decisions / Requirements / Acceptance Examples / Scope Boundaries 正文为简体中文；frontmatter 字段名（`title/type/date/topic/artifact_contract/artifact_readiness/product_contract_source/execution`）保持英文；H1 标题按英文 `Title - Plan` 模板。Commit 链接与文件路径保持英文。
  - **Covers R2, R4.**
- AE3. PR 公开输出保留英文
  - **Given:** 用户触发 ce-commit-push-pr。
  - **When:** CE 生成 PR body 与 commit message。
  - **Then:** commit message 形如 `fix(server): handle workspace member race condition`；PR body 与 issue 同步文本保持英文。
  - **Covers R3.**
- AE4. 用户中英混血提问（中文为主）
  - **Given:** 用户提问 "帮我 rebase 一下 feat/audit-log 这个分支，然后再 push 上去"。
  - **When:** AI 回复。
  - **Then:** 中文为主文（按 R5a，中文字符 ≥60%）；`feat/audit-log` 这类术语英文保留；不用 "Rebase 是指…" 开头的强补语；不主动提示翻译。
  - **Covers R5, R5a.**
- AE4b. 用户中英混血提问（英文为主）
  - **Given:** 用户提问 "Run `pnpm typecheck` and paste the output here"。
  - **When:** AI 回复。
  - **Then:** 英文为主文（按 R5a，英文字符 ≥60%）；命令与堆栈英文保留；不主动切换成中文解释。
  - **Covers R5, R5a.**
- AE5. docs/solutions 留档可被发现
  - **Given:** 后续接手者 / 升级者搜 `compound-engineering` 与 `中文` / `language`。
  - **When:** 在 `docs/solutions/` 下 grep / 浏览分类目录。
  - **Then:** 命中 `workflow-issues/2026-07-28-002-ce-zh-language-guardrail-solution.md`（不是 `001-`！同日已有 `2026-07-28-001-feat-cli-version-help-menu-plan.md` 占用 plan 编号 001；同日编号属于 plan-vs-solution 互不冲突），YAML frontmatter 含 `module: workflow-issues`、`tags: [ce, language, guardrail, conventions]`、`problem_type: workflow-coordination`。
  - **Covers R6.**
- AE6. CE 插件升级时不被覆盖
  - **Given:** CE 插件从 v3.20.0 升到 v3.21+。
  - **When:** 运行 `brew upgrade multica` / marketplace 重装。
  - **Then:** 本护栏三处文件内容不变；CE 插件升级不会写入、删除、或修改 `multica/CLAUDE.md`、`feedback_zh_guardrails.md`、`workflow-issues/2026-07-28-002-*.md`。
  - **Covers R6.**
- AE7. 第三方读 CLAUDE.md 也生效
  - **Given:** 第三方 AI agent（例如 IDE 扩展、自动 code review bot）打开仓库并读取 `multica/CLAUDE.md`。
  - **When:** 第三方开始回复。
  - **Then:** 回复遵循 CLAUDE.md 主规则 + 豁免清单（无需依赖 auto-memory 注入）。
  - **Covers R6.**
- AE8. 受控手工验收矩阵产生第一行证据
  - **Given:** U1/U2 已落地。
  - **When:** U4 执行 4 个代表 CE skill 受控验收。
  - **Then:** `docs/solutions/workflow-issues/2026-07-28-002-ce-zh-language-guardrail-solution.md` 末尾的 Arrival matrix 节包含至少 4 行（每代表 skill 一行），标明 (i) 看到护栏/未看到、(ii) 中文/英文产出。
  - **Covers R7.**

### Scope Boundaries

- **不在范围**（明确划走）
  - 修改 CE v3.20.0 任意 `skills/*/SKILL.md`——上游仓库，不在你控制范围。
  - 在 `.compound-engineering/config.local.yaml` 新增 `output_language: zh` 键——当前 schema 无读取路径，加了等于无操作。
  - 修改 CE 插件的 persona 文件、dispatch template。
  - 把 "中文护栏" 加入 CommitLint / PR-CI 检查——会推动到 PR 描述英文约束外的额外纵深；用户已表态 "PR 保留英文"。
  - 把 "中文护栏" 广播到 `multica/docs/conventions.mdx`（产品 i18n 文档）——后者管 Multica 产品的中文翻译；两者不同领域。
  - 修改 `docs/solutions/workflow-issues/` 之外其它 `docs/solutions/` 子目录。
  - fork / 复制 CE 插件到 `multica/` 下——CE 升级路径被切断，carry cost 高于收益。
  - mobile 端 AI agent 输出语言——mobile 自成体系，不在 CE 触达范围。
  - lint / typecheck / 测试——本次无代码改动，所有 CE test 流程不受影响。

### Sources / Research

- CE 插件 v3.20.0 全结构 + 入口分析的 ground truth 路径：`~/.claude/plugins/cache/compound-engineering-plugin/compound-engineering/3.20.0/`（不依赖 temporary scratch dir；只要该本地缓存未被清理，就仍是真实可读源）。
- 关键事实：所有 7 个抽样 SKILL.md（`ce-brainstorm`、`ce-plan`、`ce-commit`、`ce-commit-push-pr`、`ce-code-review`、`ce-simplify-code`、`ce-compound`）无 `language` / `locale` / `zh` 词条；`grep -rli "chinese|中文|simplified chinese|mandarin|用中文|使用中文|中文回复" skills/` 0 命中；sub-agent dispatch 是 verbatim prompt pass，无 `system_prompt`、无 CLAUDE.md 注入；CE manifest 无 hooks；config schema 无对应 key。Schema 现有 precedence 链 (in-prompt > agent-instructions/memory > config > default) 已把 memory 列为合法 override 源。
- 本地文档调研的事实：本仓 CLAUDE.md 已有软规则（§"语言要求"行）；无 `feedback_*` 类型的 zh 偏好 memory；`conventions.mdx` 不覆盖 AI agent 输出语言；`multica/CLAUDE.md` 已声明 `conventions.mdx` 为 i18n source of truth，不为 AI 输出语言 source of truth。这些结论在 `~/.claude/projects/-Users-fengzhao-multica/memory/` 项目 memory 检索可得（`MEMORY.md` 索引 + `feedback_git_guardrails.md`、`feedback_plugin_lock_local.md` 等同型先例文件）。
- 同型先例 1（hook 类）：`feedback_git_guardrails.md` —— 由 PreToolUse hook 强制；与本文方案虽安装位置不同，但作用一致。
- 同型先例 2（plugin lock 类）：`feedback_plugin_lock_local.md` —— 在 settings.local.json 显式锁住插件；本文方案是反向——故意不锁、依赖三处冗余守。
- 自定义工作流：`project_local_customization_workflow.md` —— 5 步法（form choice A/B/C、feat branch、scope-word commits、ledger registration、PR-by-universality）适用于本次 "对仓库做永久约定" 场景；当前 plan 文档本身就是 ledger entry。
- 升级纪律：`project_daemon_upgrade.md`、`project_upgrade_plan_artifact.md`、`project_version_stamp_on_upgrade.md` 不直接相关但说明 multica 仓库的 "永久约定 + 文档留档" 传统；CE 升级时如发现 A 不够用、可走 fork。
- **研究型 scratch 路径说明**：调研过程使用的临时 dossier（ce-brainstorm 与 ce-doc-review 阶段产物）写在 `/tmp/compound-engineering-501/` 之下，**不在用户本机状态里留存**——这些 scratch 是本会话进程内 ephemeral cache，每次新会话须重跑 grounding（CE plugin 路径仍是单一信源）。本 plan 的 DoD 不要求保留它们。

---

## Planning Contract

Planning Contract 部分补充 Product Contract 已落定之外的实施侧决策（KTD8 派发风格 + 受控手工验收的实现方式 + Verification 的具体命令 + DoD 的全局条件）。

### Implementation Sequencing

- **U1 → U2 → U3 → U4 顺序执行**。U1 改 `multica/CLAUDE.md` 后 U2 才挂 memory 才有意义；U3 留档依赖 U1/U2 的最终表述；U4 受控验收依赖 U1/U2/U3 全部落地。
- **不并发**：U1 与 U2 文本独立但本 plan 要求一次 commit (一含多)。
- **verification 一回**：U1/U2/U3 各有自己的 Files & Verify 字段；U4 自动产出 Arrival matrix 行；最后跑 DoD 全体检查。

### Key Technical Decisions (recap of session-settled)

(完整列表见 Product Contract Key Decisions 节 — KTD1–KTD9 — 此处只在 planning 层引用：)

- **KTD10. Verification Contract 的执行环境 = 默认 `bash` 一次性命令脚本，输出按 Verification 字段逐项通过/失败。** Governs Verification Contract 全段。

### Assumptions

- 假定 CE 插件 v3.20.0 的 SKILL.md 文本不会跨 patch 自动改写（本 plan 范围不动 CE 插件）。
- 假定 `~/.claude/projects/-Users-fengzhao-multica/memory/MEMORY.md` 当前 frontmatter 兼容 `memory`-format（与既有 `feedback_git_guardrails.md` 同型）。
- 假定 ce-work 的 headless sub-agent capability 在 multica 仓范围可调用 Claude Code（与 `multica-skill` 已一致）。
- 假定 `MULTICA_CLI` / `codex` / `grok` 等用于受控验收的环境仍可用；若任意不可用，U4 单点失败不阻塞 U1/U2/U3 落地。

---

## Implementation Units

每个 U 都按 ce-plan §3.5 模板：Goal / Requirements / Files / Approach / Test scenarios / Verification。

### U1. CLAUDE.md 强化

- **Goal.** 在 `multica/CLAUDE.md` 的 `## 用户偏好` 节补齐中文护栏主体规则 + 豁免白名单 + R5a 裁决 + R7 受控验证说明，**不删原句** "**语言要求**：不论用户使用什么语言交互，始终使用简体中文回复和沟通"。
- **Requirements.** R1, R2, R3, R4, R5, R5a, R6 (CLAUDE.md 块).
- **Dependencies.** 无（前置）。
- **Files.** `CLAUDE.md`（在仓库 root）。
- **Approach.**
  - 读现有 `multica/CLAUDE.md`，定位 `## 用户偏好` 节。
  - 在该节追加（保留原句为开篇），顺序：
    1. 原句（**语言要求**：…）—— 不删，作为首要承诺。
    2. 主规则块：R1 + R2 + R3 简化为一句 "对话回复、CE 文档默认中文；PR/issue/commit 保持英文"。
    3. 用户主导边界：R5 整段、R5a 60% 语言密度裁决。
    4. 豁免白名单（R4）：commit type/scope、文件路径/命令、CLI 原文、代码块、YAML frontmatter key、H1 标题模板，每类一行示例。
    5. 承载点说明：CLAUDE.md / memory / docs/solutions 三层分工 + **R6 覆盖域表在本段以 4×3 简化版内嵌一次**（便于读 CLAUDE.md 的人不必跳到 `docs/solutions/...-solution.md` 也知道哪些 agent class 收哪条规则；表头 4 列 = 主 agent / ce-compound / 6/7 CE skill / 第三方 agent；表头 3 行 = CLAUDE.md / memory / docs/solutions；表内 ✓/✗/△ 标识生效）。**该表与 docs/solutions 中 R6 表是同一信息的冗余表述；不在 CLAUDE.md 引用 Arrival matrix（R7 的 4 行验证表，不承担 R6 覆盖域描述）。**
    6. 受控验收：提及本节不进入 CI、CE sub-agent 覆盖由 U4 受控验收验证；事件触发器见 KTD9。
  - 注释密度与现有 `## 用户偏好` 节正文保持接近，**不**用新引号把原句包进去。
  - 中英混血规则（R5、R5a）放显眼位置（紧跟主规则后），不埋在末尾。
- **Test scenarios.**
  - 输入 `grep -n '语言要求' CLAUDE.md` 应能匹配原句首行（保持原句完整）。
  - 输入 `grep -n '中文为主\|默认简体中文\|保持英文' CLAUDE.md` 应能匹配新追加段落至少 3 次。
  - 输入 `grep -n 'pnpm\|commit\|YAML frontmatter\|60%' CLAUDE.md` 应能匹配豁免白名单与 R5a 判定关键词。
- **Verification.**
  - `! grep -F '语言要求' CLAUDE.md` 退出码 0。
  - 文件长度新增不超过 60 行（避免冗长）。
  - `git diff` 显示新加段落与未触动原句。

### U2. feedback memory + MEMORY.md 索引

- **Goal.** 新建 `~/.claude/projects/-Users-fengzhao-multica/memory/feedback_zh_guardrails.md`（type=feedback），与 `feedback_git_guardrails.md` 同型；并把单行索引挂到 `MEMORY.md`。
- **Requirements.** R6 (memory 块).
- **Dependencies.** U1（先有 CLAUDE.md 主体；memory description 引用同一规则）。
- **Files.**
  - `~/.claude/projects/-Users-fengzhao-multica/memory/feedback_zh_guardrails.md` (新)
  - `~/.claude/projects/-Users-fengzhao-multica/memory/MEMORY.md` (改)
- **Approach.**
  - 写新 memory 文件 frontmatter：`name: feedback-zh-guardrails`, `description: 中文输出护栏 + 豁免清单，主规则同 multica/CLAUDE.md ## 用户偏好节；如调用者为 multica self-host 拥有者且在 CLAUDE.md-anchored workflow 中，遵循此偏好 (中文默认 / PR 英文 / 豁免项照原文)`. 这一行 **中文摘要** 是 entry-level 摘要；§R6 中英对照的英文 long-prompt 不进 frontmatter.description（不是这样定位入口），而是放进 body。`metadata: type: feedback, node_type: memory`.
  - body 写：(1) 与 CLAUDE.md 一致的 R1–R4 简述；(2) R5a 60% 裁决；(3) 给 sub-agent 的显式指令："Treat user-facing reply language as Simplified Chinese for the multica self-host owner. Exempt: commit type/scope, file paths, API field names, command names, CLI/REPL output verbatim, code blocks, YAML frontmatter keys, plan H1 title.";
  - 在 `MEMORY.md` 索引加一行：`- [CE 中文护栏](feedback_zh_guardrails.md) — 多模语言护栏；ce-compound 显式 forward memory，主 agent / 第三方读仓库进程走 CLAUDE.md；与 feedback_git_guardrails 同档。`
- **Test scenarios.**
  - 文件能 yaml.safe_load 解析 frontmatter。
  - frontmatter 含 `metadata.type: feedback`。
  - `MEMORY.md` 包含 `feedback_zh_guardrails` 字符串。
- **Verification.**
  - `python3 -c "import yaml,sys;d=yaml.safe_load(open(sys.argv[1]).read().split('---',2)[1]);assert d['metadata']['type']=='feedback';assert '中文' in d['description'];assert 'feedback' in sys.argv[1]" ~/.claude/projects/-Users-fengzhao-multica/memory/feedback_zh_guardrails.md` 退出码 0。
  - `grep -F 'feedback_zh_guardrails' MEMORY.md` 退出码 0。

### U3. docs/solutions 留档

- **Goal.** 新建 `multica/docs/solutions/workflow-issues/2026-07-28-002-ce-zh-language-guardrail-solution.md`，包含本次根因、为何双层、为何不动 CE、不写 config、上游 CE 升级时怎么评估、与同型先例（`feedback_git_guardrails.md` / `feedback_plugin_lock_local.md` / `project_local_customization_workflow.md` / `project_daemon_upgrade.md`）的关系；末尾预留 `## Arrival matrix YYYY-MM-DD` 节供 R7 写入。
- **Requirements.** R6 (docs/solutions 块), R7.
- **Dependencies.** U1 + U2（先有最终主体规则文本与 memory 路径）。
- **Files.** `docs/solutions/workflow-issues/2026-07-28-002-ce-zh-language-guardrail-solution.md` (新)。
- **Approach.**
  - frontmatter（值遵循同目录既有约定 —`module` 子领域标识符，与既有 `comments` / `database/migrations` / `git` / `self-host-operations` 同档；`problem_type` enum 仅在 `workflow_issue` / `best_practice` 中选）：
    - `module: ce-tooling`
    - `tags: [ce, language, guardrail, conventions]`
    - `problem_type: workflow_issue`
  - body ≤ 100 行（与 `install-sh-upgrade-reload-defects.md` 同型），覆盖：(1) 背景与根因；(2) 双层 / 三承载点设计；（3）三 alternative（fork / config schema / wrapper）显式不取的 rationale；（4）R6 覆盖域表；（5）KTD9 事件驱动复核触发器；（6）下游 CE 升级时的评估动作清单；（7）与同型先例的关系。
  - 文件名编号选 `002`（不选 `001`）以避开同日 plan `2026-07-28-001-feat-cli-version-help-menu-plan.md`（同日 plan/solution 同号互不冲突）。
  - 末尾预留 `## Arrival matrix YYYY-MM-DD` 节：3 行示例 + 字段说明（日期、代表 skill 集合、(i) 看到护栏?、(ii) 产出语言?、结论）。首次 R7 跑后追加正式行。
- **Test scenarios.**
  - frontmatter 可 yaml.safe_load。
  - 文件总行数 ≤ 120（含预留节）。
  - grep `compound-engineering\|memory` 命中正文 ≥ 2 处。
  - `Arrival matrix` 关键字命中至少 1 处。
- **Verification.**
  - `python3 -c "import yaml,sys;d=yaml.safe_load(open(sys.argv[1]).read().split('---',2)[1]);assert d['module']=='ce-tooling';assert 'ce' in d['tags'];assert d['problem_type']=='workflow_issue'" docs/solutions/workflow-issues/2026-07-28-002-ce-zh-language-guardrail-solution.md` 退出码 0。
  - `wc -l docs/solutions/workflow-issues/2026-07-28-002-ce-zh-language-guardrail-solution.md` ≤ 120。
  - `grep -c 'Arrival matrix' docs/solutions/workflow-issues/2026-07-28-002-ce-zh-language-guardrail-solution.md` ≥ 1。

### U4. 受控手工验收矩阵（R7）

- **Goal.** U1/U2/U3 落地后，**headless sub-agent 跑 ce-brainstorm / ce-plan / ce-code-review / ce-simplify-code 各一次代表调用**，记录 (i) prompt 是否含护栏 / (ii) 产出语言；写 4 行到 solution 的 Arrival matrix 节。
- **Requirements.** R7.
- **Dependencies.** U1, U2, U3 (本 U4 才跑).
- **Files.** `docs/solutions/workflow-issues/2026-07-28-002-ce-zh-language-guardrail-solution.md` (追加 `## Arrival matrix 2026-MM-DD` 节).
- **Approach.**
  - 通过 `bash claude -p "/<skill-name> <sub-prompt>"` 形式 shell-out 4 次（用 `/skill-name` 形式触发 CE 技能；`claude -p` 默认保留 auto-memory forward；**禁止**加 `--bare`，否则 CLAUDE.md + memory 都不注入）。
  - 每次记录：(i) sub-agent prompt 注入里是否显式包含 CLAUDE.md 节选 / feedback_zh_guardrails 节选 + (ii) 最终产出语言；写一行 markdown table。
  - ce-compound 不进 4 行矩阵，单列说明："已显式 forward memory to Context Analyzer + Solution Extractor (SKILL.md:103-118)，memory-only 验证"——这是 KTD1 双层冗余在 ce-compound 上唯一一条真实生效层。
  - 失败信号：(i) 否 + (ii) 英文 → 触发 KTD9 评估（不阻塞 commit；建议用户在 PR 描述里提示未来升级时再讨论）。
- **Test scenarios.**
  - 4 行表格写入 Arrival matrix。
  - 每行 (i) / (ii) 字段非空。
  - 表格前 1-2 行解释观察项定义。
- **Verification.**
  - `grep -A 10 'Arrival matrix' docs/solutions/workflow-issues/2026-07-28-002-ce-zh-language-guardrail-solution.md | grep -c '^|'` ≥ 4 (markdown table 数据行)。
  - 若任一行 (i) 否 + (ii) 英文，输出 warning 到 PR 描述并在 solution 末尾加 `## Known gaps` 节说明（不阻塞 DoD）。

---

## Verification Contract

总体验证分四块；U1–U4 的 Verification 字段落在每 U 节内，本节是跨 U 的整体合规门 + R5/R7 的尾门。

- **V1. CLAUDE.md 完整保真（U1）。**
  - `grep -F '**语言要求**' CLAUDE.md` 退出码 0（原句首行没动）。
  - `grep -c '60%' CLAUDE.md` 输出 ≥ 2（R5a 在主规则段与判定阈值段各出现 1 次，正常 R5a 段落应至少命中 2 次）。
  - `git diff CLAUDE.md` 不超 60 行新增。

- **V2. memory 文件与索引挂载（U2）。**
  - `python3 -c "import yaml,sys;d=yaml.safe_load(open(sys.argv[1]).read().split('---',2)[1]);assert d['metadata']['type']=='feedback'" ~/.claude/projects/-Users-fengzhao-multica/memory/feedback_zh_guardrails.md` 退出码 0。
  - `grep -F 'feedback_zh_guardrails' ~/.claude/projects/-Users-fengzhao-multica/memory/MEMORY.md` 退出码 0。

- **V3. docs/solutions 文件与 frontmatter 合规（U3）。**
  - frontmatter yaml.safe_load 通过、`tags` 含 `ce`、`problem_type: workflow-coordination`。
  - `wc -l` ≤ 120。

- **V4. 受控手工验收矩阵有真实 4 行（U4）。**
  - `grep -A 10 'Arrival matrix'` 后 table 行数 ≥ 4。
  - 每行 (i)/(ii) 非空。

- **V5. 跨文件一致性（DoD 前最后一道）。**
  - CLAUDE.md 中关于豁免类的具体例子与 R4 列表至少 5 项重合。
  - solution 中 R6 覆盖域表与本 plan 中 R6 覆盖域表列名一致。
  - memory description 引用 CLAUDE.md 的位置文字与实际文件路径一致。

- **V6. 非破坏性（兜底）。**
  - `git status` 显示仅 `CLAUDE.md` / `docs/solutions/...` / `docs/plans/2026-07-28-002-*.md` 与 memory 文件在修改列表；不波及无关文件。
  - 一份 commit 同时包含 U1/U2/U3（按 Implementation Sequencing）；U4 可单独 commit。

所有 V1–V6 一次跑失败则 DoD 不交付，回到对应 U 修改并重跑验证。

---

## Definition of Done

- 全局：
  1. V1–V5 全部退出码 0、输出与预期一致。
  2. `git status` 干净或仅本 plan 修改项。
  3. `make check` 不需要跑——本次无代码改动，但若用户想跑，应仍然通过（CLAUDE.md 改动对 docs/solutions/conventions 不交叉影响）。
  4. 临时草稿 `/tmp/compound-engineering-501/` 已被清理（落地后即可，安全删）。
- U1：
  - V1 通过 + git diff 无误删原句。
- U2：
  - V2 通过 + MEMORY.md 索引行不破版式。
- U3：
  - V3 通过 + 文件名编号无冲突（与 `2026-07-28-002-*.md` 同号 solution 不与同日 plan `001` 冲突）。
- U4：
  - V4 通过 + Arrival matrix 4 行真实观察项被记录。

废弃/试错的 U（如某次失败 sub-agent 调用）应在 commit 前清理，避免 dead-end 代码进入 diff。本 plan 是 doc-only，废弃风险只剩 scratch 路径 `/tmp/compound-engineering-501/`。

---

## Outstanding Questions

（已无悬而未决的产品决策——KTD1–KTD10 在对话中已 session-settled 并锁定。）
