---
title: "Self-host 整站 502 + agent 头像静默回退：standalone 前端 + launchd 常驻"
date: 2026-07-22
category: runtime-errors
module: self-host deployment
problem_type: runtime_error
component: tooling
symptoms:
  - "公网域名整站 502 Bad Gateway（caddy 反代到 :3001/:8081 无监听，后端手动进程重启即丢）"
  - "agent 头像静默回退成 lucide-bot 图标（actor-avatar.tsx onError 分支；后端 cwd 错致 data/uploads 404）"
root_cause: incomplete_setup
resolution_type: environment_setup
severity: high
related_components:
  - caddy
  - cloudflared
  - launchd
  - next-standalone-build
  - multica-daemon
tags:
  - self-host
  - launchd
  - standalone
  - caddy
  - cloudflared
  - 502
  - process-supervision
---

# Self-host 整站 502 + agent 头像静默回退：standalone 前端 + launchd 常驻后端

## Problem

公网域名 `https://multica.aicake.com/` 整站返回 **502 Bad Gateway**；更早阶段 agent 头像**静默回退成 `lucide-bot` 图标**（右下角在线状态点正常，说明 API 数据链路是通的，只有 `/uploads` 图片链路断）。两者同源：本机反代拓扑里 `:3001`（前端）和 `:8081`（后端）都是**手动进程**，重启 Mac 或关终端即丢；而 launchd 只托管了 `caddy` / `cloudflared` / `multica daemon`，没有托管真正提供 `/api` 与 `/uploads` 的 `cmd/server`。

反代拓扑（本机）：

```
浏览器 https://multica.aicake.com/
  → cloudflared tunnel (~/.cloudflared/config.yml: multica.aicake.com → http://localhost:8097)
  → caddy :8097  (/opt/homebrew/etc/Caddyfile:54-87)
       @multica_ws { /ws, /ws/* }  → reverse_proxy 127.0.0.1:8081   (后端, flush_interval -1)
       其他所有路径               → reverse_proxy 127.0.0.1:3001   (Next.js standalone)
  → Next.js 再把 /api、/uploads、/auth、/ws 经 afterFiles rewrite 转发到 127.0.0.1:8081
```

## Symptoms

- 公网 `https://multica.aicake.com/` 全站 **502 Bad Gateway**（caddy 反代到的 `:3001`/`:8081` 端口无监听）。
- agent 头像静默变成机器人图标：`packages/ui/components/common/actor-avatar.tsx:57-63` 在 `avatarUrl && !imgError` 为真时渲染 `<img>`，`onError` 只 `setImgError(true)`，无 `console.error`、无上报 → 回退到 `:67` 的 `<Bot />`。右下角 status 点正常（API 数据通），仅 `/uploads` 图片 404。
- `lsof -nP -iTCP:3001 -sTCP:LISTEN` 或 `:8081` 查不到监听进程（手动进程已被杀/重启丢失）。
- `launchctl list | grep multica` 只看到 `multica daemon`（端口 `19514`），没有 frontend/backend job。

## What Didn't Work

排查过程的弯路（写出来是为了下次别再走）：

1. **误以为 `multica daemon`(:19514) 是 HTTP 后端**。`19514` 确实是个 HTTP 端口，会响应健康检查，所以「curl 通」极具迷惑性；但 `server/internal/daemon/config.go:66` 把它定义为 `DefaultHealthPort = 19514`（`HealthPort` 字段，`// local HTTP port for health checks`），daemon 只管 agent runtime，**不提供 `/api`、`/uploads`**。后端 HTTP API 由 `cmd/server` 提供，端口来自 `server/cmd/server/main.go:193-196` 的 `os.Getenv("PORT")`（默认 `8080`，本实例 `.env` 里 `PORT=8081` 才落到 `:8081`）。把 daemon 当后端查半天，路径完全错。

2. **误把端口 `18800` 当前端**。`:18800` 实际是本机一个不相关的 MemOS 服务，不是 Multica 前端；前端真正监听的是 `:3001`。靠「扫到一个监听端口就认」会指错组件。

3. **`curl http://localhost:8081/...` 的时序偏差**。手动起的后端进程在被 kill/重启的瞬间，`curl` 探测会拿到误导性结果（刚死的端口 refused、新进程还没 bind、或 TIME-WAIT 残留），一度让人误判「后端是好的」。结论：手动进程不可靠，不能拿单次 curl 当结论，必须看 `lsof ... LISTEN` + launchd 是否托管。

4. **以为头像问题是前端 bug**。一度怀疑 `actor-avatar.tsx` 的回退逻辑本身有问题；实际上回退逻辑正确，是上游 `/uploads/*.png` 真的 404。回退分支「静默」是设计如此（`onError` 只翻状态位），不是缺陷——但它的副作用是**把基础设施故障伪装成 UI 状态**，拉长了定位时间。

5. **以为 `pnpm dev:web`（next dev）能当生产常驻**。dev server 重启即丢、无 `output: "standalone"` 的自包含产物，且与 launchd 的 `KeepAlive` 语义不合。dev 不是生产。

6. **改 Caddyfile 用 `handle /ws*`**。通配 `/ws*` 会误匹配形如 `/ws-foo` 的 workspace slug 路由（workspace slug 是动态段），改用显式 `@multica_ws { path /ws /ws/* }` 才精确（见 `/opt/homebrew/etc/Caddyfile:62-67`）。

## Solution

把前端换成 **standalone 生产构建**、前后端都交给 **launchd 常驻**，全部脚本版本化在 `scripts/selfhost/`（self-host fork 本地 commit `890ac42d8` `feat(selfhost): standalone frontend + launchd autostart for web/backend`，已合并本地 `main`；无对应 upstream PR）。

**1) standalone 前端构建**（`scripts/selfhost/build-frontend.sh`）：

```bash
export STANDALONE=true
export REMOTE_API_URL="${REMOTE_API_URL:-http://localhost:8081}"
pnpm --filter @multica/web build
# 按 Dockerfile.web 布局把 .next/standalone 组装到 ~/.multica/frontend，
# 并补 .next/static 与 public/（standalone 不 trace 这两者）
```

选 standalone 的依据：`apps/web/next.config.ts:28` 是 `process.env.STANDALONE === "true" ? { output: "standalone" } : {}` 条件输出。static export 被 middleware（`apps/web/proxy.ts`）、SSR `headers()/cookies()`、ISR `revalidate` 否决，故不走 static、也不走 `next start`。

**2) 后端二进制**（`scripts/selfhost/install.sh`）：

```bash
cd "$REPO/server"
CGO_ENABLED=0 go build -ldflags "-s -w -X main.version=${VERSION}" \
  -o "$MULTICA_HOME/backend/server" ./cmd/server
```

`-X main.version=` 是 version-stamp（升级后必须 re-stamp，否则 Help 菜单版本号缺失/陈旧，见 [[version-reporting-after-upstream-upgrade]]）。

**3) launchd wrapper 解决 cwd + .env 两个坑**（`scripts/selfhost/run-backend.sh`）：

```bash
REPO="/Users/fengzhao/multica"
cd "$REPO"                 # ① LOCAL_UPLOAD_DIR 默认 ./data/uploads，相对 cwd
set -a; . ./.env; set +a   # ② go run / launchd 都不读 .env
exec "$HOME/.multica/backend/server"
```

**4) launchd plist**（`scripts/selfhost/com.fengzhao.multica-{frontend,backend}.plist`）：`RunAtLoad=true` + `KeepAlive{SuccessfulExit:false}`（崩溃非零退出自动拉起）。frontend plist 显式写绝对 node 路径 `/Users/fengzhao/.nvm/versions/node/v24.15.0/bin/node` + `EnvironmentVariables.PATH`（launchd 默认 PATH 找不到 nvm 的 node）。

**5) Caddyfile `/ws` 精确匹配**（`/opt/homebrew/etc/Caddyfile:62-75`，主机级配置、不在本仓库版本控制内）：`@multica_ws { path /ws /ws/* }` + `flush_interval -1`（禁用 Caddy flush 缓冲，避免 WS 帧延迟）。改完 `caddy reload --config /opt/homebrew/etc/Caddyfile`。

**6) 一键**：`bash scripts/selfhost/install.sh`（幂等：重建二进制 + standalone、重装 plist、`launchctl bootout` 再 `bootstrap`）。

## Why This Works

钉到源码的机制解释：

- **头像相对路径为什么靠 rewrite 就能通**：`server/internal/storage/local.go:149-153` 的 `Upload` 在 `LOCAL_UPLOAD_BASE_URL` 为空时返回站点相对路径 `/uploads/<key>`（本实例未设该 env，DB 里 81 个 agent 中 77 个有头像且全是相对路径（其余 4 个无头像））。前端 `packages/core/workspace/avatar-url.ts:3-12` 的 `resolvePublicFileUrlWithBase` 只在 URL 以 `/` 开头时拼 `baseUrl`，而 `.env` 里 `NEXT_PUBLIC_API_URL=` 为空 → `api.getBaseUrl()` 返回空 → 相对路径**原样返回 `/uploads/...`**。于是 `<img src="/uploads/x">` 走浏览器同源请求 → caddy → 前端 `:3001` → Next afterFiles rewrite（`apps/web/next.config.ts:65-67`，`/uploads/:path*` → `${remoteApiUrl}/uploads/:path*`）→ 后端 `:8081`。所以只要后端在、cwd 对、rewrite 目标对，头像就通。后端 cwd 错时 `data/uploads` 读不到 → `server/internal/handler/file.go:782-796` 的 `ServeLocalUpload` 找不到文件 → 404 → `actor-avatar.tsx:62` `onError` → Bot。

- **`REMOTE_API_URL` 是 build-time 烤进 manifest 的**：`apps/web/next.config.ts:10` 在 config 求值期调用 `resolveRemoteApiUrl(process.env)`（`apps/web/config/runtime-urls.ts:3-17`，优先级 `REMOTE_API_URL` > `NEXT_PUBLIC_API_URL` > 端口 env > `localhost:8080`），其返回值写进 routes manifest，**运行时不再读 env**。因此 standalone 构建时若没设 `REMOTE_API_URL=http://localhost:8081`，rewrite 会落到默认 `localhost:8080` → 全站 API/uploads 打空。`.env` 里已显式 `REMOTE_API_URL=http://localhost:8081`。

- **后端端口为什么是 `:8081` 而不是默认 `:8080`**：`server/cmd/server/main.go:193-196` 读 `PORT` env，**默认 `8080`**。本实例靠 `.env` 的 `PORT=8081` 才落到 `:8081`。`go run`/launchd 都不读 `.env`，所以不 `source .env` 就会 bind `:8080`，而 caddy/rewrite 都指向 `:8081` → 连接拒绝 → 502。`run-backend.sh` 的 `set -a; . ./.env; set +a` 正好兜住。

- **为什么 launchd 能自愈**：`KeepAlive{SuccessfulExit:false}` 表示「进程以非 0 退出码退出就重启」。验证：`kill -TERM` 前端 PID 后 launchd 自动拉起。

- **为什么 standalone 不与 `pnpm dev:web` 冲突**：standalone 产物是自包含的 `server.js` + traced `node_modules`，部署在 `~/.multica/frontend`，cwd 独立于仓库 dev 环境，端口 `:3001` 由 plist 的 `PORT=3001` 固定；dev server 走 `apps/web/.next`，两者物理隔离。

## Prevention

- **端口/进程先于业务排查**：502 第一步永远是 `lsof -nP -iTCP:{3001,8081} -sTCP:LISTEN` + `launchctl list | grep multica`，确认前端、后端、daemon 各自端口与托管状态。记住 daemon(:19514) 是健康端口、不是 API。
- **别让回退分支静默吞基础设施故障**：`actor-avatar.tsx` 的 `onError` 只翻状态、不记日志，会把 404 伪装成「该 agent 没头像」。生产 self-host 场景可在回退分支加一次受控的 `console.warn`（dev only）或在 `/uploads` 链路加可用性探针。注：这是后续可选改进，本次未改。
- **后端必须从仓库根 + source .env 启动**：任何启动路径（手动、launchd、systemd、脚本）都要保证 cwd = repo root（`LOCAL_UPLOAD_DIR` 默认 `./data/uploads`，相对 cwd，见 `server/internal/storage/local.go:39-43`）并注入 `.env`（PORT/DATABASE_URL/...）。`run-backend.sh` 是范本。
- **升级后 re-stamp**：upstream 升级后必须重跑 `build-frontend.sh`（带 `NEXT_PUBLIC_APP_VERSION`）+ 后端 `-ldflags -X main.version=`，否则版本号陈旧。
- **新增 self-host 脚本走 `scripts/selfhost/`**：按本仓库的 local customization workflow，self-host 专用脚本放 `scripts/selfhost/`，commit 用 `feat(selfhost): ...` 前缀；通用改动才提 upstream PR。
- **Caddyfile 改动不入仓库**：`/opt/homebrew/etc/Caddyfile` 是主机级配置，不在本仓库版本控制；改动需另行备份（如 dotfiles），`caddy reload` 后用 `curl -I -H "Host: multica.aicake.com" http://localhost:8097/...` 验证三段链路。

## 参考（代码位点）

- `apps/web/next.config.ts:28`（STANDALONE 条件）、`:10`（resolveRemoteApiUrl 求值）、`:51-68`（afterFiles rewrite）
- `apps/web/config/runtime-urls.ts:3-17`（REMOTE_API_URL 优先级）
- `packages/core/workspace/avatar-url.ts:3-12`（resolvePublicFileUrl，相对路径原样返回）
- `packages/ui/components/common/actor-avatar.tsx:57-67`（onError → Bot 静默回退）
- `server/cmd/server/main.go:193-196`（PORT env，默认 8080）
- `server/internal/storage/local.go:39-43`（LOCAL_UPLOAD_DIR 默认 ./data/uploads）、`:149-153`（Upload 返回相对 /uploads）
- `server/internal/handler/file.go:782-796`（ServeLocalUpload 剥 /uploads/ 前缀）
- `server/internal/daemon/config.go:66`（DefaultHealthPort=19514，健康端口非 API）
- `scripts/selfhost/{build-frontend.sh,run-backend.sh,install.sh,com.fengzhao.multica-{frontend,backend}.plist}`（self-host fork 本地 commit `890ac42d8`，无 upstream PR）
- `/opt/homebrew/etc/Caddyfile:54-87`（multica :8097 块；主机级，不在仓库）

## Related Issues

- `docs/solutions/workflow-issues/self-host-service-start-without-docker.md` — 同主机的 start/stop/migrate bare-process runbook；其「生产 → next start / go run」路径在常驻场景已被本文档的 standalone+launchd 取代，但 dev/test/migrate/临时起停仍适用。
- `docs/solutions/workflow-issues/safe-upstream-upgrade-with-local-customizations.md` — 升级 SOP Step 8「Restart services」；self-host 生产重启现走 `launchctl kickstart gui/$(id -u)/com.fengzhao.multica-{backend,frontend}` 或重跑 `scripts/selfhost/install.sh`。
- `docs/solutions/workflow-issues/version-reporting-after-upstream-upgrade.md` — launchd 下 `run-backend.sh` 必须 exec `-ldflags` 戳过版本号的二进制，否则「Backend unavailable」silent-failure 会在 launchd 托管下复现。
- `docs/solutions/runtime-errors/multica-update-leaves-daemon-stale.md` (added 2026-08-04) — `multica update` (Homebrew 符号链接交换) 不重启 daemon 进程；守护进程 (PPID=1, 无 plist, 不被 install.sh/kickstart 覆盖) 是本拓扑的第三个独立流程，需要单独 `multica daemon restart`。本文档只覆盖 backend + frontend 两个 launchd 作业；daemon 的升级 gap 在 companion runtime-errors doc。
