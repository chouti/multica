---
title: Super-admin User Rename Fix - Plan
type: fix
date: 2026-07-23
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

## Goal Capsule

- **Objective:** 让超级管理员"用户管理"页面的改名功能真正生效（写入数据库），并消除改名失败却提示成功的"假成功"现象。
- **Authority hierarchy:** 仓库规范优先（`CLAUDE.md` 的 State Rules：TanStack Query 管理服务端状态、API 经由 client；Coding Rules：优先复用既有模式而非新建并行抽象）；其次本计划的 KTD；用户偏好（最小修复、不加视图层测试）。
- **Execution profile:** Lightweight，单一改动单元，单次提交。
- **Stop conditions:** 改名经 React Query mutation 成功写入 DB、列表自动刷新显示新名字、失败时如实向用户报错；无其它内部裸 `fetch` 回归。
- **Tail ownership:** 由 self-host fork 维护者执行；按改动通用性（universal vs fork-local）决定是否 PR 回上游。

---

## Product Contract

### Summary

把超管"用户管理"页面改名 handler 里的裸 `fetch` 替换为已存在但未导出、未被使用的 `useUpdateUserName` React Query mutation，使请求经 API client 携带 CSRF/认证头、失败如实反馈、成功后刷新用户列表。修复仅限该单一 handler，不动后端。

### Problem Frame

超级管理员在 `/admin` 用户管理页面为某用户改名（例如 `guanxin.zhao` → `赵冠欣`）时，UI 弹出"重命名成功"提示，但数据库 `user.name` 未更新。根因有二，均在前端：

1. 改名 handler 用裸 `fetch` 发请求，只设置了 `Content-Type` 头，**没有携带 Multica 的 `X-CSRF-Token` 头**。后端 `ValidateCSRF`（双提交 cookie 模式）校验失败，拒绝该 PATCH，数据库从未被写入。
2. 裸 `fetch` 只在网络层错误时才 reject，HTTP 4xx/5xx 不抛异常，因此即便后端返回 403，代码仍走到 `toast.success`，形成"假成功"。

旁证：API client 的 `adminUpdateUser` 方法、以及 `core/admin/mutations.ts` 里的 `useUpdateUserName` mutation（后者还已在 `onSuccess` invalidate 用户列表）早已实现完毕，且 `useUpdateUserName` 已经在 `core/admin/index.ts` 导出——唯独前端 `UserRow` 的改名 handler 没有接入它，临时用了裸 `fetch`。同页其它 admin 操作（邀请、加 workspace、改角色）都规范走 mutation，唯独改名这一条断了线。后端 handler 与 SQL 均正常，不在本次范围。

### Requirements

- R1. 改名请求必须经由 API client（自动携带认证与 `X-CSRF-Token` 头），不再使用裸 `fetch`。
- R2. 改名失败时必须向用户如实反馈错误，不得在失败时显示成功提示。
- R3. 改名成功后，用户列表必须刷新以显示新名字。
- R4. 复用既有的 `useUpdateUserName` mutation 与 `api.adminUpdateUser`，不新建并行抽象。

### Scope Boundaries

- **In scope:** `packages/views/admin/user-management-page.tsx` 的 `UserRow` 改名 handler——接入已导出的 `useUpdateUserName`。`useUpdateUserName` 与 `api.adminUpdateUser` 均已存在并已导出，无需改动 `core/admin`。
- **Out of scope:** 后端（handler/SQL 链路正常）；`packages/views/runtimes/components/update-section.tsx` 的裸 `fetch`（调用外部 GitHub Releases API，无需 Multica 的 CSRF/认证，保持原样正确）；审计或改动其它 admin 操作（它们已正确使用 mutation）。
- **Deferred to follow-up work:** 视图层测试（用户本次选择最小修复；admin 视图零测试基线，建立 callable-store mock 测试基础设施留待后续）；将现有 `guanxin.zhao` 数据手动改名为"赵冠欣"（修复后在 UI 重新改名即可成功，属数据操作非代码工作）。

---

## Planning Contract

### Key Technical Decisions

- **KTD1 — 接入现成 mutation，而非新建。** `useUpdateUserName` 已在 `packages/core/admin/mutations.ts` 实现并经 `core/admin/index.ts` 导出：它调用 `api.adminUpdateUser`（走 `fetchRaw`，自动附加 `Authorization`、`X-CSRF-Token`、`credentials: include`），并在 `onSuccess` invalidate `adminKeys.users()`。修复本质是单步 UI 接入（`UserRow` 改用该 hook），不引入新抽象、不改动 `core/admin`（遵循 Coding Rules：优先既有模式）。
- **KTD2 — 走 React Query mutation 一并解决三个症状。** 切换到 mutation 同时修复 CSRF/认证缺失（KTD1 的 `fetchRaw` 负责）、失败如实反馈（mutation 在非 2xx 时 reject，落入 `catch`）、列表刷新（`onSuccess` invalidate）。无需单独处理任一项。这也回归了 `CLAUDE.md` State Rules 的硬约束——服务端状态本应由 TanStack Query 管理，裸 `fetch` 是对该约束的违反。
- **KTD3 — 本次不加视图层测试。** 用户决策。admin 视图目录当前零测试覆盖，引入 callable-store mock 等测试基础设施会显著放大 scope。端点级行为由后端既有 `server/internal/handler/super_admin_test.go` 覆盖；改名端到端正确性通过手动验证确认。

---

## Implementation Units

### U1. 将超管改名接入既有的 useUpdateUserName mutation

- **Goal:** 让改名请求经 API client 发出、成功后刷新用户列表、失败时如实报错，彻底移除裸 `fetch` 与假成功。
- **Requirements:** R1, R2, R3, R4
- **Dependencies:** 无
- **Files:**
  - `packages/views/admin/user-management-page.tsx` — 修改：`UserRow` 组件接入已导出的 `useUpdateUserName`，重写 `handleSave`，移除裸 `fetch`。
- **Approach:** 在 `UserRow` 内调用已导出的 `useUpdateUserName`；`handleSave` 改为通过 mutation 提交改名（保留既有的 trim 与非空校验）：提交成功后 `toast.success` 并退出编辑态，提交失败时落入错误分支显示错误信息（不再误报成功），`finally` 中复位 saving 态。删除原先的裸 `fetch` 调用。组件本地的 `name` 受控输入态、Enter/Escape 处理保持不变。
- **Patterns to follow:** 同文件 `EditWorkspacesDialog` 中 `useAdminAddUserToWorkspaces` / `useAdminUpdateUserRole` 的 `mutateAsync` + `try/catch` + `toast` 范式（`user-management-page.tsx` 的 workspace 增删与角色改动段）。
- **Test scenarios:** Test expectation: none — 用户选择最小修复、不新增视图层测试；改名端点行为由 `server/internal/handler/super_admin_test.go` 覆盖，端到端正确性经手动验证。
- **Verification:** 以超管身份在 `/admin` 对某用户（如 `guanxin.zhao`）改名；DevTools Network 中 `PATCH /api/admin/users/{id}` 返回 200、`user.name` 在数据库更新、列表自动刷新显示新名字；构造失败（如断网）时显示错误提示而非成功。

---

## Verification Contract

| 检查 | 命令 / 动作 | 适用 | 通过信号 |
| --- | --- | --- | --- |
| 类型检查 | `pnpm typecheck` | U1 | 导出与接入类型正确，无报错 |
| Lint | `pnpm lint` | U1 | 无新增告警 |
| 端到端手动验证 | `/admin` 改名 | U1 | PATCH 200 + DB 更新 + 列表刷新；失败时报错 |
| 回归守卫 | 在 `packages/views` 搜索内部裸 `fetch` | 全局 | 确认无新的内部裸 `fetch`（runtimes 的外部 GitHub fetch 除外） |

`release:validate` 不适用于本改动（纯前端 bug 修复，无 CLI/API 契约变更）。

---

## Definition of Done

- **全局:** 超管改名经 React Query mutation 成功写入 DB；失败如实报错、不再假成功；`packages/views` 内除已知外部 GitHub fetch（`packages/views/runtimes/components/update-section.tsx`）外无其它内部裸 `fetch`。
- **U1:** `UserRow` 不再含裸 `fetch`，改用 mutation 并正确处理成功/失败；`pnpm typecheck` 与 `pnpm lint` 通过；`/admin` 手动改名验证通过。
- **清理:** 实施过程中若产生任何废弃的临时代码或注释，须在提交前移除。
