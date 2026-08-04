---
title: Clean-state rerun protocol — 验证 SKILL.md 或 agent instructions 改动时的强制清理
date: 2026-07-30
category: workflow-issues
module: agent-workflow
problem_type: workflow_issue
component: tooling
severity: high
applies_when:
  - "验证 SKILL.md、agent instructions 或 workflow rules 的改动"
  - "使用 multica issue rerun 或等价 MAS 重跑流程"
  - "需要确认新规则确实作用于全新任务执行"
tags:
  - clean-state-rerun
  - false-negative-verification
  - skill-change-validation
  - agent-workflow
  - issue-rerun
  - mas-verification


# Clean-state rerun protocol: verifying agent rule changes without false negatives

## Context

当 SKILL.md、agent `instructions` 或 autopilot 描述发生变更后,验证"规则确实生效"的标准动作是 `multica issue rerun <id>`。然而这条命令并不保证任务从零执行:接收方 agent 会基于 issue 当前状态做自判决——若 issue 已有上一次运行产出的评论、附件,且状态非 `pending`/`todo`,agent 很可能判定"无需重跑"并跳过。这种跳过不会报错,只会留下一条"无需重跑,所有交付物完整有效"的状态评论,操作者于是得出"规则改动无效"的结论——但事实上规则从未被运行过。这是一类典型的 **false-negative verification**:测试本身没跑,测试结论却是失败。

2026-07-30 在 `multica issue YUP-485` 上观察到的 5 次重跑序列完整呈现了这种 false-negative:

| rerun | SKILL.md 当时状态 | issue 当时状态 | 结果 |
|---|---|---|---|
| #1 | 加入 HTML 流程段 | clean(无旧评论) | 4672字 七大章 + HTML 附件(规则已应用,但评论仍冗长) |
| #2 | + 评论区收窄 | 1 条旧评论(#1 的 4672字),状态 `in_review` | 197字 "无需重跑,所有交付物完整有效"(规则**未**应用——零号机跳过) |
| #3 | 规则同 #2(已删旧评论、重置 `in_progress`) | clean | 351字 小表(规则已应用) |
| #4 | + avg_response 脚本 + 数值铁律 | clean(#3 已删) | 354字(规则已应用) |
| #5 | + alerts.longSessions 铁律 | clean(#4 已删) | 225字(规则已应用,含新增铁律) |

rerun#2 是最关键的现场证据:零号机的状态评论引用"今日 08:00 的 autopilot 运行已完成全部交付:数据源: 68 条会话 ✅;HTML 报告: 199KB 已生成并上传 ✅;标题格式: 包含摘要 ✅;**评论摘要: 七大章精简版已发布 ✅**"。它把 #1 留下的 4672字 当作"任务已完成"的证据,据此宣告"无需重跑"——但那段 4672字 本身就是旧规则下需要被收窄掉的不合格产物。

## Guidance

任何"修改 SKILL.md / agent instructions / autopilot description → 验证新行为"的回路都必须包含一次显式的 clean-state 重跑。完整协议如下:

### Step 1 — 验证改动落到正确的读取层

```bash
multica skill get <workspace-skill-id> --output json | jq '{updated_at, content_len}'
# 或针对 agent instructions:
multica agent get <agent-id> --output json | jq '{updated_at, instructions_len}'
```

`updated_at` 必须比上一次取值靠后。若没有,说明改动落到了错误的层(参见姐妹文档 `docs/solutions/integration-issues/autopilot-reads-workspace-skill-not-hermes-local.md`)——autopilot 仍然在读旧版本,任何重跑都只会复现旧行为。

### Step 2 — 清空目标 issue 的历史产物

```bash
ISSUE=<id>

# 删除所有评论(包含 agent 可能会拿来做"已完成"证据的旧评论)
COMMENT_IDS=$(multica issue comment list "$ISSUE" --recent 50 --output json | jq -r '.[].id')
for cid in $COMMENT_IDS; do
  multica issue comment delete "$cid"
done

# 删除旧附件(若 SKILL.md 规定要交付附件,避免 HTML 预检门因"附件已存在"而走旁路)
```

### Step 3 — 重置状态为 `in_progress`

```bash
multica issue status "$ISSUE" in_progress
```

注意:**不要用 `todo`**——`todo` 会再次触发 assignee,可能并发排队。`in_review` / `done` 都会向 agent 传递"上一次已完成,无需再做"的信号;`in_progress` 是飞行中重跑的安全重置点。

### Step 4 — 发起重跑并捕获 task_id

```bash
multica issue rerun "$ISSUE" --output json | jq '{task_id: .id, status}'
```

记下 `task_id`,后续监控要用。

### Step 5 — 轮询直到任务结束

```bash
multica issue runs <issue-id> --output json | jq -r --arg t <task-id> \
  '.[] | select(.id==$t) | .status'
```

若任务直接 `completed` 且**没有任何新评论**,这是新的失败模式:agent 跳过但未写明原因,需要排查。

### Step 6 — 校验输出确为新规则产物

例如 SKILL.md 规定"评论 ≤ 350 字,只列核心指标":

```bash
multica issue comment list <issue> --recent 5 --output json | \
  jq '.[0].content | length'
# 期望 ≤ 350,而不是旧的 4672
```

若长度仍和旧规则产物一致,意味着规则没生效。最常见三类原因:
- 改动没落到 workspace 层(回到 Step 1 重核);
- 规则措辞太宽泛,agent 自行宽松解释(参考姐妹文档 `docs/solutions/workflow-issues/agent-script-as-source-of-truth.md`,规则须给出 field-path 精度);
- 存在另一条更新或更旧的规则在覆盖当前规则(grep SKILL.md 找冲突)。

## Why This Matters

三层因素共同催生了 false-negative,任何一层单独存在都不至于致命:

1. **零号机指令偏"结果导向 + 高效执行"**。在 `multica agent 6d8c2274 instructions` v1.5 中已验证该措辞,这种 wording 倾向"快速交付",而不是"干净验证"。当 issue 看起来已"完成",跳过重跑被解读为"高效"。*(此处的 `6d8c2274` 为 Multica workspace agent ID,不是 git commit SHA。)*
2. **`multica issue rerun` 语义本身存在歧义**:不同 agent 会把 `rerun` 解读为"重新执行"或"看看要不要做"。零号机把它读成后者,即便同一条 SKILL.md、同一个 agent,语义也会随 issue 状态漂移。
3. **协议层没有强制重置环境**。测试环境的搭建完全交给操作者自由裁量,默认假设"每次重跑都是干净的"——这在交互式 agent 上几乎从来不是真的。

根因属于 `missing_workflow_step`:"改 SKILL.md → 验证 SKILL.md 生效"的回路里缺少一个显式重置步骤来制造可验证环境。Step 1 是对姐妹文档(edit-layer vs read-layer)的 **verify** 端镜像:那条文档讲怎么落到正确层,本协议讲怎么验证改动真的被读到。

## When to Apply

适用场景:

- SKILL.md 改动意在改变 agent 行为,需要确认;
- `multica agent <id> instructions` 更新后;
- autopilot 的 description / project / priority / status 转换逻辑调整后;
- 新增自定义规则(评论长度上限、脚本作为唯一数值来源、priority-count = `longSessions.length` 等)并需要确认其生效。

不适用场景:

- 全新 issue 上的首次运行(没有旧状态可清);
- 手工 `multica issue comment add`(只是评论,不是 agent run);
- 纯调试/排查类重跑(此时旧状态本身是信息源)。

## Examples

**典型反例(rerun#2 现场)**:操作者改完 SKILL.md 后直接 `multica issue rerun YUP-485`,issue 状态停在 `in_review`,上一轮的 4672字 评论仍在。零号机产出 197字 评论,引用旧评论作为"已交付"证据。操作者据此判定"评论区收窄规则无效",实际是规则从未跑过。

**正确流程(对应 rerun#3)**:
1. `multica skill get 9d4e7b25 --output json | jq '.updated_at'` —— 确认 SKILL.md `updated_at` 已推进;*(此处 `9d4e7b25` 为 Multica workspace skill ID,不是 git commit SHA。)*
2. `multica issue comment list YUP-485` + `multica issue comment delete <id>` 清空所有评论;
3. `multica issue status YUP-485 in_progress`;
4. `multica issue rerun YUP-485 --output json | jq '.id'` —— 记下 task_id;
5. 轮询 `multica issue runs YUP-485` 直到 `completed`;
6. `multica issue comment list YUP-485 --recent 1` —— 长度 351 字,符合收窄后的版式。

后续 #4、#5 重复这一流程,每轮都先清旧评论、再重置 `in_progress`、再 rerun、再校验字节数。

## Related

- `multica issue YUP-485` —— 5 次重跑的完整演示(rerun#2 因未重置失败,#3–#5 因 clean state 成功)
- `multica issue YUP-470` —— 技能层混用的起源 issue
- `multica skill 9d4e7b25` —— 被反复验证的 SKILL.md
- `multica agent 6d8c2274 instructions v1.5` —— 零号机 "结果导向 + 高效执行" 措辞源
- `docs/solutions/workflow-issues/agent-script-as-source-of-truth.md` —— 姐妹文档,讲规则必须给出 field-path 精度;其 Prevention #7 用一行提及 clean-state rerun,本协议是对该行的完整展开
- `docs/solutions/integration-issues/autopilot-reads-workspace-skill-not-hermes-local.md` —— 姐妹文档,讲编辑层 vs 读取层;Step 1 是该文档的 verify 端镜像
- `docs/solutions/workflow-issues/` —— workflow/操作类留档目录