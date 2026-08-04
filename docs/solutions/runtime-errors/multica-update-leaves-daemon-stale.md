---
title: "`multica update` does NOT auto-restart the daemon — running process keeps the OLD binary in memory"
date: 2026-08-04
category: "runtime-errors"
module: "cli/daemon"
problem_type: "runtime_error"
component: "tooling"
severity: "medium"
symptoms:
  - "`multica update` prints \"Update complete\" and exits zero, but the daemon is not restarted"
  - "`multica daemon status` reports the OLD Version (0.4.16) against a long-uptime PID (75396, uptime 23h38m) after the upgrade"
  - "`multica --version` reports the NEW version (0.4.17) because it resolves the just-updated symlink, masking the stale daemon"
  - "`ls -la /opt/homebrew/bin/multica` shows the symlink already repointed to `../Cellar/multica/0.4.17/bin/multica`"
  - "`ps` shows the daemon as `multica daemon start --foreground` with PPID=1 (launchd-supervised, loaded before the upgrade)"
root_cause: "incomplete_setup"
resolution_type: "workflow_improvement"
related_components:
  - "multica-daemon"
  - "homebrew"
  - "launchd"
tags: [multica-cli, daemon, multica-update, brew-upgrade, launchd, stale-process, self-hosted, upgrade-sop]
---

# `multica update` does NOT auto-restart the daemon — running process keeps the OLD binary in memory

## Problem

`multica update` reports "Update complete" and exits zero, but the long-running daemon process keeps executing the OLD binary in memory. The upgrade looks done — the Homebrew symlink is repointed, `multica --version` reports the new release — while the daemon is silently stale: same PID, same uptime, same self-reported `Version:` field as before the upgrade. The only way the daemon actually picks up the new binary is a separate `multica daemon restart`; without it, every `multica daemon status` check after `multica update` will show the pre-upgrade version indefinitely.

## Symptoms

All five symptoms observed during the 2026-08-04 v0.4.16 → v0.4.17 upgrade on this host, each grounded in a verifiable command:

- **`multica update` printed "Update complete" and exited successfully**, yet the daemon process was untouched. The auto-memory entry (`project_daemon_upgrade.md`, Claude Code auto-memory at `~/.claude/projects/-Users-fengzhao-multica/memory/`, outside the repo tree) records the exact wording: *"`multica update` invokes `brew upgrade multica` which updates the binary symlink (e.g. `multica/0.4.17/bin/multica`) and prints 'Update complete' — but the running daemon process (PPID=1, started before the upgrade) keeps executing the OLD binary in memory."* The "Update complete" message is a positive confirmation that strongly implies the whole upgrade — including the daemon — is done. It is not.

- **The Homebrew symlink was already repointed to the new version.** Immediately after `multica update`, `ls -la /opt/homebrew/bin/multica` returned a symlink whose target is the new 0.4.17 Cellar binary (resolved path: `/opt/homebrew/Cellar/multica/0.4.17/bin/multica`):
  ```
  lrwxr-xr-x@ 1 fengzhao  staff  4 Aug 09:47 /opt/homebrew/bin/multica -> ../Cellar/multica/0.4.17/bin/multica
  ```
  The on-disk binary the symlink resolves to is 0.4.17. This is real progress, but it is a *filesystem* change, not a *process* change.

- **`multica --version` reported the NEW version**, reinforcing the false all-green impression:
  ```
  multica 0.4.17 (commit: 6b56bc05a, built: 2026-08-03T10:18:07Z)
  go: go1.26.1, os/arch: darwin/arm64
  ```
  `multica --version` exec's the symlink-resolved binary and reports what *that binary* would print — not what the already-running daemon process is executing. So the CLI binary and the running daemon can (and here, did) report different versions.

- **`multica daemon status` reported the OLD Version against a long-uptime PID.** Before the manual restart, status showed `Version: 0.4.16`, PID 75396, uptime 23h38m — i.e. the running daemon predated the upgrade by ~23.5 hours and was still executing the 0.4.16 process image. The auto-memory (`project_daemon_upgrade.md`) records the transition: *"0.4.16→0.4.17 on 2026-08-04 (binary symlink updated by `multica update`, daemon restart manually triggered PID 75396→94172)."*

- **`ps` confirmed the daemon is a long-running, launchd-supervised process.** Before the restart, `ps -eo pid,ppid,etime,command | grep 'multica daemon'` showed the daemon as `multica daemon start --foreground` with **PPID=1** and uptime in the hours — i.e. orphaned to launchd / self-managed, not a child of any shell whose exit would have recycled it. After the manual restart the same command now returns:
  ```
  94172     1       44:22 /opt/homebrew/bin/multica daemon start --foreground
  ```
  New PID, PPID still 1, uptime reset to minutes — confirming the restart took effect but the process model (PPID=1, `--foreground`) is unchanged.

## What Didn't Work

Three failed reasoning paths during this upgrade, written down so the next upgrade skips them:

- **Trusting `multica update`'s "Update complete" message as proof the daemon was restarted.** The message only confirms that the underlying `brew upgrade multica` succeeded and the symlink was repointed — it says nothing about the running daemon process. The daemon PID (75396) and uptime (23h38m) were byte-identical before and after `multica update`. "Update complete" describes the *binary on disk*, not the *process in memory*.

- **Assuming the daemon process would pick up the new binary on the next request, next tick, or next websocket reconnect.** It does not. The daemon's process image is loaded once at `execve` time and held in the process's address space thereafter; nothing in the daemon's event loop re-execs the binary. Swapping the file on disk has zero effect on the code the running process executes. The daemon would have stayed on 0.4.16 forever without an explicit restart — there is no lazy/self-healing path.

- **Checking only `multica --version` to verify the upgrade.** `multica --version` resolves the symlink (`/opt/homebrew/bin/multica → Cellar/multica/0.4.17/bin/multica`) and reports the binary it would exec *now* (0.4.17), not the version the already-running daemon process is executing (0.4.16). Used alone, `multica --version` gives a clean "upgraded" signal while the daemon is stale. The CLI binary and the running daemon are two different things; only `multica daemon status`'s `Version:` field reports the latter.

## Solution

Run `multica daemon restart` after every `multica update`, then verify with **both** `multica daemon status` (Version field) **and** `ps -p <pid> -o etime` (uptime reset). The exact sequence observed this session (2026-08-04, v0.4.16 → v0.4.17):

```sh
multica update                 # brew upgrade multica; prints "Update complete"; symlink -> 0.4.17
multica daemon restart         # stops old PID 75396, starts new PID 94172 (PPID still 1)
multica daemon status          # Version: 0.4.17, pid 94172, uptime resets to seconds
```

After the manual restart, the three verification commands converged on 0.4.17:

- `multica daemon status`:
  ```
  Daemon:      running (pid 94172, uptime 44m20s)
  Version:     0.4.17
  Agents:      codex, opencode, openclaw, hermes, claude
  Workspaces:  5
  ```
- `ps -eo pid,ppid,etime,command | grep 'multica daemon' | grep -v grep`:
  ```
  94172     1       44:22 /opt/homebrew/bin/multica daemon start --foreground
  ```
- `multica --version`:
  ```
  multica 0.4.17 (commit: 6b56bc05a, built: 2026-08-03T10:18:07Z)
  ```

The recorded transition: **old PID 75396 (uptime 23h38m, `Version: 0.4.16`) → new PID 94172 (uptime ~10s at the restart moment, `Version: 0.4.17`)**. The uptime reset from hours to seconds is the load-bearing signal that the restart actually happened — the Version field alone could (in principle) be spoofed by a reporting bug, but a fresh uptime cannot lie.

Do **not** substitute `brew upgrade multica` for `multica update` to "bypass" the issue — `multica update` is a thin wrapper around `brew upgrade multica` and has exactly the same gap (`brew info multica` confirms the formula source: `From: https://github.com/multica-ai/homebrew-tap/blob/HEAD/Formula/multica.rb`, `stable 0.4.17`). Either entry point leaves the daemon restart as a separate required step.

## Why This Works

Root cause, pinned to the actual mechanism on this host:

- **`multica update` is a Homebrew symlink swap, nothing more.** `multica update` internally runs `brew upgrade multica`; `brew info multica` returns `==> multica-ai/tap/multica: stable 0.4.17` / `Installed (on request)` / `From: https://github.com/multica-ai/homebrew-tap/blob/HEAD/Formula/multica.rb`. Homebrew's upgrade repoints the versioned symlink — `ls -la /opt/homebrew/bin/multica` now resolves to `../Cellar/multica/0.4.17/bin/multica` — and installs the new Cellar version dir. That is the entirety of what `multica update` does to the daemon's binary. It swaps a filesystem path; it does not signal any running process.

- **The daemon is a long-running process whose image was loaded once, at start.** The daemon was launched at some earlier point by `multica daemon start --foreground` and is now PPID=1 — orphaned to launchd / self-managed by the CLI's own `daemon` subcommand, as documented in the auto-memory (`project_daemon_upgrade.md`: *"running as `multica daemon start --foreground` with PPID=1 (orphaned/self-managed, not one of the two repo-built launchd jobs backend/frontend)"*). Its process image — the actual machine code the kernel mapped into its address space at `execve` — is the OLD 0.4.16 binary.

- **Unix process semantics: replacing the file on disk does NOT replace a running process's in-memory image.** The kernel keeps the old vnode readable to the running process even after the symlink is repointed (Homebrew also retains the old Cellar version dir until no process holds it). The process keeps executing the old code until something `exec`s a new binary *into* it — which, for a long-running foreground process, means stopping it and starting a new process. There is no in-place "reload binary" syscall.

- **`multica daemon restart` is the only path that exec's the new binary into the daemon.** The CLI's built-in `daemon restart` subcommand stops the old PID and starts a new process that exec's the (now-0.4.17) symlink-resolved binary. The auto-memory (`project_daemon_upgrade.md`) records the same semantics from the earlier 0.4.9→0.4.11 upgrade: *"the CLI's `daemon` command self-manages the process (it had stopped pid + started new pid, new proc still PPID=1). Do NOT manually kill + nohup; use the built-in `daemon restart`/`stop`/`start`/`status`."* This is why the new PID 94172 still has PPID=1 — the CLI re-orphaned it to launchd, exactly as designed.

- **Contrast with the repo-built backend/frontend, which is why this gap is specific to the daemon.** The repo-built `cmd/server` backend and the Next.js standalone frontend run as launchd jobs `com.fengzhao.multica-backend` / `com.fengzhao.multica-frontend`, and they ARE restarted by `scripts/selfhost/install.sh` (which does `launchctl bootout` + `bootstrap`, per `docs/solutions/runtime-errors/caddy-standalone-launchd.md`) or by `launchctl kickstart gui/$(id -u)/...` (per `docs/solutions/workflow-issues/self-host-service-start-without-docker.md`'s production restart note). The Homebrew-CLI daemon is a *third*, independent process with its own lifecycle — `install.sh` does not touch it, `launchctl kickstart` does not target it (there is no `com.fengzhao.multica-daemon` plist that manages the daemon process; the only daemon-related LaunchAgent on this host is a separate weekly log-rotation helper `com.fengzhao.multica-daemon-rotate` that runs `~/.hermes/scripts/multica-daemon-logrotate.sh` and does NOT supervise the daemon process), and `multica update` does not restart it. The daemon orphaned itself to PID 1 via the CLI's own double-fork at start; it is not a launchd-registered job, so launchd's KeepAlive (crash-recovery) does not help on a clean upgrade. That three-way independence is the structural reason the gap exists: every other component has a restart step somewhere in the SOP, but the daemon's restart lives only in the CLI's `daemon restart` subcommand, which no SOP step invokes unless explicitly added.

## Prevention

- **Add `multica daemon restart` as an explicit, separately-checked step in every upgrade SOP**, positioned AFTER `multica update` and BEFORE the post-deploy health-check. The v0.4.17 upgrade plan's Phase 6 post-deploy verification is where this gap was caught on this upgrade — move that detection upstream by making the restart a *step*, not a *discovery*. One line in the SOP eliminates the failure mode entirely.
- **Always verify `multica daemon status` shows the expected `Version:` field AND a fresh uptime.** Uptime in seconds or minutes = recently restarted; uptime in hours = stale. The uptime reset (23h38m → 10s on this upgrade) is the most reliable signal, because a fresh uptime cannot be faked by a reporting bug the way a Version string could.
- **Cross-check `multica --version` against `multica daemon status`'s `Version:` field.** `multica --version` reports the symlink binary the CLI would exec; `multica daemon status`'s `Version:` reports the running daemon's self-reported version. If they differ, the daemon is stale — run `multica daemon restart`. On this upgrade they diverged before the restart (CLI 0.4.17 vs daemon 0.4.16) and converged after (both 0.4.17). This cross-check is cheap and catches the exact gap.
- **Do NOT rely on `multica update`'s "Update complete" message alone.** That message only confirms the Homebrew symlink swap, not a daemon restart. Treat it as "binary on disk updated, daemon process still stale" until `multica daemon status` proves otherwise. The message is true; it is just not sufficient.
- **Do NOT manually `kill` + `nohup` the daemon.** The CLI's `daemon restart`/`stop`/`start`/`status` subcommands are the supported lifecycle API (auto-memory `project_daemon_upgrade.md`); manual kill+nohup bypasses the CLI's PID tracking and can leave the daemon's self-managed state inconsistent. Always go through `multica daemon restart`.

## Related Issues

- **auto-memory `project_daemon_upgrade.md`** (Claude Code auto-memory at `~/.claude/projects/-Users-fengzhao-multica/memory/`, outside the repo tree) — the umbrella daemon-upgrade memory; updated 2026-08-04 with the `multica update` gap warning and the PID 75396→94172 / 0.4.16→0.4.17 transition record. This doc is the long-form prose expansion of that memory's gap warning.
- `docs/solutions/workflow-issues/install-sh-upgrade-reload-defects.md` — **strongest pattern-family sibling**. Same root-cause family verbatim ("the old process keeps running the old binary's in-memory image" after a file/binary replacement that doesn't restart the running process), same prevention pattern ("always curl /api/config and assert server_version equals target tag — do not trust a 200 /healthz alone"). Different component (launchd plist jobs for backend/frontend vs the daemon CLI process) and different recovery command (`launchctl bootstrap`+start vs `multica daemon restart`). This doc is the daemon-specific instance of that family.
- `docs/solutions/architecture-patterns/daemon-cli-version-drift-detection.md` — **detection-side companion**. Documents that the daemon upgrades via Homebrew on the operator's cadence and daemon-lagging is a known 502/protocol-mismatch cause (references `brew upgrade multica`). Covers Help-menu DETECTION only; this runtime-errors doc closes the detect→recover loop by documenting the RECOVERY step (`multica daemon restart`).
- `docs/solutions/workflow-issues/self-host-service-start-without-docker.md` — launchd-supervised services runbook for the same host; documents that the daemon is separate from the repo-built backend/frontend and that `install.sh`/`launchctl kickstart` are the restart path for the backend/frontend pair (not the daemon).
- `docs/solutions/runtime-errors/caddy-standalone-launchd.md` — sibling launchd-supervised runtime error; documents the standalone+launchd production topology and the three independent process lifecycles (backend `com.fengzhao.multica-backend`, frontend `com.fengzhao.multica-frontend`, daemon PPID=1) whose independence is the structural root cause here. Note: even though launchd supervises `multica daemon`, `brew upgrade`/`multica update` swaps the on-disk binary without restarting the running process image, so launchd's KeepAlive (crash-recovery) does not help on a clean upgrade — `multica daemon restart` is still required.
- `docs/upgrades/v0.4.17-plan.md` — the upgrade plan where this gap was hit; Phase 6 post-deploy verification caught the stale daemon after `multica update` had already reported "Update complete".
- `docs/solutions/workflow-issues/version-reporting-after-upstream-upgrade.md` — adjacent "verify the *running* version, not the *built* version" theme for a different component (repo-built backend `-ldflags` version stamp). Same diagnostic shape: the version number you see depends on which process you ask, and the easy-to-check one can lie.
- **GitHub issue [#6332](https://github.com/multica-ai/multica/issues/6332)** — adjacent (not duplicate). Concerns the daemon binary-replacement machinery in the opposite direction: a server-triggered runtime update replaces the CLI binary even when auto-update is disabled. Both touch the same daemon binary-lifecycle code paths; cited for upstream context on how the daemon's binary gets swapped.