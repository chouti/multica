---
title: "Self-host 前端生产化（standalone + launchd）：修复 multica.aicake.com 502 与 agent 头像消失"
date: 2026-07-22
category: "deployment"
module: "frontend"
problem_type: "ops"
component: "self-host"
severity: "high"
applies_when:
  - "Self-host Multica 经 Cloudflare Tunnel + Caddy 暴露到公网域名（如 multica.aicake.com）"
  - "前端(:3001) 或后端(:8081) 是手动进程，重启 Mac / 关终端后整站 502 Bad Gateway"
  - "agent 头像静默回退成机器人图标（/uploads/*.png 加载失败）"
  - "想把 `pnpm dev:web`(next dev) 换成生产构建常驻 + 开机自启"
---

# Self-host 前端生产化：standalone + launchd

## 现象与根因

公网域名（`https://multica.aicake.com/`）整站 **502**，更早阶段表现为 agent 头像**静默回退成 `lucide-bot` 图标**。

反代拓扑（本机）：

```
浏览器 https://multica.aicake.com/
  → cloudflared tunnel (~/.cloudflared/config.yml: multica.aicake.com → http://localhost:8097)
  → caddy :8097  (Caddyfile: /opt/homebrew/etc/Caddyfile)
       /ws*            → reverse_proxy 127.0.0.1:8081   (后端)
       其他所有路径     → reverse_proxy 127.0.0.1:3001   (Next.js)
  → Next.js 再把 /api、/uploads、/auth、/ws 经 rewrite 转发到 127.0.0.1:8081
```

根因：**`3001`(前端) 和 `8081`(后端) 都是手动进程**，重启即丢；而 launchd 只托管了 `caddy` / `cloudflared` / `multica daemon`。**`multica daemon` 是 agent runtime 管理器，不是 HTTP 后端**（不提供 `/api`、`/uploads`）——这是最常踩的认知坑。后端不在 → caddy 反代失败 → 502；后端 cwd 不对 → `data/uploads` 读不到 → 头像 404 → `actor-avatar.tsx` 的 `onError` 静默回退 Bot。

## 方案：standalone 前端 + launchd 常驻（前端+后端）

选 **standalone**（非 static export、非 next start）：
- `apps/web/next.config.ts` 第 28 行 `STANDALONE === "true"` 条件输出 standalone；`Dockerfile.web` 是完整范本。
- static export 被 `apps/web/proxy.ts`(middleware)、`layout.tsx` 的 `headers()/cookies()` SSR、`download/page.tsx` 的 `revalidate=300` ISR 否决。
- standalone 产出自包含 `server.js` + 追踪过的 `node_modules`，部署到独立目录后**不依赖仓库 dev 环境、不与 `pnpm dev:web` 冲突**。

落地脚本（版本化在仓库 `scripts/selfhost/`）：

| 文件 | 作用 |
|---|---|
| `scripts/selfhost/build-frontend.sh` | `STANDALONE=true REMOTE_API_URL=http://localhost:8081 pnpm --filter @multica/web build`，按 `Dockerfile.web` 布局组装到 `~/.multica/frontend` |
| `scripts/selfhost/run-backend.sh` | launchd wrapper：`cd` 仓库根 + `source .env` + `exec` 二进制 |
| `scripts/selfhost/com.fengzhao.multica-{frontend,backend}.plist` | launchd job（`RunAtLoad`+`KeepAlive{SuccessfulExit:false}`） |
| `scripts/selfhost/install.sh` | 一键：构建后端二进制 + standalone 前端 + 装 plist + `launchctl bootstrap` |

一键安装：

```bash
bash scripts/selfhost/install.sh
```

## 五个必须记住的坑

1. **`multica daemon` ≠ HTTP 后端**。daemon 只管 agent runtime；`/api`、`/uploads` 由 `cmd/server` 提供。后端没起就 502。
2. **launchd 的 `PATH` 必须显式写 node/nvm 路径**（plist 的 `EnvironmentVariables.PATH`）。launchd 默认 PATH 找不到 node。
3. **后端 cwd 必须是仓库根**。`LOCAL_UPLOAD_DIR` 默认 `./data/uploads`（相对 cwd），从别的目录起 → 头像/附件全部 404（就是「头像消失」的同源坑）。`run-backend.sh` 用 `cd /Users/fengzhao/multica` 兜住。
4. **`go run`/launchd 不读 `.env`**。后端 wrapper 必须 `set -a; source .env; set +a` 注入 `PORT`/`DATABASE_URL`，否则端口错、连不上 DB。
5. **rewrite 的 `REMOTE_API_URL` 是 build-time 烤进 manifest 的**。构建 standalone 时必须设 `REMOTE_API_URL=http://localhost:8081`，否则 `/api`、`/uploads` rewrite 打到错误目标。

## 端到端验证

```bash
# 两个 launchd job 在跑
launchctl list | grep multica
# 端口监听
lsof -nP -iTCP:3001 -sTCP:LISTEN ; lsof -nP -iTCP:8081 -sTCP:LISTEN
# 头像链路（核心）：本地三段 + caddy 入口都要 200
curl -I http://localhost:8081/uploads/workspaces/<ws>/<file>.png   # 后端直连
curl -I http://localhost:3001/uploads/workspaces/<ws>/<file>.png   # 经 frontend rewrite
curl -I -H "Host: multica.aicake.com" http://localhost:8097/uploads/workspaces/<ws>/<file>.png  # caddy 入口
# 崩溃自愈
kill -TERM $(launchctl list | awk '/com.fengzhao.multica-frontend/{print $1}')  # launchd 应自动拉起
```

公网回归：未登录访问 `https://multica.aicake.com/` 应回到 IdP 登录页（本实例为飞书 OAuth，HTTP 302）——**502 消失即代表基础设施恢复**；登录后 agent 头像恢复真实图片。

## 回滚

```bash
for l in frontend backend; do launchctl bootout gui/$(id -u)/com.fengzhao.multica-$l; done
# 回到手动：pnpm dev:web  +  set -a; source .env; set +a; go run ./cmd/server
```

## 相邻优化（未做，按需）

`/opt/homebrew/etc/Caddyfile` 的 `multica.aicake.com:8097` 块按 `SELF_HOSTING_ADVANCED.md:274-322` 建议：把 `handle /ws*`（会误匹配 `/ws-foo` workspace slug）改成 `@multica_ws { path /ws /ws/* }`，并给 ws 反代块加 `flush_interval -1`（避免 WS 帧被 Caddy flush 窗口拖住）。改后 `caddy reload --config /opt/homebrew/etc/Caddyfile`。

## 参考

- `apps/web/next.config.ts:28`（STANDALONE 条件）、`apps/web/config/runtime-urls.ts`（rewrite 目标解析）
- `Dockerfile.web`（standalone 构建范本）、`Makefile` `build-prod`
- `~/Library/LaunchAgents/com.fengzhao.hermes-serve.plist`（plist 范本）、`/opt/homebrew/etc/Caddyfile`（反代配置）、`~/.cloudflared/config.yml`（tunnel ingress）
