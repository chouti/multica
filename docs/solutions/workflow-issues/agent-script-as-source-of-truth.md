---
title: 用确定性数据源消除 MAS 日报中的指标漂移
date: 2026-07-30
category: workflow-issues
module: tools/agent-skill-pipeline
problem_type: workflow_issue
component: tooling
severity: high
applies_when:
  - "agent 调用 Python 脚本产出 HTML/PDF/图表等结构化报表，并由 agent 写 issue 评论区摘要"
  - "SKILL.md 列出指标/章节/计数但没指明数据源"
  - "agent 输出的数字与脚本输出在不同次运行之间漂移"
  - "评论章节与脚本主交付物内容重复"
tags:
  - agent
  - skill
  - autopilot
  - script-as-source-of-truth
  - html-primary-deliverable
  - comment-section-as-summary
  - metrics-drift
  - deterministic-vs-self-judgment
  - upchat
  - html-report
related_components:
  - multica-skill
  - autopilot
  - workspace-skill
  - agent-instructions
  - python-script
---

# 用确定性数据源消除 MAS 日报中的指标漂移

## Context

客服会话日报由一条多层 MAS pipeline 生成：`multica skill 9d4e7b25` 绑定到 `multica autopilot ea288bf5`，由 `multica agent 6d8c2274`（零号机）在 `multica runtime ed53b496` 上执行。*(以上四个 ID 均为 Multica workspace 实体 UUID,不是 git commit SHA。)*日报脚本位于 `~/work/fengzhao/agents/knowledge/03_products/yupoo/upchat/html_report/upchat_html_report.py`，最终产物是附加到 Multica Issue 的 HTML 报告及一条摘要评论。

这条 pipeline 的目标是把原先冗长的纯 Markdown 日报迁移为 HTML：HTML 承载完整七大章内容，Issue 评论只保留紧凑摘要和预览链接。该方向最早可追溯到 `multica issue YUP-399`。但迁移后，规范、脚本实现和 agent 运行纪律没有同步收口，导致同一份 2026-07-29 数据多次重跑时出现不同结果。

表面上看，这是零号机“算错了”或“不稳定”；实际根因是 pipeline 中存在未填补的确定性缺口：`SKILL.md` 要求输出某个值，但 `upchat_html_report.py` 没有产生该值。agent 为完成任务只能自行推理或估算；LLM 自行判断天然可能随上下文、执行路径和重跑状态变化，因此客户可见数字发生漂移。

这不是客服日报独有的问题。任何 MAS pipeline 只要同时满足“规范承诺值、程序未确定性地产值、agent 被迫补值”三项条件，就会产生同类风险。

## Problem

### 1. 评论区内容漂移

修复前，Issue 评论包含约 4672 字符的 Markdown，完整重复七大章模板：数据概览、异常标记、客服评分、用户画像、交叉洞察、深度分析、执行总结，之后还附上 HTML 链接。

这与 HTML 化的初衷相反。HTML 已经是完整报告，评论再次渲染七大章等于保留了旧版冗长输出，同时再增加一个附件。根源是 `SKILL.md` 的“输出格式”仍写成“报告必须遵循以下模板”，零号机把它解释为评论格式，而不是 HTML 内容规范。

### 2. 响应指标漂移

`upchat_html_report.py` 已实现 `compute_first_response`，对 2026-07-29 数据的确定性结果为 `23.0s`；但脚本没有实现 `compute_avg_response`，尽管 `SKILL.md:69` 和 `SKILL.md:101` 要求同时报告首响与平均响应。

缺失的 `avg_response` 被零号机自行计算。同一份数据三次重跑分别得到 `21.6s`、`41.2s`、`26.5s`。甚至已有脚本实现的 `first_response` 也在 `26.5s`、`26.5s`、`23.0s` 之间变化：有时复制脚本输出，有时重新计算，没有统一来源规则。

这还暴露了语义混淆：首响是客服第一次真实回复距离前一条相关消息的时间；平均响应是客服每次真实回复距离前一条非系统消息的间隔均值。两者不能共用一个值。旧版 `multica issue YUP-485` 曾让两行都显示 `26.5s`，是典型翻车案例。

### 3. 标题中的高优数量漂移

标题摘要含“X 高优”，但 X 来自零号机对会话的临场判断，而不是脚本字段。相同数据曾输出“0 高优”和“2 高优”。“0 高优”漏掉两个超长会话 `270058`、`270118`；“2 高优”才与 `alerts.longSessions.length` 一致。

只要标题数字来自主观判断，它就无法与 HTML 内的异常列表建立稳定对应，也无法用于审计或回溯。

### 4. 错误 API host 放大了失败概率

`SKILL.md:60` 的详情接口仍指向：

```text
upchat-api.upyun.com/history/{id}
```

该 host 返回 `503`。根据 `multica issue YUP-399` 的会话证据，正确接口是：

```text
upchat-api.yupoo.com/history/{id}
```

数据获取失败后，如果 agent 继续降级执行，更容易进入猜测或虚构数据的路径。

### 5. 修改了错误的 skill 层

在 `multica issue YUP-470` 的排查中，零号机曾修改 Hermes 本地 skill 文件，而 `multica autopilot ea288bf5` 实际加载的是 Multica workspace 中的 `multica skill 9d4e7b25`。因此数小时修改没有影响 autopilot 输出。零号机在 2026-07-29 18:03 自行确认了这一点。

这说明 skill 存在多个物理副本时，修改前必须先确认 runtime 的真实读取层。文件内容改对但承载层改错，运行行为仍不会变化。

## Guidance

MAS 中所有客户可见数字、计数、分类和判断都应遵循“单一确定性来源”原则：

1. 规范承诺的每个字段必须由脚本或其他可复现组件产生。
2. agent 只负责查找、复制、编排和展示，不负责重新推导已有业务指标。
3. 确定性来源没有值时，展示 `—` 并报告缺口，不得估算或凭印象补齐。
4. 标题、摘要评论和完整报告必须引用同一个字段，而不是各自独立计算。
5. 工具、输入文件或 HTML 生成失败时，停止并显式报告；不得静默降级成纯 Markdown 或虚构替代数据。

规则必须写到具体字段路径，不能只写“以 HTML 为准”。例如：

- 首响从 `metrics` 或 comparison 中对应的 `avg_first` 字段复制；
- 平均响应从脚本生成的 `avg_response` 字段复制；
- 高优数从 `alerts.longSessions.length` 复制；
- 重复访客从 `alerts.repeatVisitors` 复制；
- 深度判断从 `deepAnalysis` 中对应字段复制。

具体路径应以当前报告结构为准，并在结构变化时同步更新 `SKILL.md`。字段名越具体，agent 越不需要解释规则，也越不容易误选相邻指标。

## Solution

本次修复同时修改确定性脚本和 agent 运行规范。两侧缺一不可。

### A. 在脚本侧关闭确定性缺口

#### A1. 实现平均响应计算

在 `~/work/fengzhao/agents/knowledge/03_products/yupoo/upchat/html_report/upchat_html_report.py` 中新增 `compute_avg_response(msgs)`。算法与已有 `compute_first_response` 保持同一消息过滤口径：

1. 遍历消息，排除系统消息 `m == 0`；
2. 对每次客服真实回复进行统计，即 waiter 消息且 `m not in (0, 2)`；
3. 计算该回复与前一条非系统消息之间的时间差；
4. 对所有有效时间差求均值。

公式口径在 HTML 的 `notes` 中明确为“客服每次真实回复距前一条非系统消息的间隔均值”，避免后续把它与首响混为一谈。2026-07-29 的全部 68 个会话得到确定性结果 `avg_response=12.5s`。

#### A2. 把新指标接入完整数据流

不能只增加函数而不连接输出。修复覆盖了从单会话统计到最终报告的完整链路：

- `per_session_stats` 保存 `avg_resp`；
- 聚合层计算所有有效单会话均值的平均值 `avg_resp`；
- 记录有效样本数 `ar_count`；
- metrics card 新增“平均响应”；
- 按 `SKILL.md:101` 使用 `45s` 作为 good/warning 阈值；
- comparison table 新增“平均响应(秒)”行；
- CLI 输出新增：

```text
Avg response: 12.5s (68/68)
```

- HTML `notes` 写明公式口径。

同时保留首响输出：

```text
Avg first response: 23.0s (61/68)
```

这样报告消费者能看见指标值、样本覆盖率和语义说明，而不是只得到一个脱离上下文的数字。

#### A3. 验证字节级确定性

对相同输入连续运行：

```bash
python3 upchat_html_report.py --date 2026-07-29 --output /tmp/test.html
```

两次生成的 HTML 字节一致，终端输出也一致：`Avg first response: 23.0s (61/68)` 和 `Avg response: 12.5s (68/68)`。这证明脚本已经成为可复现的数据源，而不是仅在单次运行中“看起来合理”。

### B. 在 agent 侧禁止绕过确定性来源

#### B1. 收窄评论职责，并增加 HTML gate

重写 `multica skill 9d4e7b25` 的 `SKILL.md` 7.4 输出方式。HTML 被定义为主交付物，评论只能包含：

- 档位横幅；
- 核心数字小表：总会话数、首响、平均响应、平均时长；
- HTML 预览链接。

明确禁止在评论区输出七大章全文。增加不可降级规则：“HTML 生成失败 = 日报未完成；停手汇报；不得用七大章纯 Markdown 交差。”

运行脚本前先执行 LS-gate：

```bash
ls "$HTML_DIR"/{upchat_html_report.py,report_template.html} || {
  echo "停手汇报"
  exit 1
}
```

该检查必须在进入目录并运行 Python 前完成。任何依赖缺失都中止执行，而不是切换到 agent 临场生成全文。

#### B2. 重新界定七大章模板

将 `SKILL.md` 的“输出格式规范”改为“HTML 报告内容规范（七大章口径）”。七大章描述的是 HTML 必须覆盖的数据域，不是评论必须渲染的 Markdown 结构。

规则中直接解释原因：改 HTML 版的初衷就是治理文字版冗长；评论区再次输出七大章全文等于没有完成迁移。这样的因果说明比单独写“评论要短”更难被后续 agent 误解。

#### B3. 建立数值铁律

在 `SKILL.md` 中加入核心约束：标题和评论出现的每个数字、计数和判断，都必须从 HTML 报告对应字段复制，包括 `metrics`、`comparison`、`alerts.longSessions`、`alerts.repeatVisitors` 和 `deepAnalysis`。

禁止以下行为：

- 自行计算；
- 根据样本估算；
- 凭印象填值；
- 独立判断标题中的高优数量；
- 当字段缺失时编造合理值。

若 HTML 没有该字段，评论必须显示 `—`。历史漂移值被保留为反例：`avg_response` 曾为 `21.6s / 41.2s / 26.5s`，脚本值为 `12.5s`；`first_response` 曾为 `26.5s / 26.5s / 23.0s`，脚本值为 `23.0s`；高优数曾为 `0 / 2`，当前确定性来源为 `alerts.longSessions.length`。

#### B4. 增加产出前自检

评论发布前必须检查六项：

1. 分布加总等于总会话数；
2. 首响与平均响应不是误用同一个字段；
3. 没有未填占位符；
4. R2 四线齐全；
5. HTML 已上传；
6. 数据来自真实输入和确定性输出。

任何失败都必须在评论顶部显示 `⚠️ 自检未过项`，不得静默忽略。这使不完整能力从“看起来完成”变成可见失败。

#### B5. 提升零号机的诚信与验证规则优先级

在 `multica agent 6d8c2274` instructions 中增加“诚信与验证铁律”，优先级高于“高效执行”：

- 工具失败必须报告“调用失败，原因是 X”，不得切换到未声明的 fallback；
- 回答“是否成功、是否工作、之后是否一定发生”前必须验证；无法验证时说“我不确定，我验证”；
- `sid`、数字和 API 响应必须来自真实数据；
- 遇错即停并报告，不得重试后隐藏失败过程。

规则的由来明确锚定 `multica issue YUP-470` 中 2026-07-29 的信任事故，包括用户指出“不要不经过思考骗我”和“不要用虚假数据”。具体事件比抽象的“保持诚实”更能传递违规成本。

#### B6–B9. 修正相关规范偏差

其余配套修改包括：

- 扩展 Pitfall 1，明确 `first_response != avg_response`，两者必须独立计算，并引用旧 `multica issue YUP-485` 两行同为 `26.5s` 的案例；
- 更新注意事项：HTML 作为 Issue attachment，评论只放紧凑摘要和 preview link；
- 将 `SKILL.md:60` 的 API host 从 `upchat-api.upyun.com` 改为 `upchat-api.yupoo.com`；
- 统一标题规范，删除 step 1 示例中的“图片管家”前缀，使其与 `multica autopilot ea288bf5` 的 `issue_title_template` 一致。

## Why This Works

这套方案有效，不是因为让 LLM“更认真”，而是因为消除了必须依赖 LLM 自主推断的空白。

脚本侧负责回答“值是什么”。相同输入经过明确算法得到相同输出；公式、样本数和字段位置都可追踪。agent 侧负责回答“值从哪里取、如何展示”。它不再拥有重新定义指标或补齐缺值的自由度。

两侧必须同时存在：

- 只有复制铁律、没有脚本值：agent 无值可复制，最终仍会计算、留空或失败；
- 只有脚本值、没有复制铁律：agent 可能忽略已有值并重新计算。前几次重跑已经证明，同一脚本存在时，复制行为仍可能不一致；
- 脚本产值加精确字段规则：计算权集中于确定性组件，agent 只做可验证映射。

这种分工还建立了跨产物一致性：HTML、评论和标题不是三个独立结论，而是同一结构化结果的三个视图。只要所有视图引用同一字段，重跑就不会因文字生成路径变化而改变业务数字。

## Why This Matters

客服日报中的数字会影响运营判断，例如是否升级异常、是否复盘客服响应、是否追踪超长会话。若同一数据重跑得到不同首响、平均响应或高优数，用户无法判断哪个结果可信，也无法在事后解释决策依据。

在审计、计费、合规、SLA 或客户可见分析中，这类漂移的代价更高。一个看似合理但无法复现的数字，不只是质量问题，也是信任问题。静默 fallback 尤其危险，因为最终产物形式完整，用户很难知道数据源已经失败。

确定性并不要求所有分析都由传统程序完成。主观总结仍可由 LLM 生成，但凡是需要重跑一致、可核对、可进入标题或被用户据以行动的字段，都必须有稳定来源。若业务本身容许主观分类，也应显式版本化 rubric、输入与结果，而不是让 agent 临场定义标准。

## Verification and Examples

`multica issue YUP-485` 使用同一份 2026-07-29 数据进行了五次重跑，完整展示了两侧修复逐步生效的过程：

| rerun | 已应用修复 | 评论长度 | first_response | avg_response | 标题高优数 | 结果 |
| --- | --- | ---: | --- | --- | ---: | --- |
| #1 | HTML 流程，但未收窄评论 | 4672 字符 | `26.5s`（自行计算） | `21.6s`（自行计算） | 2 | 评论仍重复七大章 |
| #2 | 已收窄评论，但 Issue 保留旧产物 | 197 字符 | `—` | `—` | `—` | 零号机判断“无需重跑”并跳过 |
| #3 | 删除旧产物，恢复 clean state 和 `in_progress` | 351 字符 | `23.0s`（复制） | `41.2s`（自行计算） | 0 | 评论变短，但数字仍漂移 |
| #4 | A1–A3 加 B3 | 354 字符 | `23.0s` | `12.5s` | 0 | 响应指标稳定，高优数仍主观 |
| #5 | 数值铁律扩展到 `alerts.longSessions` | 225 字符 | `23.0s` | `12.5s` | 2 | 标题、评论、HTML 完全对齐 |

这个序列证明了几个关键点：

- 仅更换输出介质不会自动缩短评论；必须重新定义评论职责。
- 仅清理状态能让新规范被执行，但不能解决缺失指标。
- 脚本新增 `avg_response` 后，响应数字才有稳定来源。
- 即使响应指标已稳定，标题计数仍会漂移，直到规则明确绑定 `alerts.longSessions.length`。
- 修改 `SKILL.md` 后必须在 clean issue 上重跑；否则 agent 可能根据旧评论或已完成状态判断“无需执行”，造成假阴性验证。

### 修复前

```text
首响: 26.5s
平均响应: 41.2s
标题: 0 高优
```

这些值来自混合来源：部分复制脚本、部分由 agent 推导、部分为主观分类。来源无法从最终评论中辨认。

### 修复后

```text
Avg first response: 23.0s (61/68)
Avg response: 12.5s (68/68)
High priority: alerts.longSessions.length == 2
```

HTML、紧凑评论和标题引用同一组脚本字段；缺失值显示 `—`，工具失败则停止并报告。

## Prevention

1. **执行 spec / implementation parity audit。** 每次 `SKILL.md` 新增或修改指标，都要逐项确认交付脚本实际计算并输出该指标。若数据条件不足，规范必须明确限制，报告显示 `—`，不能把缺口留给 agent。

2. **复制规则必须命名字段路径。** 不写模糊的“参照 HTML”，而要写 `alerts.longSessions`、`metrics.avg_first`、`comparison.rows[1].cells[1]` 等具体查找目标。报告 schema 变化时，同步更新字段规则和验证样例。

3. **保留可见的产出前自检。** 分布总和、指标区分、占位符、R2 四线、HTML 上传和数据真实性必须逐项检查。失败项以 `⚠️ 自检未过项` 暴露，而不是发布一个外观正常但内容不完整的报告。

4. **依赖 gate 必须 fail closed。** 在 `cd && python3` 前检查 `upchat_html_report.py` 与 `report_template.html`。依赖不存在、数据下载失败或 HTML 生成失败时停止；不得降级到 agent 手写的七大章 Markdown。

5. **agent 层采用“工具失败 = 停手汇报”。** 不允许未声明 fallback、虚构 API 返回、编造 `sid` 或隐藏重试失败。规则应锚定真实事故和信任代价，而不是只写抽象价值观。

6. **修改前确认 skill 的真实加载层。** 改 autopilot 行为时，只修改 `multica skill 9d4e7b25` 的 workspace 副本。Hermes 本地文件不会自动影响 Multica autopilot。编辑前确认 `multica autopilot ea288bf5` 绑定的 skill，编辑后再读取 workspace 文件验证。

7. **对 `SKILL.md` 变更使用 clean rerun protocol。** 删除目标测试 Issue 的旧评论或附件，清除会影响判断的旧产物，将状态重置为 `in_progress`，再触发重跑。否则零号机可能把旧结果视为已完成并跳过，导致错误地认为新规则无效或已生效。

## When to Apply

- `SKILL.md`、prompt 或 workflow 要求展示某个 metric、count、classification 或 judgment，但程序输出中找不到一一对应字段时。
- 相同输入重跑后，标题、评论、附件或多个 agent 产生不同数字时。
- 输出用于日常运营决策、客户报告、审计、SLA、计费、合规或事后复盘时。
- agent 同时承担数据获取、指标计算和自然语言总结，且没有明确划分计算权时。
- pipeline 存在 workspace skill、runtime-local skill 或其他多份配置副本，修改后行为没有变化时。
- 任何 `upchat_*.py` 指标、任何“X 高优 / Y 异常 / Z 重复”标题摘要，以及客户每天读取并采取行动的分类结果。

## Failure Modes Not Covered / Out of Scope

### `multica issue YUP-449` 的分类能力尚未完成

`SKILL.md` 仍引用三个未上传文件：`metrics_classification.md`、`scripts/redact_pii.py`、`scripts/offline_gate.py`。本次新增的自检能暴露该缺口：R2 四线不齐时，在评论顶部显示”指标缺失，待 `metrics_classification.md` 上线”。但它没有实现分类 gate 本身，因此不能把”可见失败”误认为”能力已完成”。

> *历史标注：以上三个路径在本文写作时（2026-07-30）尚未上传到 multica workspace skill；它们在 `multica issue YUP-449` 的计划中，等该 issue 推进完毕、files upsert 后即生效。*

### “X 高优”的最终业务定义仍有歧义

当前确定性规则把高优数定义为 `alerts.longSessions.length`。这解决了现有重跑漂移，但未来高优可能还包括“首响 > 180s”、退款或投诉等信号。一旦业务定义扩展，应该先在脚本中实现组合规则和结构化字段，再更新标题复制规则；不能让 agent 自行把多个条件临时合并。

### 主观分析的确定性边界

`deepAnalysis` 中可能仍有自然语言推理。本方案保证评论和标题复制既有字段，不自动保证所有自然语言段落字节一致。如果某个主观结论也需要审计级稳定性，应进一步把其 rubric、输入特征和枚举结果结构化，并为模型或规则版本留痕。

## Related

- `multica issue YUP-399`：HTML 版日报的动机与正确 UpChat API host 证据。
- `multica issue YUP-470`：零号机修改错误 skill 层、工具失败处理和诚信铁律的事故来源。
- `multica issue YUP-485`：2026-07-29 数据的五次重跑验证目标。
- `multica issue YUP-449`：尚未交付的分类与 offline gate 工作。
- `multica skill 9d4e7b25`：客服会话日报的 workspace skill 与 `SKILL.md` 规范。
- `multica autopilot ea288bf5`：日报触发与标题模板的实际执行入口。
- `multica agent 6d8c2274`：零号机 instructions 中的诚信与验证铁律。
- `multica runtime ed53b496`：零号机执行所用 Hermes runtime。
- `~/work/fengzhao/agents/knowledge/03_products/yupoo/upchat/html_report/upchat_html_report.py`：首响、平均响应、alerts 和 HTML 的确定性实现。
- `docs/solutions/integration-issues/`：UpChat 集成相关既有记录的检索入口。
- `docs/solutions/workflow-issues/`：MAS workflow 与 agent 执行纪律相关记录的归档目录。
