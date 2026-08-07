---
title: "KEEP-BOTH merge 冲突的 git「共同 context」陷阱：尾部括号被移出冲突块"
date: 2026-08-05
category: workflow-issues
module: git-workflow
problem_type: workflow_issue
component: development_workflow
severity: low
applies_when:
  - "合并两侧在同一 EOF 位置各追加独立的函数/测试（KEEP-BOTH 类冲突）"
  - "Go 文件 tab 缩进，gofmt 作为 resolve 后的结构校验"
  - "self-host fork 升级合并 Go 测试/handler 文件"
root_cause: logic_error
resolution_type: workflow_improvement
tags: [git, merge-conflict, gofmt, keep-both, shared-context, braces, upgrade]
related_components:
  - server/cmd/multica/cmd_issue_test.go
---

# KEEP-BOTH merge 冲突的 git「共同 context」陷阱：尾部括号被移出冲突块

## Context（背景：本次遇到什么）

v0.4.17 → v0.4.18 升级合并时，`server/cmd/multica/cmd_issue_test.go` 产生一处 content conflict：fork 在文件末尾追加了 `TestValidateIssueStatusArchived`（#6106 archived 守护），upstream 在同一 EOF 位置追加了 `TestIssueCommentListHelpCarriesReadContract`（MUL-5442 read-contract 守护）。两侧是**独立的测试函数**——被测对象、断言、新 import 零重叠——教科书式的 KEEP-BOTH 场景，常规解法是「删掉冲突标记、两侧内容都留」。

但删标记后跑 `gofmt -w` 报错：

```
server/cmd/multica/cmd_issue_test.go:3483:1: expected declaration, found '}'
```

文件尾部出现**多余的一个 `}`**，Go 编译器认为它在函数外（顶层只能有 declaration）。go build 同样会失败。

## Guidance（识别 + 正确解法）

### 根因

git 三路 merge 在划分冲突块边界时，会把 fork 侧末尾与 upstream 侧末尾**字面相同**的行（这里两个函数各自尾部的 `}` 闭合行）当成「共同 context」（common context）放到冲突块**外**。但两侧函数的嵌套层级不同，这些「共同 context」行实际只属于其中一侧——简单删标记会把它们留在不该出现的位置，导致**括号失衡**。

### 诊断信号

满足任一即要警惕「共同 context」陷阱：

- 冲突块**外**（`>>>>>>> branch` 之后、EOF 之前）紧跟着几行孤立的 `}`。
- 这些 `}` 的缩进与两侧函数的预期闭合层级对不上。
- `gofmt -w`（或 `go build`）报 `expected declaration, found '}'`、`unexpected '}'` 等结构错。
- Edit 工具对整块 conflict old_string 反复报「String to replace not found」（tab 缩进失配，连 `\uXXXX` 兜底也救不回）。

### 正确解法：python slice + gofmt 校验

不要手工拼标记、也不要用 Edit 逐字符复制（tab 易错）。从原文件直接 slice 出两侧内容（tab 自动正确），各自手工补全尾部闭合括号，最后 `gofmt -w` 权威修正缩进 + 结构校验：

```python
path = "server/cmd/multica/cmd_issue_test.go"
text = open(path).read()

# 1. 定位冲突块边界
start = text.rindex("<<<<<<< HEAD")
mid   = text.index("\n=======\n", start)
end   = text.index("\n>>>>>>>", mid)
# end 之后到 EOF = git 误划出去的「共同 context」尾部行（要丢弃，不保留）

# 2. slice 两侧内容（tab 由文件本身保留，绝不手写）
fork_body = text[start + len("<<<<<<< HEAD\n"):mid]   # 停在 fork 函数体最后一行（无闭合）
up_body   = text[mid + len("\n=======\n"):end]         # 停在 upstream 函数体最后一行

# 3. 各自补全尾部闭合（按函数实际嵌套层级，手数字符串；这里是 Go 测试函数典型层级）
fork_full = fork_body + "\n\t}\n}"            # fork: 关 if(1tab) + 关 func
up_full   = up_body  + "\n\t\t}\n\t}\n}"      # upstream: 关 if(2tab) + 关 for(1tab) + 关 func

# 4. 拼接两侧 + 函数间空行，丢弃原「共同 context」
new_text = text[:start] + fork_full + "\n\n" + up_full + "\n"
open(path, "w").write(new_text)
```

```bash
gofmt -w server/cmd/multica/cmd_issue_test.go   # 权威修正缩进 + 结构校验
```

`gofmt -w` exit 0 = 括号平衡 + 语法合法；exit 非 0 说明括号还差，按报错位置继续补。**gofmt 在这里同时是格式化工具和结构性语法校验器**——它能修正缩进层级（手补的 tab 不必完美），又因括号失衡而以非零退出报错。

## Why This Matters（为什么不能简单删标记）

git 的「共同 context」是**字面行匹配**，不是**语义对齐**。fork 函数尾部的 `\t}`（关 if）与 upstream 函数尾部的 `\t\t}`（关内层 if）字面不同，但 git 的 diff 算法在某一侧把它们视为共有的收尾行，划到冲突块外。删标记后这些行留在文件里，却**归属错误**——它们本该只属于其中一个函数的闭合，现在跟在另一个函数后面，导致前者多一层闭合、后者少一层。

Edit 工具对 tab 缩进极其敏感：手工复制含 tab 的 old_string 极易失配。对 Go 这种 tab 缩进语言的大冲突块，python 从文件本身 slice 是可靠路径——唯一手写的部分是「补几个 `\t}`」（缩进层级），而非整块代码。

## When to Apply（什么时候遇到）

- **KEEP-BOTH 类 merge conflict**：两侧在同一位置各追加**独立**的函数/测试/方法（函数名不同、被测对象不同、断言不重叠），解法是两个都留。
- 冲突块**外**紧跟着几行闭合括号（`}`），且缩进看起来「不对劲」。
- `gofmt -w` / `go build` 在 resolve 后报结构错。
- self-host fork 升级合并 Go 测试/handler 文件时（本轮 v0.4.18 触发；未来任何 KEEP-BOTH 场景都可能再遇）。

## Examples（实例：本轮的真实冲突块结构）

```
<<<<<<< HEAD
func TestValidateIssueStatusArchived(t *testing.T) {
    ...
    if err := validateIssueStatus("archive"); err == nil {
        t.Error("...typo")
=======
func TestIssueCommentListHelpCarriesReadContract(t *testing.T) {
    ...
    if !strings.Contains(help, want) {
        t.Errorf("...help")
>>>>>>> v0.4.18
    }      ← git 把这两行当成「共同 context」放到冲突块外
    }      ← 实际只属于 upstream 函数的尾部闭合（fork 侧不该有）
```

简单删标记 → fork 函数后跟多余 `}`、upstream 函数缺闭合 → gofmt 报 `expected declaration`。正确解法是识别共同 context 边界、python slice 两函数各自补全、gofmt 校验。

## Related（相关文档）

- `docs/solutions/workflow-issues/safe-upstream-upgrade-with-local-customizations.md` — self-host 升级合并的 10 步 SOP；本文是其 resolve 阶段的一个具体陷阱深挖。
- `docs/solutions/workflow-issues/merge-keep-both-json-trailing-comma-trap.md` — **同族陷阱的 JSON 变体**。同一根因族「git 字面匹配 ≠ 语义对齐（KEEP-BOTH）」，但机制不同：本文是 git 把尾部 `}` 划出冲突块破坏**括号**平衡（python slice + `gofmt` 校验）；那篇是 fork 末行缺**逗号**导致 union 后 JSON 非法（union + 补逗号 + `json.tool` 校验）。不同文件（Go 测试 vs locale JSON）、不同校验器。
- `docs/solutions/workflow-issues/rerere-stale-auto-resolution-upgrade-merge.md` — rerere 在升级合并的行为（与本文的 git merge 内部边界是不同层面：rerere 是缓存层，共同 context 是 diff 算法层）。
- `docs/upgrades/v0.4.18-plan.md` — 本次升级 Phase 4 的完整 resolve 记录（含此冲突的 python 脚本）。
