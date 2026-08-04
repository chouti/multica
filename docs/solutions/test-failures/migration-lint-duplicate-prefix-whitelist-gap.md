---
title: "Migration lint whitelist drifted silent on self-host (make test skipped)"
date: 2026-07-22
last_updated: 2026-08-04
category: test-failures
module: "server/internal/migrations"
problem_type: "test_failure"
component: "testing_framework"
severity: "low"
symptoms:
  - "TestMigrationNumericPrefixesStayUniqueAfterLegacySet fails: prefixes 158, 159, and 160 each have two unrelated migration stems not in legacyDuplicateMigrationStems"
  - "Red test never surfaced on this self-host because make test requires Docker (ensure-postgres.sh) and is always skipped"
applies_when:
  - "A local fork adds a migration whose numeric prefix collides with an existing one"
  - "Running the backend Go test suite on a Homebrew-pg self-host where make test is Docker-gated and skipped"
root_cause: "incomplete_setup"
resolution_type: "test_fix"
related_components:
  - "database"
  - "tooling"
tags: [migrations, lint-test, duplicate-prefix, whitelist, go, test-guard, self-host]
---

# Migration lint whitelist drifted silent on self-host (make test skipped)

## Problem

`TestMigrationNumericPrefixesStayUniqueAfterLegacySet` in `server/internal/migrations/migrations_lint_test.go` was failing on migration numeric prefixes `158`, `159`, and `160`. The test walks every `*.up.sql` migration on disk, groups filenames by their leading numeric prefix, and asserts that no two migrations share a prefix unless that prefix is whitelisted in `legacyDuplicateMigrationStems` (`server/internal/migrations/migrations_lint_test.go:17`). Three local-fork migrations introduced at prefixes 158/159/160 collided with upstream migrations under the same prefix, the whitelist did not yet list them, and the test therefore reported them as new violations. The failure was surfaced by a skill-eval baseline reading the test file — not by any normal development workflow on this self-host fork.

## Symptoms

For each colliding prefix, the test emitted the error formatted at `server/internal/migrations/migrations_lint_test.go`:

> `migration prefix 158 is reused by [158_agent_task_queue_chat_input_task_id 158_backfill_comment_source_task_id]; use the next unique prefix instead`

with identical-shape messages for `159` and `160`. The four collision groups:

- `119` — `119_invitation_invitee_name` (local fork #4118) vs `119_user_created_at_index` (upstream). Already whitelisted.
- `158` — `158_backfill_comment_source_task_id` (local fork #5309) vs `158_agent_task_queue_chat_input_task_id` (upstream).
- `159` — `159_backfill_direct_assignment_comment_source_task_id` (local fork #5309) vs `159_chat_message_message_kind` (upstream).
- `160` — `160_backfill_during_execution_comment_source_task_id` (local fork #5309) vs `160_chat_message_input_owner_index` (upstream).
- `213` — `213_issue_status_archived` (local fork #6106 archived status) vs `213_task_usage_authoritative_cost` (upstream). Added 2026-07-27 (v0.4.11 upgrade, merge `185d446d8`).
- `214` — `214_issue_status_classifier_functions` (local fork #6106) vs `214_chat_session_project` (upstream). Added 2026-07-27 (v0.4.11 upgrade).

> **Updated 2026-08-04 (v0.4.17 audit):** the canonical count is now **6 known collision stems** (`119/158/159/160/213/214`), not 4. `docs/customizations.md` Drift notes is the authoritative tracker; v0.4.17 added migration `251_agent_runtime_unbind` with no new collision (stem 251 > fork max 250). When this doc was first written (2026-07-22), only the original 4 were whitelisted; the 213/214 additions happened at v0.4.11 but the doc body was not updated. The lint map at `server/internal/migrations/migrations_lint_test.go:43-53` is the source of truth — re-verify by `grep -n '"[0-9]\+"' server/internal/migrations/migrations_lint_test.go` if reading this after the listed date.

A second-order symptom: nothing in the running self-host service was actually broken. The collision is a static, file-naming concern caught only by the lint test; it does not affect migration execution (see *Why This Works*). Compounding that, `make test` is Docker-gated on this self-host checkout and routinely skipped, so the red test sat undetected — the skill-eval baseline was the first thing to run it in a long time.

## What Didn't Work

- **Relying on `make test` to surface lint regressions on self-host.** Because the target spins up a Docker Postgres (`scripts/ensure-postgres.sh`), it is commonly skipped during iteration on this checkout, so a red Go test could persist across many commits with no human ever seeing it. The migration lint suite needs no database at all, but it was gated behind the one that does.
- **Assuming the collisions were "already tolerated via the lint map."** `docs/customizations.md` said exactly that; the assumption was stale. At the bug point `legacyDuplicateMigrationStems` listed entries only through `128`, plus the earlier-added `119`. The `158`/`159`/`160` entries were missing — the whitelist was being trusted without being read.
- **Partial whitelist hygiene.** When the `119` collision from fork #4118 was introduced, someone added it to the map. The later #5309 collisions at 158/159/160 were not given the same treatment, so the same class of problem re-surfaced under a different prefix. Treating the `119` add as a one-off rather than a standing workflow step left the door open.

## Solution

Add the three missing entries to `legacyDuplicateMigrationStems`, matching each migration's exact stem (the full filename minus the `.up.sql`/`.down.sql` suffix) — exactly what commit `384e5de0a` (self-host fork only — not on upstream `origin/main`, so the SHA is local to this fork's history; no upstream PR) does in its diff against `server/internal/migrations/migrations_lint_test.go`:

```go
"158": {"158_agent_task_queue_chat_input_task_id", "158_backfill_comment_source_task_id"},
"159": {"159_backfill_direct_assignment_comment_source_task_id", "159_chat_message_message_kind"},
"160": {"160_backfill_during_execution_comment_source_task_id", "160_chat_message_input_owner_index"},
```

The entries must list **every** stem sharing that prefix: the test deep-compares the sorted stems found on disk against the sorted stems in the map, so an incomplete list triggers `legacy duplicate migration prefix %s changed` rather than passing. The same commit also corrected `docs/customizations.md`, whose prior claim that these were already tolerated was the stale documentation noted above. Verified green: `go test -C server -run TestMigrationNumericPrefixesStayUniqueAfterLegacySet ./internal/migrations/` reports `ok`.

## Why This Works

The lint test is a developer guard against accidentally introducing new duplicate-prefix filenames; it is **not a runtime gate**, and adding an entry to the whitelist does not change any executed behavior. Two pieces of source make that true:

1. **Versions are full stems, not numeric prefixes.** `ExtractVersion` (`server/internal/migrations/migrations.go:95-100`) strips only the `.up.sql` / `.down.sql` suffix and keeps everything else, so `158_backfill_comment_source_task_id` and `158_agent_task_queue_chat_input_task_id` are distinct version strings despite sharing the `158` prefix.

2. **`schema_migrations` keys on that full stem.** The migration runner creates the bookkeeping table with `version TEXT PRIMARY KEY`, and the apply loop stores `migrations.ExtractVersion(file)` into that column via parameterized insert/delete. Each same-prefix-different-slug migration lands as an independent row and is applied/skipped independently by the `EXISTS` check.

So whitelisting the collision in the lint map is purely declarative: it tells the test "yes, I know about these, leave them alone," and nothing about how migrations run at startup changes. The server was healthy the whole time the test was red — which also explains why nobody noticed.

## Prevention

- **Treat the lint whitelist as part of the fork-introduction workflow.** When adding a local migration whose numeric prefix collides with an existing one (upstream or another fork), add the stems to `legacyDuplicateMigrationStems` in the same change. List every stem sharing the prefix, because the test deep-compares the set. (The ledger records the standing rule: these duplicate-prefix collisions are accepted legacy state — do NOT renumber them.)
- **Run the migration lint test directly on self-host,** not through `make test`. The command `go test -C server ./internal/migrations/` is pure file-checking — it globs the migrations directory and never opens a database connection. Running it directly sidesteps the Docker gating that hides failures on this checkout. Add it to the self-host upgrade checklist alongside the version re-stamp.
- **Verify "tolerated via the lint map" claims against the actual map** rather than trusting prose. The `docs/customizations.md` line that prompted this bug was stale; a five-second read of the map would have shown 158/159/160 were absent. When a doc asserts a code-enforced invariant, check the code when the doc is touched.

## Related

- `docs/customizations.md` — ledger entry for the duplicate-prefix collisions (119/158/159/160, do-not-renumber, the lint fixture), including the specific 158/159/160 fix at commit `384e5de0a` (self-host fork only — not on upstream `origin/main`, so the SHA is local to this fork's history; no upstream PR). Authoritative instance record.
- `docs/solutions/workflow-issues/unapplied-migrations-after-upstream-upgrade.md` — closest migration sibling (same module + same self-host-upgrade context), but a disjoint failure mode: `migrate up` not applied / schema drift, not lint-whitelist drift.
- `docs/solutions/workflow-issues/version-reporting-after-upstream-upgrade.md` — companion from the same v0.4.6 upgrade; shares the meta-pattern of a self-host gotcha staying hidden because `make test`/`make start` are Docker-gated and skipped.
- `docs/solutions/workflow-issues/safe-upstream-upgrade-with-local-customizations.md` — umbrella upgrade SOP; this lint-drift is a concrete instance of the SOP's "make test is unrunnable on Homebrew-pg self-host" caveat.
