---
title: Resumable upgrade-plan artifact — a typed frontmatter state machine for long, interruptible upstream upgrades
date: 2026-07-23
last_updated: 2026-08-17
category: architecture-patterns
module: upgrade-workflow
problem_type: architecture_pattern
component: development_workflow
severity: low
applies_when:
  - "Designing a workflow skill whose work spans many phases and can be interrupted and resumed (upstream upgrades, migrations, releases)"
  - "Deciding where a long-running process's state should live — conversation memory vs a typed on-disk artifact"
  - "Coordinating sequential phases (audit → merge → verify → irreversible gates) where each must complete before the next unlocks"
tags: [skill-design, state-machine, artifact, upgrade-workflow, resumable, frontmatter, compound-engineering]
---

# Resumable upgrade-plan artifact

## Context
Upgrading a self-host fork to a new upstream release is judgment-heavy, multi-phase, and routinely interrupted — conflict resolution stalls, `pnpm test` is left running, the session ends mid-verify. The `upgrade-upstream` skill (`.claude/skills/upgrade-upstream/`, project-local) drives the full `locate → audit → merge → verify → restart → record` loop. State that lives only in the conversation cannot survive a session break or a fresh agent: the next run cannot tell "Phase 5 genuinely finished" from "Phase 5 was interrupted halfway", and re-derives expensive audit conclusions (per-file merge strategy, adversarially-verified negative claims) from scratch.

## Guidance
Give the workflow **one typed artifact per run** at `docs/upgrades/<target-tag>-plan.md` whose frontmatter *is* the state machine. State lives in the file, not in memory.

```yaml
---
upgrade_contract: selfhost-upgrade/v1   # contract version; bump when the shape changes
target_tag: v0.4.8
base_tag: v0.4.6
phase: gates          # single-value state machine: audit → preview → resolve → verify → gates → record → done
merge_commit: 75ec751af  # recorded at Phase 5 close; the merge commit is created BEFORE Phase 6 (the version re-stamp resolves the tag from HEAD — commit-first)
gates:                # boolean checklist — preconditions for the irreversible steps
  user_confirmed: true
  audit_strategy_written: true
  db_backed_up: true
  migrated: false
  version_stamped_frontend: false
  version_stamped_backend: false
  services_restarted: false
  health_checked: false
negative_claims:      # every audit "no X" conclusion, each with the command that proved/killed it
  - claim: "no new migration collision"
    verified_by: "ls server/migrations/ | sort -n"
    result: confirmed
---
```

Three rules make it actually resumable:

- **Resume rule** — at the start of any continuation, read the artifact's frontmatter; `phase:` says where to pick up, `gates:` says whether the irreversible steps already fired. Do not re-derive state from the conversation.
- **Write-through** — after each phase genuinely completes, advance `phase:` to the next value and flip the relevant `gates:` to `true`. A value must reflect what is true on disk, never ahead of reality.
- **`phase == gates` unlocks the irreversible steps** — the Phase 6 gate keys on `phase == gates` (set only at the *end* of Phase 5 after all checks went green), not on "reached verify". A `phase: verify` means Phase 5 is mid-run or was interrupted; only `phase: gates` proves completion. This single distinction stops a half-finished verify from slipping into the irreversible DB/service steps.

Two more contracts that make the artifact self-explaining: `negative_claims` entries with an empty `verified_by` are **unverified** and must not be trusted downstream (this forces the "verify every no-X conclusion" discipline into the data, not just the prose); and the per-file merge strategy table lives in the Phase 1 body section so Phase 4 reads it instead of re-auditing.

## Why This Matters
A fresh agent that has never seen the prior session can open `docs/upgrades/v0.4.8-plan.md`, read `phase: gates` + the gates checklist, and resume correctly. State in the conversation dies with the session; state in a typed artifact is addressable by anyone (agent or human) at any time. The `phase == gates` key is the load-bearing detail — without it, "where am I" is ambiguous exactly at the irreversible boundary, which is the worst place to be wrong.

## When to Apply
Any multi-phase workflow that (a) can be interrupted and resumed across sessions, and (b) has an irreversible gate that must only fire after a reversible phase genuinely completes. Upstream upgrades, DB migrations, release cuts. Not worth it for single-shot or fully-reversible tasks.

## Examples
- `docs/upgrades/v0.4.6-plan.md`, `docs/upgrades/v0.4.8-plan.md`, and `docs/upgrades/v0.4.26-plan.md` — canonical instances (frontmatter shape, gate names, phase body). The real state machine has seven values — `record` sits between `gates` and `done` (Phase 7 closes the plan + ledger) — and real artifacts carry a `merge_commit:` key stamped when the merge commit is created at the end of Phase 5, before Phase 6's version re-stamp (which needs the tag reachable from HEAD). `v0.4.26-plan.md` reached `phase: done` with all gates true after the 2026-08-17 upgrade.
- The `upgrade-upstream` skill writes Phase 1 strategy into the artifact, hard-checks `phase == gates` before the irreversible DB/service steps (Phase 6), and closes the file `phase: done`.

## Related
- `docs/solutions/workflow-issues/safe-upstream-upgrade-with-local-customizations.md` — the 10-step upgrade SOP this artifact orchestrates around
- `docs/solutions/workflow-issues/install-sh-upgrade-reload-defects.md` — the reload defects hit during this upgrade's Phase 6
- `docs/solutions/architecture-patterns/runtime-build-provenance.md` — the version-stamp mechanism the artifact's `version_stamped_*` gates protect
- `docs/upgrades/v0.4.8-plan.md` — the worked example
