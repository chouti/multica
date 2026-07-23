---
title: "install.sh is unsafe for upgrade reload — doesn't source .env (version stamp defaults) and launchctl bootstrap doesn't restart a running process"
date: 2026-07-23
module: "self-host-operations"
problem_type: "workflow_issue"
component: "deployment_workflow"
severity: "high"
applies_when:
  - "Reloading the self-host Multica frontend/backend after an upstream upgrade on this launchd host"
  - "Running `bash scripts/selfhost/install.sh` expecting it to rebuild + restart with the new release version"
  - "Stamping the release version (NEXT_PUBLIC_APP_VERSION / -ldflags main.version) during an upgrade"
symptoms:
  - "After install.sh, `curl /api/config` still returns the old `server_version` (e.g. v0.4.6 instead of v0.4.8)"
  - "`launchctl bootstrap` errors `Load failed: 5: Input/output error` on an already-loaded plist, yet install.sh prints `loaded com.fengzhao.multica-*`"
  - "After install.sh, a job shows pid `-` in `launchctl list` (not running) — prod down"
  - "`launchctl kickstart` returns `Could not find service ... in domain` for a job install.sh claims it loaded"
tags: [self-host, launchd, install-sh, version-stamp, upgrade-reload, provenance]
---

# install.sh is unsafe for upgrade reload

## Problem
`scripts/selfhost/install.sh` rebuilds the frontend standalone + backend binary, but does **not** reliably reload them after an upgrade. Two independent defects each caused a brief production outage during the v0.4.3→v0.4.6→v0.4.8 upgrade arc (2026-07-23): a wrong version stamp and a non-restart.

## What Didn't Work
- **Bare `bash scripts/selfhost/install.sh`** (expecting rebuild + restart): `server_version` stayed `v0.4.6` after a v0.4.8 upgrade — the new code was built but the stamp and the running process were both wrong.
- **`launchctl kickstart gui/$UID/com.fengzhao.multica-frontend`**: returned `Could not find service … in domain` for a job install.sh had just printed `loaded`.
- **Trusting install.sh's `loaded com.fengzhao.multica-*` output**: the jobs were not actually running (`launchctl list` showed pid `-`).

## Solution (verified working on the v0.4.8 upgrade)
Do not run install.sh bare for an upgrade reload. Use the manual flow:

```bash
cd /Users/fengzhao/multica
# 1. Put the version into the environment — install.sh reads $NEXT_PUBLIC_APP_VERSION, it does NOT source .env
set -a; source .env; set +a        # NEXT_PUBLIC_APP_VERSION=v0.4.8
# 2. Manually build the backend binary with the ldflags stamp
CGO_ENABLED=0 go build -C server -ldflags "-s -w -X main.version=$NEXT_PUBLIC_APP_VERSION" \
  -o ~/.multica/backend/server ./cmd/server
# 3. install.sh ONLY to rebuild the frontend standalone (its plist reload is unreliable; ignore plist errors)
bash scripts/selfhost/install.sh
# 4. Restart: if a job got bootout'd (pid '-' in launchctl list), bootstrap + start it
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.fengzhao.multica-backend.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.fengzhao.multica-frontend.plist
launchctl start com.fengzhao.multica-backend
launchctl start com.fengzhao.multica-frontend
# 5. VERIFY the version actually flipped before declaring done
curl -s http://localhost:8081/api/config | grep -oE '"server_version":"[^"]*"'   # expect v0.4.8
```

## Why This Works (root cause of each defect)

1. **install.sh does not source .env.** `scripts/selfhost/install.sh` reads `VERSION="${NEXT_PUBLIC_APP_VERSION:-v0.4.6}"` (the **environment variable**) and builds the backend with `go build -ldflags "-s -w -X main.version=${VERSION}"`. Running it bare leaves `.env` unsourced, so `VERSION` defaults to `v0.4.6` and both the backend binary and the frontend standalone get stamped `v0.4.6` even when `.env` already says `v0.4.8`. `set -a; source .env; set +a` first puts the value into the environment.

2. **`launchctl bootstrap` does not restart a running process.** install.sh uses `launchctl bootstrap` (load plist). On an already-loaded plist it errors `Load failed: 5` and does **not** restart the process — so a freshly rebuilt binary never takes effect; the old process keeps running the old binary's in-memory image and `server_version` is unchanged. `launchctl start`/`kickstart` restart a loaded job; if install.sh bootout'd the job (plist unloaded), recover with `launchctl bootstrap + start`.

The wrong stamp is **hard to notice** because the provenance customization (`officialBaseline`) maps only `"dev"` and git-describe `-N-g` suffixes to `""` — a clean but stale tag like `v0.4.6` is returned verbatim, so `/api/config` shows a version (not missing), just the wrong one. See `version-reporting-after-upstream-upgrade.md`.

## Prevention
- Never run install.sh bare for an upgrade reload; use the manual flow above.
- After any reload, **always** `curl /api/config` and assert `server_version` equals the target tag — do not trust install.sh's `loaded` output or a `200 /healthz` alone (healthz is 200 even on the old binary).
- Long-term fix for install.sh (own PR, mindful of upgrade-merge conflict): (1) source `.env` internally (`set -a; . ./.env; set +a`); (2) replace the `launchctl bootstrap` reload with `kickstart` (loaded) or `bootout` + `bootstrap` (unloaded).

## Related
- `docs/solutions/workflow-issues/self-host-service-start-without-docker.md` — bare-process start/stop on this host (no Docker/pm2)
- `docs/solutions/workflow-issues/version-reporting-after-upstream-upgrade.md` — the two version-stamp injection points this defect corrupts
- `docs/solutions/workflow-issues/safe-upstream-upgrade-with-local-customizations.md` — the upgrade SOP whose Step 8 restart needs this correction
- `docs/solutions/runtime-errors/caddy-standalone-launchd.md` — the launchd topology (cloudflared→caddy→:3001/:8081)
