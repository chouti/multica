---
title: "install.sh is unsafe for upgrade reload — launchctl bootstrap does not restart a running process"
date: 2026-07-23
last_updated: 2026-07-28
module: "self-host-operations"
problem_type: "workflow_issue"
component: "deployment_workflow"
severity: "high"
applies_when:
  - "Reloading the self-host Multica frontend/backend after an upstream upgrade on this launchd host"
  - "Running `bash scripts/selfhost/install.sh` expecting it to rebuild + restart with the new release"
symptoms:
  - "`launchctl bootstrap` errors `Load failed: 5: Input/output error` on an already-loaded plist, yet install.sh prints `loaded com.fengzhao.multica-*`"
  - "After install.sh, a job shows pid `-` in `launchctl list` (not running) — prod down"
  - "`launchctl kickstart` returns `Could not find service ... in domain` for a job install.sh claims it loaded"
tags: [self-host, launchd, install-sh, upgrade-reload, provenance]
---

# install.sh is unsafe for upgrade reload (launchd reload only)

## Problem
`scripts/selfhost/install.sh` rebuilds the frontend standalone + backend binary, but does **not** reliably reload them after an upgrade. The reload path uses `launchctl bootstrap`, which on an already-loaded plist errors `Load failed: 5` and does **not** restart the running process — so a freshly rebuilt binary never takes effect; the old process keeps running the old binary's in-memory image.

Originally this doc also tracked a separate defect: install.sh did not source `.env`, so a bare run stamped the backend with the hardcoded `v0.4.6` fallback regardless of the checked-out tag. That defect was closed on 2026-07-27 (commit `9c1a9e1bb`) and is now superseded by the single-source approach in `version-reporting-after-upstream-upgrade.md` — install.sh derives VERSION from `resolve-official-baseline.sh` and exports NEXT_PUBLIC_APP_VERSION so `build-frontend.sh` inherits the same value.

## What Didn't Work
- **Bare `bash scripts/selfhost/install.sh`** (expecting rebuild + restart): the launchctl reload silently noop'd — `server_version` stayed at the old tag.
- **`launchctl kickstart gui/$UID/com.fengzhao.multica-frontend`**: returned `Could not find service … in domain` for a job install.sh had just printed `loaded`.
- **Trusting install.sh's `loaded com.fengzhao.multica-*` output**: the jobs were not actually running (`launchctl list` showed pid `-`).
- ~~Stamping from a stale `.env` file~~ — closed by `9c1a9e1bb`; install.sh now resolves VERSION from the git release tag, no manual `set -a; source .env` needed.

## Solution (verified working on the v0.4.12 upgrade)
Run install.sh for the rebuild, then manually reload the launchd jobs:

```bash
cd /Users/fengzhao/multica
# 1. Rebuild both halves with the resolved release tag (install.sh derives it
#    from resolve-official-baseline.sh; .env is no longer the version source).
bash scripts/selfhost/install.sh
# 2. Restart: if a job got bootout'd (pid '-' in launchctl list), bootstrap + start it
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.fengzhao.multica-backend.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.fengzhao.multica-frontend.plist
launchctl start com.fengzhao.multica-backend
launchctl start com.fengzhao.multica-frontend
# 3. VERIFY the version actually flipped before declaring done
curl -s http://localhost:8081/api/config | grep -oE '"server_version":"[^"]*"'   # expect v0.4.12
```

## Why This Works (root cause)

1. **`launchctl bootstrap` does not restart a running process.** install.sh uses `launchctl bootstrap` (load plist). On an already-loaded plist it errors `Load failed: 5` and does **not** restart the process — so a freshly rebuilt binary never takes effect. `launchctl start`/`kickstart` restart a loaded job; if install.sh bootout'd the job (plist unloaded), recover with `launchctl bootstrap + start`.

2. ~~**install.sh does not source `.env`** (closed).~~ Replaced with `resolve-official-baseline.sh`-driven VERSION derivation; see `version-reporting-after-upstream-upgrade.md` and `architecture-patterns/runtime-build-provenance.md`.

The wrong stamp was historically **hard to notice** because `officialBaseline` maps only `"dev"` and git-describe `-N-g` suffixes to `""` — a clean but stale tag returned verbatim, so `/api/config` showed a version (not missing), just the wrong one. That gotcha is closed by the resolver now; a stale stamp would manifest as a failure-to-resolve (exit 1), not a silently-wrong tag.

## Prevention
- After any install.sh run, **always** `curl /api/config` and assert `server_version` equals the target tag — do not trust install.sh's `loaded` output or a `200 /healthz` alone (healthz is 200 even on the old binary).
- If the version doesn't flip, the resolver failed (no upstream-verified tag reachable) — set `MULTICA_TRUSTED_BASELINE=vX.Y.Z` and re-run; do not weaken the sanitizer to "make it work."
- Long-term fix for the launchctl reload (out of scope for the version-stamping work): replace install.sh's `launchctl bootstrap` reload with `kickstart` (loaded) or `bootout` + `bootstrap` (unloaded).
