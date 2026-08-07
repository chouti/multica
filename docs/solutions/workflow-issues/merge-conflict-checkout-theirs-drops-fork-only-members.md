---
title: "git checkout --theirs whole-file overwrite silently drops fork-only members — use git merge-file + a loss scan"
date: 2026-08-07
category: workflow-issues
module: upgrade-merge-conflict-resolution
problem_type: workflow_issue
component: development_workflow
severity: high
applies_when:
  - "resolving a merge conflict in any file where the fork ADDS members upstream lacks (locale keys, class methods, exports)"
  - "during an upstream-merge upgrade of the self-host Multica fork (multica-ai/multica into local fork)"
  - "when git checkout --theirs or --ours whole-file overwrite is considered as a conflict-resolution shortcut"
  - "when editing packages/views/locales/*.json or packages/core/api/client.ts during a fork merge"
tags: [merge-conflict, git-merge-file, checkout-theirs, fork-upgrade, locale-keys, three-way-merge, loss-scan, self-host]
---

# git checkout --theirs whole-file overwrite silently drops fork-only members — use git merge-file + a loss scan

## Context

This fork (the self-host Multica instance) tracks the upstream repository `multica-ai/multica` and periodically merges an upstream release tag into `main`, preserving a set of local customizations. During the **v0.4.18 → v0.4.20** upgrade (merge commit `e4b0277ba`, a true two-parent merge of local `c06fd6583` and upstream tag `93342d04a`; both are local-fork commits on this self-host checkout — verified ancestors of `HEAD`, not yet pushed to `origin`), 42 files conflicted and had to be resolved by hand. The full per-file record lives in `docs/upgrades/v0.4.20-plan.md` (Phase 4 "Decision point 2 — locale JSONs" and Phase 5) and `docs/customizations.md` ("Last upgrade — v0.4.18 → v0.4.20").

Two of those conflict resolutions were done with `git checkout --theirs <file>` — a whole-file overwrite that takes the upstream side of the merge verbatim. Both times this **silently destroyed fork-only members that upstream lacked**, and both times nothing in the merge output flagged the loss:

1. **Locale JSONs.** `--theirs` was applied to 16 files under `packages/views/locales/{en,zh-Hans,ja,ko}/`. It wiped **324 fork-only translation keys** belonging to features that exist only in this fork: `mention.skill_*` (skill-mention, #5346), `archived.*` + `status.archived` (#6106), `detail.identifier_*` / `prop_*` / `section_token_usage` (identifier-badge + token-usage), `execution_log.view_run` (#5309), `help.backend_*` / `cli_*` (#5539 version-stamp), `members.invite_name_*` (#4118), `comment.trigger_source_*`, and `gantt.show_closed`. Deleting a live key makes the UI fall back to rendering the raw key name to the user.

2. **`client.ts`.** `--theirs` on `packages/core/api/client.ts` wiped the fork's admin/skill API methods. Unlike the locale case this surfaced immediately as a **batch of typecheck errors**, because the fork's own callers reference the removed methods — but it surfaced as a *compile break*, not as a merge warning.

The dangerous part is the asymmetry: a file where the fork *adds* members upstream never had produces **no hunk-level conflict** to mark those additions as contested. The fork additions are clean, non-overlapping additions on one side of the merge. `git checkout --theirs` resolves the file by discarding the entire local side, so the fork-only members vanish without a single conflict marker, a single deleted-line warning, or (for JSON) any build failure. The locale loss was caught **only** by an adversarial post-merge verification scan that computed the set difference of deep-flattened keys, `flat(fork_main) − flat(current)`, and found it non-empty.

### How the hazard was discovered (session history)

The loss did not surface all at once — it took three passes to see its full scale, which is exactly why a deliberate scan (not eyeballing) is the guard:

- The first signal was **partial and easy to underestimate**: `group_skills` and `admin_user_management` had vanished from the zh-Hans/ja/ko `editor.json`/`layout.json` (they survived in the `en/` locale files, which were not conflicted). That looked like a small, localized miss.
- Only a **systematic flat-key diff** revealed the real scale — 324 fork-only keys gone — and split them into (A) ~100+ *live* keys for active fork features that must be restored, vs (B) genuinely-dead keys for UI upstream's Mika rewrite removed on purpose. Treating the first partial signal as the whole story would have left most of the loss unaddressed.
- The `client.ts` recurrence is what forced the durable fix. Its only *marked* conflict was a 1-hunk `startMikaOnboarding` addition, but the fork had separately added ~111 lines of methods (`adminUpdateUser` / `adminCreateInvitations` / `adminListUsers` / `importSkillsBatch`, plus the `archived` field and `skillMentionAgents` param) in *non-conflicted* regions. `--theirs` dropped all of them; `pnpm typecheck` then failed with a batch of "missing method / wrong arity / missing `archived` field" errors. Same root cause as the locale loss — and the proof that `--theirs` was the problem, not the specific file.

A related lesson from the same upgrade (session history): **`merge-tree` hunk counts do not predict real conflict counts or locations.** The pre-merge preview predicted 37 conflicts; the actual was 42. `issue-detail.tsx` was predicted at 11 hunks but had 3 real ones; `thread-nav-panel.tsx` was missed by the preview entirely yet had 8 real conflicts (it was a fork `new file` byte-identical to v0.4.19, so the v0.4.18 base hid it). Hunk-level conflict ≠ semantic conflict — so "the merge looked clean" is never evidence that a resolution preserved fork content.

## Guidance

**Rule: never use `git checkout --theirs` (or `--ours`) whole-file overwrite on a file where the fork adds members upstream lacks.** Locale keys, class methods, and exported symbols are the recurring shapes of "members the fork adds." For these files a whole-file side-pick is not a conflict resolution — it is a silent deletion of the side you did not pick.

Use a true three-way merge instead, so both sides' non-conflicting regions survive:

```bash
# WRONG — silently drops every fork-only member (locale keys, methods, exports)
git checkout --theirs packages/views/locales/zh-Hans/issues.json

# RIGHT — 3-way merge: <current> <base> <theirs>, result written back to <current>
git show HEAD:packages/views/locales/zh-Hans/issues.json      > /tmp/ours.json    # fork side
git show $(git merge-base HEAD v0.4.20):packages/views/locales/zh-Hans/issues.json > /tmp/base.json
git show v0.4.20:packages/views/locales/zh-Hans/issues.json   > /tmp/theirs.json
git merge-file -p /tmp/ours.json /tmp/base.json /tmp/theirs.json > packages/views/locales/zh-Hans/issues.json
```

`git merge-file` performs the hunk-level three-way merge on the three blobs: regions only one side changed are taken from that side, regions both sides changed identically converge, and only genuinely divergent hunks emit `<<<<<<<` markers for manual resolution. That is exactly the semantics wanted for "fork adds members, upstream rewords shared members."

**Always pair any conflict resolution with a loss scan.** After resolving, assert that nothing the fork had is now gone. For JSON, deep-flatten both key sets and diff:

```bash
# flat(fork_main) - flat(now) must be EMPTY for every locale file
python3 - <<'PY'
import json, subprocess, sys

def flat(obj, prefix=""):
    out = {}
    if isinstance(obj, dict):
        for k, v in obj.items():
            out.update(flat(v, f"{prefix}{k}."))
    else:
        out[prefix[:-1]] = obj
    return out

def keys(ref, path):
    raw = subprocess.run(
        ["git", "show", f"{ref}:{path}"], capture_output=True, text=True, check=True
    ).stdout
    return set(flat(json.loads(raw)))

path = "packages/views/locales/zh-Hans/issues.json"
fork_keys = keys("HEAD", path)                      # fork side before resolution
now_keys  = set(flat(json.load(open(path))))        # resolved working-tree file

lost = fork_keys - now_keys
if lost:
    print(f"LOST {len(lost)} fork-only keys in {path}:")
    for k in sorted(lost):
        print("  ", k)
    sys.exit(1)
print(f"OK {path}: no fork-only keys lost")
PY
```

For a code file like `client.ts`, the equivalent scan is a diff of the member/method lists rather than a key-flatten — enumerate the fork's method names on `HEAD` and assert each still resolves in the working tree (the typecheck errors from `--theirs` were the crude form of this signal; a deliberate scan finds them before the compiler has to).

**Restore fork-only members add-only.** When the loss scan reports missing keys, restore them with a deep-merge that **adds** the missing keys but **preserves upstream's values for shared keys**. The result is the union: upstream's normalized wording for keys both sides carry, plus the fork's feature keys upstream never had. Do not overwrite shared keys back to fork values — upstream's converged translations (the MUL-5703 issue→任务 terminology and full-width punctuation) were the reason to take upstream's side in the first place.

**`--theirs` is only safe on a pure follow-upstream file.** It is a legitimate shortcut when the fork made *zero* additions to that file — the file merely tracks upstream. The upgrade plan records several such files (`apps/web/package.json` version bump, the landing i18n files where "fork 0 改"). Before reaching for `--theirs`, confirm the fork truly added nothing: `git diff <base>..HEAD -- <file>` empty of fork-side additions means the fork has nothing to lose.

## Why This Matters

A whole-file `--theirs` on a fork-additive file fails **silently**, which is the worst failure mode for a maintenance operation you run a few times a year and cannot fully re-test by hand.

- The locale loss produced **no build error, no test failure, and no conflict marker**. 324 keys disappeared; the app compiled and the suite was green. Without the adversarial `flat(fork) − flat(now)` scan, the loss would have shipped, and users of the fork's skill-mention, archived-status, identifier-badge, and version-stamp features would have seen raw key names (`mention.skill_*`, `status.archived`, `help.backend_*`) rendered in the UI. The cost of the bug is deferred and discovered by end users, in production, in four languages.

- The `client.ts` loss was louder — a batch of typecheck errors — but it is luck, not design, that this file had in-repo callers to break. A fork-only export with no current caller would have failed just as silently as the locale keys.

- The repair is materially more expensive than the prevention. Restoring 324 keys across 16 files required a purpose-built deep-merge script plus a follow-up pass (`packages/views/locales/parity.test.ts`) that surfaced another **80 keys** needing English coverage, and then a deliberate dead-key pruning pass to remove the subset (`runtime_aside.*`, `step_header.*`, the token-usage sidebar keys) that upstream had legitimately retired — distinguishing "live key we must restore" from "dead key upstream deleted on purpose" (e.g. `execution_log.view_run` is live in `comment-card.tsx`; the token-usage sidebar was removed by upstream commit `ba129b196` MUL-5762). That triage is real work. A three-way merge plus a loss scan up front avoids the entire recovery.

- The generalizable principle, recorded in the upgrade plan's durable lessons: a fork customization is an **invariant set** spanning code + tests + every locale. Any resolution strategy that operates on one file at a time without a completeness check across that set can drop a member the rest of the set still depends on. The loss scan is what turns "we think we kept everything" into a verifiable assertion `flat(fork) − flat(now) == ∅`.

- This doc's corrective also fixes an active hazard in the knowledge store: `merge-feature-branch-customized-main.md` Step 1 still recommends `git checkout --theirs <file>` for "both added" component files with no caveat. That recommendation is unsafe for fork-additive files and is scoped/corrected by this doc (see Related).

## When to Apply

Apply this guidance during any upstream-merge / fork-sync conflict resolution, on a per-file basis:

- **Reach for `git merge-file` + loss scan** whenever the file is one where the fork adds members upstream lacks. Signals: locale/translation JSON under `packages/views/locales/`; API client files like `packages/core/api/client.ts` where the fork adds methods alongside upstream's; any module the fork extends with extra exports. If `git diff <merge-base>..HEAD -- <file>` shows fork-side additions that are not also upstream edits, the file is fork-additive and `--theirs`/`--ours` is unsafe.

- **`--theirs` (or `--ours`) is acceptable** only for pure follow-upstream files: `git diff <merge-base>..HEAD -- <file>` shows the fork contributed nothing but tracking upstream. In the v0.4.20 upgrade this held for `apps/web/package.json` (version bump, "fork 0 改") and the landing i18n files.

- **Run the loss scan after every conflict resolution, not only when you used `--theirs`.** Even a careful hand-merge can drop a fork-only member. The scan is cheap and the assertion `flat(fork) − flat(now) == ∅` is the completeness gate.

- **Restore add-only, then prune deliberately.** A missing live key is far worse than an extra dead key, so restore first and prune later — only with code-reference proof that a key is genuinely dead (0 references), as the upgrade did in Phase 5.

- **Don't trust a clean-looking merge.** `merge-tree` hunk counts and "no conflict markers" both under-report semantic divergence (session history). The completeness check is the loss scan against the fork's pre-merge state, not the merge's own output.

This applies to the recurring fork-upgrade workflow described in `docs/upgrades/` and `docs/customizations.md`. It generalizes to any long-lived fork that merges an upstream trunk while carrying additive local changes.

## Examples

**Case 1 — locale JSONs (the silent loss).** The initial, user-approved plan for the 16 locale files was "accept upstream," because upstream's zh/ja/ko translations had converged to the fork's MUL-5703 terminology and full-width punctuation, and the ja `lede` was byte-identical to fork. On that evidence `--theirs` looked safe:

```bash
# What was run — WRONG for a fork-additive file
git checkout --theirs packages/views/locales/{en,zh-Hans,ja,ko}/*.json
```

The adversarial scan then caught the damage:

```text
flat(fork_main) - flat(current)  =>  324 keys
  mention.skill_*            (skill-mention, #5346)
  archived.*, status.archived (#6106)
  detail.identifier_*, prop_*, section_token_usage
  execution_log.view_run     (#5309)
  help.backend_*, cli_*      (version-stamp, #5539)
  members.invite_name_*      (#4118)
  comment.trigger_source_*, gantt.show_closed
```

The fix restored all 324 keys add-only from `git show HEAD:<file>`, preserving upstream values for shared keys — the union of upstream's converged wording and the fork's feature keys. The follow-up parity run (`packages/views/locales/parity.test.ts`, 9 "EN covers every key" failures) then surfaced 80 keys needing English coverage, and a deliberate pass deleted the dead subset while keeping live keys (`execution_log.view_run`, all 72 `welcome_after_onboarding.*` for the fork's own live `welcome-after-onboarding.tsx` Mika page). Final state: parity 166/166, full suite 3754/3754.

**Case 2 — `client.ts` (the loud loss).** `--theirs` on `packages/core/api/client.ts` discarded the fork's admin/skill API methods, producing a batch of typecheck errors. The correct resolution is a three-way merge keeping both sides' additive regions:

```bash
# 3-way merge preserving fork methods AND upstream's new methods
git show HEAD:packages/core/api/client.ts                  > /tmp/ours.ts
git show $(git merge-base HEAD v0.4.20):packages/core/api/client.ts > /tmp/base.ts
git show v0.4.20:packages/core/api/client.ts               > /tmp/theirs.ts
git merge-file -p /tmp/ours.ts /tmp/base.ts /tmp/theirs.ts > packages/core/api/client.ts
# -> exactly 1 real <<<<<<< conflict (resolved to upstream); both sides'
#    non-conflicting methods preserved automatically
```

The merged result retained the fork's additive surface — `EMPTY_BATCH_IMPORT_RESPONSE` / `EMPTY_CHAT_MESSAGE_LIST` imports, `include_archived` params, `getChildIssueProgress`, `skillMentionAgents` on `createComment`/`updateComment`, `listArchivedInbox`, `setChatSessionArchived`, and the #5539 provenance lines — alongside upstream's new Mika/DingTalk methods and the `workspaceHeader()` helper. That single genuine conflict went to upstream; everything else merged cleanly because the additions were disjoint.

**The before/after in one line each:**

- Before (unsafe): `git checkout --theirs <file>` on a fork-additive file → fork-only members silently dropped; loss found only by an after-the-fact scan (locale) or a compile break (client.ts).
- After (safe): `git merge-file <ours> <base> <theirs>` for fork-additive files, then a `flat(fork) − flat(now) == ∅` loss scan as the completeness gate, then add-only restore of anything still missing, then deliberate dead-key pruning with code-reference proof.

## Related

- `docs/solutions/workflow-issues/merge-feature-branch-customized-main.md` — **direct contradiction / refresh target.** Its Step 1 recommends `git checkout --theirs <file>` for "both added" files with no fork-only-member caveat. This doc corrects and scopes that recommendation.
- `docs/solutions/workflow-issues/safe-upstream-upgrade-with-local-customizations.md` — the canonical upgrade-workflow SOP; this doc is a concrete conflict-resolution tactic that plugs into its per-file resolution step.
- `docs/solutions/workflow-issues/upstream-type-scale-refactor-fork-only-files-blindspot.md` — sibling fork-only-loss learning, different mechanism (merge never visits fork-only *files*, caught by a guard test) vs. this doc's *active overwrite* of fork-only *members*. Same "fork-only content is structurally invisible to text-merge" theme.
- `docs/solutions/workflow-issues/upstream-orthogonal-signature-double-change-blindspot.md` and `upstream-single-sided-fork-param-convergence-merge.md` — the Strategy D silent-merge family (3-way merge loses one side's intent at the signature level); different detection surface (`go build`) than this doc's loss scan.
- `docs/solutions/workflow-issues/run-typecheck-after-upstream-merge.md` — adjacent post-merge verification gate; this doc adds the complementary fork-only-member loss scan for the resolution paths typecheck cannot see (locale JSON, dropped exports still typecheck).
- Process artifacts: `docs/upgrades/v0.4.20-plan.md` (Phase 4 "Decision point 2" + Phase 5 loss-scan record), `docs/customizations.md` ("Last upgrade — v0.4.18 → v0.4.20").
