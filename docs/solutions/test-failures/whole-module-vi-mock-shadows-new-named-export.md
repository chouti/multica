---
title: 整模块 vi.mock 工厂静默遮蔽新增命名导出 — 提交链 TypeError，只有全量 views 套件能抓到
date: 2026-08-19
category: test-failures
module: packages/views/issues/hooks
problem_type: test_failure
component: testing_framework
severity: medium
symptoms:
  - "reply-input.test.tsx 用例 \"the submit terminal fill covers the pre-debounce window on the reply path (AE1)\" 失败：expected \"vi.fn()\" to be called 1 times, but got 0 times"
  - "use-skill-auto-bind.ts 在 syncSkillMentionsWithDoc / finalizeSkillMentionAgents 提交路径调用 isNoteCommentDraft 抛 TypeError（mock 模块上该导出为 undefined），unhandled error 使提交链中断"
  - "修复波次自身的定向套件全绿（comment-input 28 + use-recommended-skill-agent 9 + core 20 + editor 33），只有跑全量 views 包套件（4428 tests）才暴露；stash 基线确认改动前该测试通过"
root_cause: test_isolation
resolution_type: test_fix
related_components: [frontend]
tags: [vi-mock, import-actual, vitest, test-isolation, skill-mention, comment-composer, module-mock, regression-detection]
framework_version: vitest 4.1.0
---

# 整模块 vi.mock 工厂静默遮蔽新增命名导出 — 提交链 TypeError，只有全量 views 套件能抓到

## Problem

在一次针对 `feat/skill-auto-bind-popover` 特性（合并到 main 为 `43267d383`）的 ce-code-review 修复波次中，review finding #9 让生产引擎 `packages/views/issues/hooks/use-skill-auto-bind.ts` 新增了对 `packages/views/issues/hooks/use-comment-trigger-preview.ts` 里 `isNoteCommentDraft` 的具名导入。但四个已存在的测试文件各自对该 hook 模块做了**整模块的部分 mock**（工厂只返回 `useCommentTriggerPreview`），`vi.mock` 是整模块替换语义，导致 mock 上 `isNoteCommentDraft` 为 `undefined`，引擎一调用就在文档同步与提交路径里抛 `TypeError`。

## Symptoms

故障以"下游断言失败 + 未处理错误计数"的组合签名呈现：

- `reply-input.test.tsx` 的用例 "the submit terminal fill covers the pre-debounce window on the reply path (AE1)" 报 `AssertionError: expected "vi.fn()" to be called 1 times, but got 0 times` —— 提交在调用 `onSubmit` 之前就静默死掉了。
- Vitest 报告 "8 unhandled errors during the test run"；向上滚动后能看到第一条未处理错误是 `Error: [vitest] No "isNoteCommentDraft" export is defined on the "../hooks/use-comment-trigger-preview" mock. Did you forget to return it from "vi.mock"?`
- 波次自己点名的目标套件全部通过（`comment-input.test.tsx` 28/28、`use-recommended-skill-agent.test.ts` 9/9、core 20/20、mention-view+picker 33/33）。断裂只在跑**完整** views 包套件（4428 个测试）时才暴露 —— `reply-input.test.tsx` 根本不在这次波次的 diff 触及范围内。
- `git stash` 基线跑确认改动前该测试通过（4/4），证明这是波次引入的真实回归，而非存量失败。

## What Didn't Work

波次的验证策略是"只跑被触及文件的定向套件"。这一步全绿，给了错误的信心：

- 波次只改了 `use-skill-auto-bind.ts`（引擎）和 `comment-input.test.tsx`（它自己的 mock 在同波次一并修好了），于是只跑了这些文件对应的套件。`reply-input.test.tsx`、`comment-card-edit-gate.test.tsx`、`comment-card-reply-skill-forward.test.tsx` 都不在 diff 里，定向套件天然看不到它们。
- 问题在于 `use-comment-trigger-preview` 这个模块的"被消费导出面"是一条**跨测试文件的隐形契约**：四个测试文件各自独立地 mock 了同一个模块，但没有任何一处代码把它们和被 mock 的真实模块在类型/运行时层面连起来。引擎新增一个具名导入，只影响"真实模块的运行时导出"，而每个 mock 工厂的返回值从不被拿来跟真实模块的运行时导出对账。
- typecheck 抓不到：mock 工厂返回类型与真实模块的偏差不会被类型系统判定为错误（工厂返回的是部分形状，运行时才替换）。
- 定位回归真实性的确认步骤是 `git stash` 基线对比：把波次改动 stash 掉后跑同一套件全绿（4/4），恢复后复现失败。这一步把"存量失败"排除掉，把回归精确地归到本次波次。

## Solution

把四个测试文件里的整模块部分 mock 全部改成 **importActual 展开 + 最小覆盖**：先展开真实模块（让所有未被覆盖的导出 —— 包括新增的 `isNoteCommentDraft` —— 以真实实现流过），再只覆盖真正需要控制的那一个导出。

`reply-input.test.tsx:55-67` 落地后的样子（`comment-card-edit-gate.test.tsx:49-56`、`comment-card-reply-skill-forward.test.tsx:47-54` 同形）：

```ts
vi.mock("../hooks/use-comment-trigger-preview", async () => ({
  // Pure helpers (isNoteCommentDraft — the /note fill gate reads it) come
  // through importActual untouched.
  ...(await vi.importActual<typeof import("../hooks/use-comment-trigger-preview")>(
    "../hooks/use-comment-trigger-preview",
  )),
  useCommentTriggerPreview: () => ({
    agents: previewState.agents,
    blocked: [],
    backendAgents: previewState.backendAgents,
    resolved: previewState.resolved,
  }),
}));
```

`comment-input.test.tsx:75-85` 是同波次修好的同一模式，它同样用 `previewState` 可变状态覆盖 `useCommentTriggerPreview`，同时靠 importActual 让 `isNoteCommentDraft` 等纯函数原样流过。

被消费的真实导出位于 `use-comment-trigger-preview.ts:32-34`（`isNoteCommentDraft`），其判定基于 `NOTE_COMMAND_RE`（`use-comment-trigger-preview.ts:11`）。引擎侧在 `use-skill-auto-bind.ts:53` 导入它，并在两处调用：`syncSkillMentionsWithDoc`（`use-skill-auto-bind.ts:248`）与提交路径 `finalizeSkillMentionAgents`（`use-skill-auto-bind.ts:396`）。

修复后四个套件共 38 个测试全部通过；完整 views（4428）+ core（1517）套件全绿；typecheck 与 lint 干净。

## Why This Works

根因是 vitest 的整模块替换语义叠加一条未被任何静态检查覆盖的隐形契约：

1. **`vi.mock` 是整模块替换**。工厂返回什么，模块在测试里就是什么。工厂只返回 `{ useCommentTriggerPreview: ... }` 时，模块上其它所有导出 —— 包括后来新增的 `isNoteCommentDraft` —— 在该测试里都是 `undefined`。
2. **工厂返回值从不被拿来跟真实模块的运行时导出对账**。类型层面工厂可以返回部分形状而不报错；vitest 只在**运行时**有人访问一个缺失导出时才抛 `No "X" export is defined on the ... mock`。
3. **对 merge 与 typecheck 都不可见**。这条契约横跨四个彼此独立、且都不在本次 diff 里的测试文件 —— 三方合并看不到它，类型检查看不到它，只有**执行**是唯一的探测器。这与 (auto memory [claude]) fork 定制不变量集合（`fork-customization-invariant-set-upstream-test-collision.md`）描述的"fork 定制构成跨代码+测试+每 locale 的不变量集合、三方合并抓不到 fork-code×upstream-test 碰撞、只有跑测试才暴露"是**同一类不可见性**，只是此处发生在单分支内部：被 mock 的模块导出面是一条 diff 从未触及的跨测试文件契约。
4. **"8 unhandled errors" 是定位线索**。当一个测试失败并伴随未处理错误计数时，先滚动找**第一条**未处理错误 —— 断言失败（`to be called 1 times, but got 0`）往往只是下游症状，真正的根因是更早抛出的那个 `No "isNoteCommentDraft" export is defined`。先修第一个未处理错误，下游断言常随之恢复。

importActual 展开之所以是正解：它把"真实模块"设为默认值，mock 只声明**差量**（要控制的那一个导出）。未来真实模块再新增导出（如这次的 `isNoteCommentDraft`），会自动以真实实现流过所有这类 mock，不再要求每个 mock 工厂手工同步导出清单。

## Prevention

面向本仓库的具体规则：

1. **每当生产代码开始从某模块导入一个新增具名导出，先 grep 该模块所有现存 `vi.mock` 站点**。

   ```bash
   grep -rn 'vi.mock("../hooks/use-comment-trigger-preview"' packages/views
   # 或按模块名通用搜：
   grep -rn 'vi.mock(' packages/views | grep 'use-comment-trigger-preview'
   ```

   每个站点都要确认它的工厂是否仍能覆盖新导出；用 importActual 展开的站点天然安全。
2. **模块边界 mock 默认用 importActual 展开 + 最小覆盖**，让未来新增导出以真实实现流过：

   ```ts
   vi.mock("<module>", async () => ({
     ...(await vi.importActual<typeof import("<module>")>("<module>")),
     onlyTheExportYouNeedToControl: () => ({ /* ... */ }),
   }));
   ```

   只有当确实要屏蔽整个模块面时才退回到"列举式整模块替换"，并接受此后每次新增导出都要手工同步的维护成本。
3. **共享模块的"被消费导出面"变化时，提交前跑整包套件**，而非只跑被触及文件的定向套件。定向套件看不到 diff 未触及的文件；这次断裂只在完整 views 套件（4428）下才暴露。

   ```bash
   pnpm --filter @multica/views test   # 整包，而非 -t 单用例/单文件
   ```

4. **识别这组失败签名**：`expected "vi.fn()" to be called 1 times, but got 0 times` + vitest 报告 "N unhandled errors" + 滚动后看到 `No "X" export is defined on the "..." mock`。见到它时，先定位第一条未处理错误（缺失导出的 mock），再回头修断言 —— 不要从断言本身入手改断言期望。

## Related Issues

- [run-typecheck-after-upstream-merge.md](../workflow-issues/run-typecheck-after-upstream-merge.md) — 同类元教训的编译期姊妹篇：diff 未触及的文件静默断裂、"我从来没碰过这个文件"不是跳过验证的理由；本文档是其在 vitest 运行时/mock 侧的对应案例（该文档覆盖 tsc 门，本文档覆盖全量 vitest 门）。
- [fork-customization-invariant-set-upstream-test-collision.md](../workflow-issues/fork-customization-invariant-set-upstream-test-collision.md) — "只有跑测试才暴露隐形契约"的先验出处（upstream merge 语境）；本文档把同一原则推广到分支内改动。
- [duplicate-pflag-registration-init-panic-invisible-to-static-gates.md](../runtime-errors/duplicate-pflag-registration-init-panic-invisible-to-static-gates.md) — 同一不可见性类别的 Go 侧对应：静态门（build/vet）全绿，只有实际执行测试二进制才能触发失败。
- [bind-on-skip-when-dedup-rewrites-source.md](../logic-errors/bind-on-skip-when-dedup-rewrites-source.md) — @skill 提及特性簇的根文档，且引用了本学习触及的同一模块 `use-comment-trigger-preview.ts`。
- [skill-autocomplete-cold-cache.md](../ui-bugs/skill-autocomplete-cold-cache.md) — 同一 @skill/@mention composer 功能区的既有文档（仅簇导航，无机制重叠）。
- 特性出处：`docs/plans/2026-08-18-1759-feat-skill-auto-bind-popover-plan.md`（引入 `isNoteCommentDraft` 消费的 review 波次所属特性计划）与 `docs/customizations.md` 的 2026-08-18 auto-bind 条目（含 2026-08-19 review-fix 波注记与 ship 记录）。
