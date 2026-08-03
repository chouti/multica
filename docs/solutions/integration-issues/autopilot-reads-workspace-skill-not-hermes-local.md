---
title: Multica autopilot reads skills from the workspace layer, not from the Hermes local skill copy
date: 2026-07-30
category: integration-issues
module: agents-skills
problem_type: integration_issue
component: tooling
severity: high
symptoms:
  - "Autopilot continues using the old SKILL.md content despite Hermes local skill files being edited"
  - "multica skill get <id> returns the unchanged workspace copy after the agent believes it has edited the skill"
  - "Agent repeatedly reports the change as 已修复 or 已落地 but no behavioral change reaches autopilot"
  - "Hours spent iterating on Hermes local skill files before the wrong-layer mistake is identified"
root_cause: incomplete_setup
resolution_type: documentation_update
tags:
  - multica
  - autopilot
  - skill
  - workspace-layer
  - hermes-local
  - runtime-layer
  - edit-vs-read
  - verification-gap
related_components:
  - assistant
---

---
title: autopilot 修改未生效：Hermes 本地 skill 与 Multica workspace skill 层级漂移
date: 2026-07-30
category: integration-issues
module: tools/agent-skill-pipeline
problem_type: integration_issue
component: tooling
symptoms:
  - agent 在 Hermes 本地反复修改 skill 并报告已修复，但 autopilot 输出保持不变
  - 本地文件的时间、大小和 diff 都能证明修改成功，workspace skill 的 updated_at 与内容却没有变化
  - 只有用户追问实际修改了哪个 skill 后，agent 才发现 autopilot 仍在读取旧的 workspace 副本
root_cause: incomplete_setup
resolution_type: workflow_improvement
severity: high
tags:
  - multica
  - autopilot
  - workspace-skill
  - hermes
  - runtime-layer
  - source-of-truth
  - deployment-verification
  - upchat
related_components:
  - assistant
  - multica-cli
  - autopilot
  - workspace-skill
  - hermes-runtime
---

# autopilot 修改未生效：Hermes 本地 skill 与 Multica workspace skill 层级漂移

本文涉及 `multica skill 9d4e7b25`、`multica autopilot ea288bf5`、`multica agent 6d8c2274` 与 `multica runtime ed53b496`；以及 `multica skill 5edd774d`（用户 mention 引用的 multica skill ID）。以上均为 Multica workspace 实体 ID，不是 git commit SHA。本文归档路径为 `docs/solutions/integration-issues/autopilot-reads-workspace-skill-not-hermes-local.md`。

## Problem

Multica autopilot 执行时加载的是 workspace 层的 skill；`multica skill get <id>` 读取的也是这份 workspace 副本。Hermes runtime 则允许 agent 在本机拥有自己的 skill 目录。两个位置都可能出现同名、同用途、甚至初始内容相同的 `SKILL.md`、脚本与模板，但它们不是同一份可执行配置，也没有自动同步关系。

在 `multica issue YUP-470` 中，零号机 `multica agent 6d8c2274` 运行于类型为 `hermes`、名称为 `Hermes (fzmini.local)` 的 `multica runtime ed53b496`。客服会话日报由 `multica autopilot ea288bf5` 触发，实际依赖 workspace 中的 `multica skill 9d4e7b25`。零号机却持续修改 Hermes 本地 skill 以及 `~/work/.../upchat_html_report.py`、`report_template.html`。这些本地修改真实存在，但 autopilot 根本不会从那些路径加载 skill，所以对下一次 autopilot 输出的影响为零。

问题不是某次编辑失败，而是缺少把“修改 skill”与“确认 autopilot 的权威读取层”绑定起来的操作协议。文件系统命令只能证明本地文件写入成功，不能证明 workspace skill 已更新；如果没有在编辑前后读取 workspace 副本，agent 很容易把“本地改完”误报成“系统已落地”。

## Symptoms

- 零号机多次声称“已修复”“已落地”“已重生成 HTML 报告”或“重新上传 HTML 报告(附件)”，但 autopilot 输出仍表现为 06-14 旧版 skill 的行为。
- `ls`、文件大小与本地 `diff` 全部显示修改成功，因此每轮都产生新的错误信心；这些检查只覆盖 Hermes 本地层，没有覆盖 workspace 层。
- 同一脚本被重复修改和上传，输出问题却没有稳定变化，因为真正决定 autopilot 行为的 `multica skill 9d4e7b25` 没有更新。
- agent 没有主动执行 `multica skill get` 核对权威副本，而是在用户明确追问“为什么是 Hermes 的 skill?”之后才检查层级。
- YUP-470 整个调试记录包含 28 个相关回合；其中从首次承认修复没有落地，到最终识别 workspace/local 分层的关键时段，又出现了多轮“已经修好”的声明。一个 workspace 读取动作本可在最初一轮暴露问题。

### YUP-470 的实际时间线

| 时间 | 事件 | workspace 层状态 |
| --- | --- | --- |
| 2026-07-29 17:04 | 抽屉询问为什么没有 HTML | `multica skill 9d4e7b25` 仍是 06-14 旧内容 |
| 17:05 | 零号机解释为“不需要 HTML hosting”的设计选择 | 未读取 workspace skill |
| 17:08 | 抽屉用 `multica issue YUP-399` 反驳，指出既有需求明确要求 HTML | 未变化 |
| 17:10 | 零号机承认 patch 没落到“实际 skill 文件”，但随后修的是 Hermes 本地副本 | 未变化 |
| 17:14 | 抽屉指出附件只有模板、没有加载数据 | 未变化 |
| 17:16 | 零号机再次归因为 skill 中脚本是有 bug 的自写版本，继续修 Hermes 本地文件 | 未变化 |
| 17:30–17:52 | 多轮报告“已修复”“重新生成”“重新上传”，本地文件确实变化 | 未变化 |
| 18:02 | 抽屉直接追问：“为什么是 `Hermes` 的 skill? 使用 [@multica](mention://skill/5edd774d-b338-4a09-86af-bcc3dcc4d84e) skill 查看一下当前 workspace 又没有这个客服会话的日报skill，如果有那就修改优化这个 skill” | 迫使排查权威层 |
| 18:03 | 零号机执行 workspace 检查并确认：“之前我一直在改 Hermes 本地 skill，但 autopilot 运行时载入的是 Multica workspace 中的 skill……内容还是 06-14 的旧版” | 首次确认 stale |
| 18:03 | 零号机使用 `multica skill files upsert` 把文件写入 workspace skill | workspace 更新 |

这段时间线的关键不是“最后终于找到一个旧文件”，而是 17:04 到 18:03 之间所有本地成功证据都无法回答唯一重要的问题：autopilot 下一次会读取什么内容。

## What Didn't Work

1. **只编辑 Hermes 本地 skill。** 本地副本可以作为开发素材或 agent 自用资源，但它不是 Multica autopilot 的部署目标。内容再正确，也不会自动改变 workspace skill。

2. **重复上传同一脚本或报告。** `upchat_html_report.py` 与 `report_template.html` 的代码问题可以被真实修复，然而只要修复没有通过 workspace skill 接口落地，重复执行只是在错误层上增加更多版本。

3. **用 `ls`、文件大小或本地 `diff` 作为上线证明。** 这些检查证明“写入了某个路径”，不证明“写入了 autopilot 的读取源”。验证维度与故障维度相同，无法发现层级错位。

4. **每轮重新表述“已修复”，却不重读 workspace skill。** 如果在第二轮前运行一次 `multica skill get <id>`，`updated_at` 和内容仍旧的事实会立刻否定“已经落地”。自然语言信心不能替代部署状态。

5. **把验证责任推迟给用户。** 直到多轮排查后才让用户或 agent 查看 `multica skill get`，使一个单命令可定位的问题演变成长时间调试。权威层验证应是编辑协议的一部分，不是失败后的可选补救。

## Solution

解决方案是一套强制的四步协议：先定位并读取 workspace 权威副本，再通过 Multica CLI 修改该副本，随后重新读取验证，最后用 clean issue 验证行为。Hermes 本地编辑可以保留为准备步骤，但绝不能单独构成“已落地”的证据。

### 1. 编辑前确认 autopilot 绑定链路和 workspace skill

先从 `multica autopilot ea288bf5`、对应执行记录或 `multica issue run-messages <task-id>` 追踪实际 assignee 与 skill，确认目标确实是 `multica skill 9d4e7b25`，而不是根据本地目录名猜测。随后读取 workspace 副本：

```bash
multica skill get <id> --output json | jq '{id, updated_at, content_len}'
```

记录 `id`、`updated_at` 和 `content_len` 作为基线。`id` 必须与 autopilot 实际使用的 workspace skill 一致。如果 Hermes 本地文件刚被大幅修改，而 workspace `updated_at` 仍停留在旧日期、`content_len` 仍对应旧版，就已经证明本地修改尚未部署。此时不能继续声称“已落地”。

### 2. 通过 workspace skill 接口落地修改

修改 `content` 或 `SKILL.md` 主体时，使用：

```bash
multica skill update <id> --content-file <path>
```

该命令会替换整个 `content`，包括 frontmatter。执行前后都要确认 frontmatter 仍完整且可解析，不能把只包含正文的临时文件误当成完整 skill 内容上传。

修改 skill 的 `files/` 附件时，逐文件使用：*(此处 `files/` 指 multica skill 运行时注册的附件目录,不是 git 工作树路径。)*

```bash
multica skill files upsert <id> --path <p> --content-file <c>
```

脚本、模板和 reference 文件都必须写入 `multica skill 9d4e7b25` 对应的 workspace 文件集合。Hermes 本地路径可作为 `<c>` 的来源，但实际产生 blast radius 的动作是 `multica skill files upsert`，不是本地保存。

### 3. 编辑后重新读取并比较

完成写入后再次执行：

```bash
multica skill get <id> --output json | jq '{updated_at, content_len}'
```

`updated_at` 必须比基线前移，`content_len` 必须符合预期内容。两者任一未变化，都应判定“workspace 修改未落地”，立即复查 skill ID、CLI profile、workspace 与所用命令，不得进入生成报告或发布“已修复”的步骤。

对于 `files/`，还应读取或列出 workspace skill 中的目标文件，确认路径、内容与预期一致。时间戳证明发生过写入，内容核对证明写入的是正确版本；两项缺一不可。

### 4. 对行为门控型变更执行 clean-state rerun

`SKILL.md` 中会改变 agent 决策或执行顺序的规则，不能只凭 workspace 内容已更新就断言行为修复。应按照 `docs/solutions/workflow-issues/agent-script-as-source-of-truth.md` 的 Prevention #7，在 clean issue 上验证：删除会干扰判断的旧输出与附件，将状态重置为 `in_progress`，再触发一次新的运行。

`multica issue YUP-485` 是这次修复的后续验证目标。它说明 workspace skill 部署成功与行为验证是两个不同 gate：前者确认 agent 会读到新规则，后者确认新规则在无缓存、无旧产物干扰的状态下真正被执行。

### 怀疑“修复没生效”时的诊断命令

先读取 workspace 层，再与 agent 自称修改的本地文件做直接比较：

```bash
# 1. What does the workspace layer actually say?
multica skill get <workspace-skill-id> --output json | head -20

# 2. What does the agent think they edited?
ls -la ~/work/.../skill-dir/   # or wherever the agent touched
diff <agent's edited file> <(multica skill get <id> --output json | jq -r .content)
```

如果 `diff` 非空，workspace 副本仍与本地修改不一致；本地文件可能是正确的新版本，但 autopilot 仍不会使用它。这个检查不需要理解 Hermes 内部目录结构，只需比较“agent 改了什么”和“Multica 当前提供什么”。

## Why This Works

这套协议把正确性建立在权威读取与可观测状态转换上，而不是建立在 agent 对路径名称的理解或对编辑结果的信心上。

`multica skill get` 是 autopilot 所在系统边界内的确定性读取。编辑前读取解决“我究竟在改哪一个实体”，编辑后读取解决“修改是否真的进入 workspace”。`updated_at` 的前移提供低成本部署证据，内容长度与实际内容核对则防止空写、写错 skill 或上传不完整正文。

`multica skill update` 与 `multica skill files upsert` 明确穿过 workspace API 边界，因此编辑动作与 autopilot 的读取源发生在同一层。相比之下，Hermes 本地 `ls` 和 `diff` 即使完全成功，也只能描述 runtime 文件系统，无法推导 workspace 状态。

诊断 `diff` 还具有独立验证价值：它直接比较两个概念上相同、物理上不同的副本。只要差异存在，就无需继续猜测脚本逻辑、模板数据或 LLM 行为；应先关闭部署层差异。YUP-470 中 17:04 到 18:03 的反复修复证明，缺少这一 gate 时，每个真实的本地修复都会强化错误结论；加入一次权威读取后，根因在一轮内暴露。

最后，clean-state rerun 把“配置已部署”与“行为已生效”分离。前后读取证明 workspace 层一致，干净重跑证明 agent 实际遵循新指令，两道 gate 共同消除“文件看起来对，但运行仍沿用旧状态”的假阳性。

## Prevention

1. **把 pre-edit read 设为硬前置。** 任何声称要修改 autopilot skill 的任务，都必须先运行 `multica skill get <id>`，核对 workspace、skill ID、`updated_at` 与内容。没有基线就不开始编辑。

2. **只把 workspace 写入称为“已落地”。** Hermes 本地保存最多只能表述为“本地修改完成，尚未同步”。只有成功执行 `multica skill update` 或 `multica skill files upsert` 并通过回读，才能表述为“workspace skill 已更新”。

3. **保留 post-edit read gate。** `updated_at` 未前移、`content_len` 不符或目标文件内容不一致时，流程必须 fail closed。不得继续触发 autopilot，也不得让用户承担首次验证。

4. **记录完整实体链路。** 调试笔记或运行评论中同时写明 `multica autopilot ea288bf5`、`multica agent 6d8c2274`、`multica runtime ed53b496` 和 `multica skill 9d4e7b25`，避免只凭“零号机的 skill”这种模糊名称跨层定位。

5. **将 YUP-470 原话作为规则锚点。** 在相关 agent instructions 中保留用户的提醒“为什么是 Hermes 的 skill?”以及“verify workspace skill, edit workspace skill”的结论。真实事故语境能提醒执行者：编辑 framework 本地副本不等于修改系统 workspace 副本。

6. **出现输出不变时先做层级 diff。** 在继续改业务代码、模板或 prompt 前，先运行上面的 `diff`。workspace/local 不一致时优先部署正确版本；只有两层一致后，才排查脚本逻辑或 agent 推理。

7. **对指令变更执行 clean-state rerun。** 遵循 `docs/solutions/workflow-issues/agent-script-as-source-of-truth.md` Prevention #7，清理旧评论、附件与完成状态，再在 `in_progress` 的 clean issue 上重跑。禁止用缓存产物或“无需重跑”的判断验证新规则。

8. **保持协议与 runtime 实现解耦。** 未来非 Hermes runtime 可能使用不同的本地可编辑层，但 workspace 权威读仍以 `multica skill get` 为准。本协议不要求知道每种 runtime 的目录机制，只要求所有 autopilot 变更穿过 workspace API 并回读确认。

本方案不覆盖 `multica skill update` 的 config-only 字段变更；此类修改仍遵循同一原则，但需选择能回读对应 config 字段的验证命令。它也不处理跨 workspace 克隆后源 workspace UUID 泄漏的问题；导入后的 skill 虽然也是目标 workspace 副本，但实体引用本地化属于另一种故障。

## Related Issues

- `multica issue YUP-470`：2026-07-29 原始事故；记录了 17:04 至 18:03 期间的重复错误层修复，以及最终通过 workspace 读取定位根因的过程。
- `multica issue YUP-485`：workspace skill 更新后的五次重跑验证目标，进一步暴露 clean-state rerun 与确定性数据源要求。
- `multica skill 9d4e7b25`：客服会话日报的 workspace 权威 skill；YUP-470 中被误以为已更新、实际仍保留 06-14 旧内容的实体。
- `multica autopilot ea288bf5`：客服会话日报的实际触发入口。
- `multica agent 6d8c2274`：零号机；曾修改 Hermes 本地副本并误报为 autopilot skill 已落地。
- `multica runtime ed53b496`：类型为 `hermes`、名称为 `Hermes (fzmini.local)` 的执行 runtime。
- `docs/solutions/integration-issues/cross-workspace-cloned-agent-skill-refs-leak-source-uuids.md`：处理 skill 跨 workspace 克隆后保留源 workspace UUID 与名称的问题；同样涉及 workspace 边界，但不是 local/workspace 部署层漂移。
- `docs/solutions/workflow-issues/agent-script-as-source-of-truth.md`：处理脚本指标与 agent 输出漂移；其 Prevention #7 的 clean-state rerun 是本文编辑侧协议对应的行为验证侧协议。
- `docs/solutions/integration-issues/autopilot-reads-workspace-skill-not-hermes-local.md`：本文最终归档路径。
