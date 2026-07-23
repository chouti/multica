---
title: "skill-creator run_loop measures nothing in a proxy/headless env — claude -p doesn't auto-invoke skills, so optimize descriptions by hand"
date: 2026-07-23
category: developer-experience
module: skill-tooling
problem_type: best_practice
component: development_workflow
severity: low
applies_when:
  - "Running skill-creator's run_loop.py / run_eval.py to optimize a skill's triggering description"
  - "On a host where ANTHROPIC_BASE_URL points to a local proxy that the claude -p subprocess runs through"
  - "Interpreting a description-optimization score report that looks uniformly bad"
tags: [skill-creator, run-loop, description-optimization, claude-cli, proxy, verify-negatives]
---

# skill-creator run_loop measures nothing in this proxy env

## Context
skill-creator's description-optimization loop (`run_loop.py` / `run_eval.py`) tests triggering by spawning `claude -p` headless subprocesses and checking whether each consults the skill. On this host `claude -p` runs through a local proxy (`ANTHROPIC_BASE_URL=127.0.0.1:...`), and headless `claude -p` does **not** auto-invoke skills the way interactive Claude Code does. So every query scores `rate=0/3` regardless of the description, producing a confident-looking but fake `recall=0% / precision=100%`.

## Guidance
- Do **not** run `run_loop`/`run_eval` here to tune a skill description — it burns tokens returning all-zero scores.
- Optimize by hand instead: (1) keep concrete trigger phrases (incl. 中文 ones); (2) move "how the skill works" detail into the SKILL.md body — the description is a *trigger mechanism*, not a manual; (3) add an explicit `NOT for …` boundary listing the nearest-miss cases (the highest-leverage part).
- Spot a broken measurement generally: **if a metric is invariant across meaningfully different inputs, suspect the harness before the subject.** Changing the description across iterations left the score *identical* — that single observation is what flags the measurement, not the bad score itself.

## Why This Matters
While optimizing the `upgrade-upstream` skill's description, `run_loop` iteration 1 (original description) and iteration 2 (a complete rewrite) returned the **exact same** score (`recall=0%` every round). A score that does not move when the input changes materially cannot be reflecting the input — so the harness was broken, not the description. The cheap, wrong reading was "the description must be terrible"; the verify-negative reading (compare two iterations before trusting the number) saved a pointless 5-round rerun and a misdiagnosis.

Cleanup note: `run_loop` registers one worker per parallel `claude -p` as a phantom `~/.claude/commands/<skill>-skill-<hash>.md`; if interrupted via `TaskStop` it leaves them behind. Remove with `/bin/rm -f` — this user's shell aliases `rm` to `rm -i`, which silently no-ops in a non-interactive Bash call.

## When to Apply
Before reaching for skill-creator's `run_loop` on any host where `claude -p` runs through a proxy or in headless-only mode. More generally: any time an eval harness reports a suspiciously uniform score across varied inputs.

## Examples
The `upgrade-upstream` description was optimized by hand (added a `NOT for …` near-miss boundary, trimmed how-it-works detail) and the broken-`run_loop` finding was saved as the `feedback-skill-creator-runloop-proxy` memory so the next description-optimization attempt recalls "don't run run_loop here."

## Related
- `docs/solutions/workflow-issues/run-typecheck-after-upstream-merge.md` — same-session sibling: another verify-negatives rescue (a stale-looking migration count that turned out to be up/down file pairs, not collisions)
