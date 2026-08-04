---
title: "Run self-host services without Docker or pm2 (bare-process substitutions for every Makefile target)"
date: 2026-07-22
last_updated: 2026-08-04
module: "self-host-operations"
problem_type: "workflow_issue"
component: "development_workflow"
severity: "medium"
applies_when:
  - "Running start/stop/test/migrate on a self-host Multica checkout that has Homebrew PostgreSQL on :5433 and no Docker engine"
  - "Upgrading a self-host fork where the umbrella SOP says `make start` / `make test` / `pm2 restart` and those commands are not usable on this host"
  - "Bringing the backend or frontend back up as bare processes after a crash, reboot, or upgrade"
  - "Taking a version-matched pg_dump backup of the :5433 database"
  - "Running `go test` on a host where `make test` is Docker-gated and therefore skipped"
symptoms:
  - "`make start` / `make test` / `make server` / `make dev` abort at `scripts/ensure-postgres.sh` with `docker: command not found`"
  - "`pm2 restart multica-backend multica-frontend` (upgrade SOP Step 8) fails because pm2's process table is empty on this host"
  - "`go run ./cmd/migrate up` without DATABASE_URL exported connects to the wrong host (localhost:5432) and hangs or fails"
  - "`pg_dump` on PATH aborts with a server/client major-version mismatch (16.x client vs 17.x server)"
root_cause: "missing_tooling"
resolution_type: "workflow_improvement"
related_components:
  - "database"
  - "tooling"
tags: [self-hosting, bare-process, docker-free, pm2-empty, makefile, homebrew-postgres, migrate, pg-dump, port-5433, upgrade-sop]
---

> **Updated 2026-08-04 (v0.4.17 audit):** this doc covers backend (:8081) and frontend (:3001) as the two `scripts/selfhost/install.sh`-supervised launchd jobs. It does **not** mention the third process on this host — the **Homebrew `multica` CLI daemon** (PPID=1, orphaned to launchd, no `com.fengzhao.multica-daemon` plist). That daemon has its own independent upgrade lifecycle: `multica update` runs `brew upgrade multica` and reports "Update complete" but does **not** restart the running daemon process. To restart the daemon, run `multica daemon restart`. See `docs/solutions/runtime-errors/multica-update-leaves-daemon-stale.md` for the full gap, `docs/solutions/architecture-patterns/daemon-cli-version-drift-detection.md` for the Help-menu drift row that surfaces the stale state. Bare-process commands above (`go run -C server ./cmd/server`, `pnpm -C apps/web exec next start`) cover backend/frontend; the daemon has no bare-process equivalent on this host — it is installed and managed exclusively via Homebrew + the CLI's `daemon start`/`stop`/`restart` subcommands.

# Run self-host services without Docker or pm2 (bare-process substitutions for every Makefile target)

## Context

This self-host Multica checkout lives on a host that does **not** match the developer-workstation model the repo's Makefile assumes. The Makefile's one-click targets (`start`, `test`, `server`, `dev`, `setup`, `migrate-up`) all funnel through `scripts/ensure-postgres.sh`, and that script's "local database" branch is Docker-only: it runs `docker compose up -d postgres` after deciding a `localhost` host means "use Docker". On this host `docker` is not installed at all (`docker: command not found`), so every one of those targets aborts before doing any real work. PostgreSQL here is Homebrew `postgresql@17` listening on **:5433**, not the `:5432` the Makefile defaults assume, and services are run as bare processes — not under Docker, and not under pm2.

Two facts make the standard commands fail in slightly different ways, both discovered during the v0.4.6 upgrade:

1. **`docker` is absent.** `make start`, `make test`, `make server`, `make setup`, `make migrate-up`, and `make dev` (via `scripts/dev.sh`) all hit `ensure-postgres.sh`, whose local branch unconditionally calls `docker compose up -d postgres`. All die there with `docker: command not found`.

2. **pm2 is installed but manages nothing.** `pm2` exists at `/opt/homebrew/bin/pm2`, but `pm2 list` shows an empty process table — no `multica-backend`, no `multica-frontend`. So the upgrade SOP's Step 8 `pm2 restart multica-backend multica-frontend` fails with a "process not found" error. On this host restart means killing and re-running the bare processes, not issuing a pm2 command.

One target survives and is worth noting: **`make stop` works.** It only runs `lsof -ti:$(PORT) | xargs kill -9` and `lsof -ti:$(FRONTEND_PORT) | xargs kill -9` with `PORT`/`FRONTEND_PORT` pulled from `.env`. No Docker, no pm2 — so it remains the supported way to stop services.

This is the operational substrate beneath two sibling gotchas from the same upgrade: the migration lint test that stayed red because `make test` is Docker-gated and was skipped (`docs/solutions/test-failures/migration-lint-duplicate-prefix-whitelist-gap.md`), and the version re-stamp that went unnoticed for the same reason (`docs/solutions/workflow-issues/version-reporting-after-upstream-upgrade.md`). Both of those were hidden *because* the commands in this doc are what you actually have to run here.

## Guidance

Every Makefile target below has a bare-process substitute. The recurring pattern is: **source `.env` so `PORT`, `FRONTEND_PORT`, and `DATABASE_URL` are exported, then run the Go/Next binary directly.** Without sourcing `.env` you either hit the Docker gate or fall back to a wrong-default port.

> **Production always-on (since 2026-07-22).** For a continuously-running, boot-self-starting, crash-recovering deployment, prefer the **launchd + standalone** setup (`bash scripts/selfhost/install.sh`), documented in `docs/solutions/runtime-errors/caddy-standalone-launchd.md`. The bare-process commands below remain the correct path for **dev, test, migrate, ad-hoc restarts**, and any host without launchd/pm2 supervision.

**Backend start (→ :8081).** `make start` / `make server` both gate on Docker; substitute:

```sh
set -a; source .env; set +a
go run -C server ./cmd/server
```

`.env` sets `PORT=8081`, which the server reads to pick its listen port. This is the exact command `make start` would have run in its body (`cd server && go run ./cmd/server`) — the Docker-gating prefix is the only thing being skipped. For a production/stamped build instead of `go run`, build with `-ldflags "-X main.version=<clean-tag>"` and run the binary (see `docs/solutions/workflow-issues/version-reporting-after-upstream-upgrade.md` — `go run` does not pass `-ldflags` through and leaves the version at `dev`).

**Frontend start (production → :3001).** Use the production server, **not** the dev server. `make start` runs `pnpm dev:web`, which is `next dev` — a hot-reload dev server, wrong for a running instance. The production script is `"start": "next start"`, and it must be preceded by a build:

```sh
pnpm build
set -a; source .env; set +a
pnpm -C apps/web exec next start -p "${FRONTEND_PORT:-3001}"
```

`next start` serves the production bundle from `.next`, which is why `pnpm build` comes first. The explicit `-p` is needed because the package's `start` script has no port flag and `next start` otherwise defaults to 3000.

**Stop.** `make stop` already works on this host (no Docker/pm2 dependency):

```sh
make stop
# equivalent manual form:
lsof -ti:8081 -i:3001 | xargs kill -9
```

Because pm2 manages nothing here, there is no `pm2 stop` equivalent; killing the listening ports is the whole operation.

**Migrate (DATABASE_URL is mandatory).** `make migrate-up` gates on Docker; substitute:

```sh
set -a; source .env; set +a
go run -C server ./cmd/migrate up
```

The critical detail: `cmd/migrate` defaults `DATABASE_URL` to `localhost:5432` when the env var is unset. That default is **wrong for this host** — the database is on `:5433`. Sourcing `.env` first is what prevents a silent connection to the wrong host.

**Tests (the Docker-free path).** `make test` gates on Docker twice (ensure-postgres + migrate-up). To run the backend suite on this host, migrate first with the command above, then:

```sh
go test -C server -race ./...
```

The migration lint test needs no database and can be run even more cheaply — `go test -C server ./internal/migrations/` — which is the workaround its own sibling doc recommends.

**Database backup (version-matched pg_dump).** The `pg_dump` on PATH is Homebrew's 16.x client and aborts against the 17.x server with a major-version-mismatch error. Use the version-matched binary:

```sh
/opt/homebrew/opt/postgresql@17/bin/pg_dump --no-owner --clean \
  "$(grep ^DATABASE_URL= .env | cut -d= -f2-)" > backup.sql
```

## Why This Matters

Every upstream-merge SOP step and every "how do I run Multica" instruction that says `make start`, `make test`, or `pm2 restart` is wrong for this host, and the failure modes are not obvious — they look like unrelated tooling errors rather than "you're on the wrong host for this command." Three concrete consequences:

- **The Go test suite is effectively unrunnable through the documented path**, which is why a red migration lint test sat undetected until a skill-eval baseline ran it directly (`docs/solutions/test-failures/migration-lint-duplicate-prefix-whitelist-gap.md`). The lint regression was invisible precisely because `make test` dies at the Docker gate before reaching `go test`.
- **A forgotten version re-stamp looked identical to a healthy backend.** The Help menu's "Backend unavailable" row only resolves correctly when you both stamp `-ldflags` *and* start the stamped binary rather than `go run` (`docs/solutions/workflow-issues/version-reporting-after-upstream-upgrade.md`). On a host where the start command is a hand-rolled `go run`, it is easy to lose the `-ldflags` step.
- **The upgrade SOP's Step 7 and Step 8 are both unrunnable as written.** Step 7 inherits `make test`'s Docker gate; Step 8 says `pm2 restart multica-backend multica-frontend`, which fails here because pm2's process table is empty. Without the substitutions above, an operator following the SOP literally gets stuck at both steps.

The unifying meta-pattern — shared with both sibling docs — is that **a self-host gotcha can stay hidden for a long time when the only commands that would surface it are Docker-gated and therefore skipped.** Writing the bare-process path down is what makes those gotchas visible and the SOP executable.

## When to Apply

Apply whenever you are operating **this checkout** (the one whose `.env` points at Homebrew `:5433` and whose host lacks Docker):

- Before or during any upstream upgrade — the umbrella SOP's Step 7 (`make test`) and Step 8 (`pm2 restart`) need substitution by the commands above.
- When restarting after a crash, reboot, or code change — there is no process manager, so "restart" is "kill the ports, re-source `.env`, re-run `go run` and `next start`."
- When a CI-style local check is wanted — reach for `go test -C server ...` directly rather than `make test`.
- When backing up before a migration — reach for the `postgresql@17` `pg_dump`, not the PATH default.

Do **not** apply these on a host that genuinely has Docker and the shared `postgres` container (the standard dev setup `ensure-postgres.sh` expects) — there, `make start` / `make test` are correct. Likewise, do not apply on a worktree using `.env.worktree` without adjusting ports.

## Examples

End-to-end: upgrade the checkout, then bring services back up as bare processes.

```sh
# 1) Migrate (DATABASE_URL from .env is mandatory — cmd/migrate defaults to :5432)
set -a; source .env; set +a
go run -C server ./cmd/migrate up

# 2) Backend on :8081 (for a production stamp, go build -ldflags + run the binary instead)
go run -C server ./cmd/server &

# 3) Frontend production server on :3001 (build first)
pnpm build
pnpm -C apps/web exec next start -p "${FRONTEND_PORT:-3001}" &

# 4) Verify
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3001        # frontend
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8081/healthz # backend

# 5) Stop when done (this target works as-is on this host)
make stop
```

Pre-upgrade backup with the version-matched `pg_dump`:

```sh
/opt/homebrew/opt/postgresql@17/bin/pg_dump --no-owner --clean \
  "$(grep ^DATABASE_URL= .env | cut -d= -f2-)" > "$(date +%Y%m%d)-multica.sql"
```

Running the migration lint test without touching `make test`:

```sh
go test -C server ./internal/migrations/
```

## Related

- `docs/solutions/runtime-errors/caddy-standalone-launchd.md` — the launchd + standalone production setup that supersedes the bare-process frontend/backend commands below for always-on deployment; this doc covers the dev/test/migrate/ad-hoc path.
- `docs/solutions/workflow-issues/safe-upstream-upgrade-with-local-customizations.md` — umbrella upgrade SOP; its Step 7 (`make test`) and Step 8 (`pm2 restart`) are exactly the steps these bare-process substitutions replace.
- `docs/solutions/workflow-issues/unapplied-migrations-after-upstream-upgrade.md` — authoritative source for the `DATABASE_URL`-from-`.env` / `:5433` migrate fact; cited rather than re-derived.
- `docs/solutions/test-failures/migration-lint-duplicate-prefix-whitelist-gap.md` — the red migration lint test that stayed hidden because `make test` is Docker-gated; its "Prevention" independently prescribes running the lint test directly.
- `docs/solutions/workflow-issues/version-reporting-after-upstream-upgrade.md` — the version re-stamp gotcha from the same upgrade; depends on this doc's "build then run the binary" path for the backend stamp to take effect.
- `scripts/ensure-postgres.sh` — the local-Docker branch that fails with `docker: command not found`.
- `.env` — the `:5433` database URL and `:8081` / `:3001` ports these commands depend on.
