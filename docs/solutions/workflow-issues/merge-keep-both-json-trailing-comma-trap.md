---
title: "KEEP-BOTH merge 冲突的 JSON 尾逗号陷阱：fork 末行缺逗号，union 后 json 非法"
date: 2026-08-07
category: workflow-issues
module: git-workflow
problem_type: workflow_issue
component: development_workflow
severity: low
applies_when:
  - "合并两侧在同一 JSON 对象尾部各追加独立的 key（KEEP-BOTH 类冲突）"
  - "fork 侧冲突末行是其 parent 中 `}` 前的最后一条 entry（无尾逗号）"
  - "locale / i18n JSON 文件，json.tool 作为 resolve 后的结构校验"
  - "self-host fork 升级合并 packages/views/locales/*/ 文件"
root_cause: logic_error
resolution_type: workflow_improvement
tags: [git, merge-conflict, json, keep-both, trailing-comma, i18n, locale, upgrade]
related_components:
  - packages/views/locales/en/editor.json
  - packages/views/locales/ja/editor.json
  - packages/views/locales/ko/editor.json
  - packages/views/locales/zh-Hans/editor.json
---

# KEEP-BOTH merge 冲突的 JSON 尾逗号陷阱：fork 末行缺逗号，union 后 json 非法

## Context（背景：本次遇到什么）

v0.4.20 → v0.4.21 升级合并（merge commit `55bf3432f`，2026-08-07，reachable from `main`）时，4 个 locale 文件 `packages/views/locales/{en,ja,ko,zh-Hans}/editor.json` 各产生一处单 hunk content conflict。两侧都改了同一锚点行 `"group_search": "Search results"`（各自在它后面追加 key，所以各自给它补了尾逗号），随后追加**不同**的 key：

- **fork 侧**追加 `group_skills` + 8 个 `skill_*` key，末行是 `skill_agent_row_aria`。
- **upstream 侧**只追加一个 `group_cancelled`。

两侧追加的 key 集合零重叠，是教科书式的 KEEP-BOTH 场景——直觉解法就是「删掉 `<<<<<<<` `=======` `>>>>>>>` 三行标记，两侧 block 都留」。

但删标记后跑 `python3 -m json.tool` 直接报 parse 错。问题出在 fork block 的**末行**：fork parent 里 `"skill_agent_row_aria": "Toggle {{name}}"` 是 `mention` 对象闭合 `},` 前的最后一条 entry，**它自己那行没有尾逗号**。upstream 的 `"group_cancelled"` 行被 union 到它正下方后，两条 entry 之间**没有逗号**——JSON 非法。

## Guidance（识别 + 正确解法）

### 根因

JSON 对象中除末条外的每条 entry 都以 `,` 结尾，**唯独末条没有**。fork 在其 parent 中把 `skill_agent_row_aria` 放在对象尾部，所以该行**不带尾逗号**是合法 JSON。但 KEEP-BOTH union 会在它下面再接一条 upstream 的 entry——一旦 `skill_agent_row_aria` 不再是末条，它就**必须**带逗号。git 的文本级 merge 不懂这个语义，简单删标记不会改变任何一行内容，于是逗号缺失原样保留，产物非法。

### 诊断信号

满足任一即要警惕「尾逗号」陷阱：

- KEEP-BOTH 冲突的某一侧，其 block **末行**是一个 JSON entry（`"key": value`），且行尾**没有逗号**。
- 该侧 parent blob 里，这条 entry 后面紧跟的是 `}` 或 `},`（即它是对象的末条 entry）。
- 删标记后 `python3 -m json.tool <file>` 报 `Expecting ',' delimiter` 之类 parse 错。
- i18n loader / parity 测试在 build/test 阶段失败。

### 正确解法：保留 fork block + 末行补逗号 + 接 upstream + json.tool 校验

不要手工拼标记，也不要用 Edit 逐字符复制（locale 含 CJK / `{{name}}` 占位符，易错）。从原文件直接 slice 出 fork block，**确保其末行以逗号结尾**，再接 upstream 的 `group_cancelled` 行，最后 `json.load` 权威校验：

```python
import json, re

path = "packages/views/locales/en/editor.json"
text = open(path).read()

# 1. 定位冲突块三标记
m = re.search(
    r"<<<<<<<[^\n]*\n(?P<fork>.*?)\n=======\n(?P<up>.*?)\n>>>>>>>[^\n]*\n",
    text, re.S,
)
fork_block = m.group("fork")   # fork 侧追加的 key（末行无逗号）
up_block   = m.group("up")     # upstream 侧追加的 group_cancelled

# 2. 关键一步：确保 fork block 末行以逗号结尾（它即将不再是最末条 entry）
if not fork_block.rstrip().endswith(","):
    fork_block = fork_block.rstrip() + ","

# 3. union：fork block（已补逗号） + upstream block，替换整个冲突块
union = fork_block + "\n" + up_block
new_text = text[:m.start()] + union + text[m.end():]
open(path, "w").write(new_text)

# 4. 权威校验：json.load 能解析才算 resolved
json.load(open(path))
print("VALID")
```

```bash
# 批量校验 4 个 locale
for loc in en ja ko zh-Hans; do
  python3 -m json.tool "packages/views/locales/$loc/editor.json" >/dev/null \
    && echo "$loc VALID" || echo "$loc INVALID"
done
```

`json.load` / `json.tool` 在这里**同时是格式化无关的语法校验器**：能 parse = 逗号齐备、结构合法；parse 失败会指出缺逗号的确切行号。**resolve KEEP-BOTH JSON 冲突后必须跑一次 `json.tool`，不能仅凭肉眼确认标记已删。**

本轮实测：4 个 locale 全部 resolve 为合法 JSON，扁平化 leaf key 数 fork 94 → resolved 95（净增 `mention.group_cancelled` 一条），loss scan `flat(fork) − flat(now) == ∅`（fork 侧零丢失）。

## Why This Matters（为什么不能简单删标记）

「删标记、两侧都留」之所以在多数 KEEP-BOTH 场景有效，是因为追加的内容**自带完整语法**。但 JSON 的尾逗号规则打破了这个假设：一条 entry 是否带逗号，取决于它**后面还有没有别的 entry**——这是个**位置相关**的属性，不是 entry 自身的固有属性。fork 的末行在 fork parent 里合法（它是末条），被 union 成非末条后就非法。

这与 `merge-conflict-checkout-theirs-drops-fork-only-members.md` 的规则是**接力关系**，不是重复：那条文档讲「fork 比 upstream 多成员（locale key）时，冲突要用 `git merge-file` 三路合并，绝不能 `--theirs` 整文件覆盖（会抹掉 fork-only key）」。本文讲的是**正确选择了 keep-both 之后**才会撞上的下一步——union 出来的文本未必是合法 JSON，必须补逗号 + 校验。

## When to Apply（什么时候遇到）

- **KEEP-BOTH 类 JSON merge conflict**：两侧在同一对象尾部各追加**独立**的 key（key 名不同、互不重叠），解法是两个都留。
- 某一侧 block 的末行是**不带逗号**的 entry（在其 parent 中它是对象末条）。
- 删标记后 `json.tool` / i18n loader / parity 测试报 parse 错。
- self-host fork 升级合并 `packages/views/locales/*/` 时（本轮 v0.4.21 触发；未来任何 locale JSON 的 KEEP-BOTH 场景都可能再遇）。

## Examples（实例：本轮的真实冲突块结构）

```
    "group_search": "Search results",     ← 共同锚点行（两侧都给它补了逗号，各自后接新 key）
<<<<<<< HEAD
    "group_skills": "Skills",
    ...
    "skill_agent_row_aria": "Toggle {{name}}"   ← fork 末行：无尾逗号（parent 中它后面是 },）
=======
    "group_cancelled": "Cancelled"              ← upstream 追加的单条 entry
>>>>>>> v0.4.21
```

简单删标记 → `skill_agent_row_aria` 行（无逗号）紧跟 `group_cancelled` 行 → 两条 entry 之间缺逗号 → `json.tool` 报 parse 错。正确解法是 fork block 末行补 `,`、再接 upstream 行、`json.tool` 校验：

```
    "group_search": "Search results",
    "group_skills": "Skills",
    ...
    "skill_agent_row_aria": "Toggle {{name}}",   ← 补上的逗号
    "group_cancelled": "Cancelled"
```

本轮 4 个 locale 的 `group_cancelled` 译文（来自 upstream parent `55bf3432f^2`）：en=`Cancelled`、ja=`キャンセル済み`、ko=`취소됨`、zh-Hans=`已取消`。

## Related（相关文档）

- `docs/solutions/workflow-issues/merge-keep-both-shared-context-brace-trap.md` — **同族陷阱的 Go 变体**。同一根因族「git 字面匹配 ≠ 语义对齐（KEEP-BOTH）」，但机制不同：那篇是 git 把两侧字面相等的尾部 `}` 当「共同 context」划出冲突块、破坏**括号**平衡，解法是 python slice + `gofmt` 校验；本文是 fork 末行缺**逗号**，解法是 union + 补逗号 + `json.tool` 校验。不同文件（Go 测试 vs locale JSON）、不同校验器（`gofmt` vs `json.tool`）。
- `docs/solutions/workflow-issues/merge-conflict-checkout-theirs-drops-fork-only-members.md` — 更上层的规则：fork 比 upstream 多 locale key 时用 `git merge-file` 三路合并、绝不 `--theirs`。本文是正确选择 keep-both **之后**撞上的逗号细节。
- `docs/solutions/workflow-issues/safe-upstream-upgrade-with-local-customizations.md` — self-host 升级合并的 10 步 SOP；本文是其 resolve 阶段的一个具体陷阱深挖。
- `docs/solutions/workflow-issues/fork-customization-invariant-set-upstream-test-collision.md` — fork 定制跨代码+测试+每 locale 的不变量集合；本文的 `json.tool` 校验是该不变量验证中的一个检测闸。
- `docs/solutions/workflow-issues/rerere-stale-auto-resolution-upgrade-merge.md` — 相邻的升级合并 git 行为教训（rerere 缓存层会重放过时 resolution）；与本文同属「git 自动冲突处理不是语义的，需事后校验」。
- `docs/upgrades/v0.4.21-plan.md` — 本次升级 artifact，记录此冲突的完整 resolve 过程。merge commit `55bf3432f`（reachable from `main`）即本次 resolution 的落点。
