---
title: "A fork customization is an invariant set across code + tests + every locale — 3-way merge is blind to fork-code x upstream-test collisions; only running upstream's new tests surfaces them"
date: 2026-08-07
last_updated: 2026-08-17
category: workflow-issues
module: upstream-upgrade-merge
problem_type: workflow_issue
component: development_workflow
severity: high
applies_when:
  - "merging an upstream release into the self-host Multica fork that carries local customizations (code, tests, locale keys)"
  - "a fork-local component or locale key has no textual overlap with upstream changes, so 3-way merge reports a clean merge"
  - "upstream ships new or changed tests (render probes, locale parity checks) alongside the release"
  - "deciding whether a 'fork customization' should be restored after a merge, when it may actually be upstream-deleted code"
  - "auditing packages/views/locales/*.json and packages/views/**/*.test.tsx after an upstream merge"
tags: [fork-upgrade, three-way-merge, upstream-tests, locale-parity, fork-customization, invariant-set, test-detection, self-host]
---

# A fork customization is an invariant set across code + tests + every locale — 3-way merge is blind to fork-code x upstream-test collisions; only running upstream's new tests surfaces them

## Context

This learning comes from upgrading a self-host Multica fork from v0.4.18 to v0.4.20 (merge commit `e4b0277ba`, a true two-parent merge and a verified ancestor of HEAD on this checkout; not yet pushed to origin). The fork carries local customizations layered on top of upstream `multica-ai/multica`, and each upgrade is a 3-way merge of upstream's release into the fork's branch.

The dangerous assumption going into any such merge is: **"the merge compiled and auto-merged clean, so my customizations survived."** This is false, and it is false for a structural reason, not a careless one.

A fork customization is never a single edit. It is an **invariant set** that spans:

- the **code** that implements the customization,
- the **tests** that pin its behavior, and
- **every locale bundle** (`en`, `ja`, `ko`, `zh-Hans`) that names its user-facing strings.

A 3-way merge reconciles two diffs against a common ancestor, hunk by hunk, *within each file independently*. It has no cross-file, cross-artifact notion of "these five files together constitute feature X." So when the fork changes `issue-detail.tsx` (its own code) and upstream changes `issue-detail.test.tsx` (its own test), **each side touched only its own file** — from the merge's perspective there is no conflict to mark. The two changes are auto-merged into a tree that compiles and type-checks, yet is semantically broken: the fork's code now violates an invariant that upstream's *new* test asserts. The merge output never flags this because, to the merge, nobody disagreed.

The only detector for this class of collision is **running upstream's newly-added tests** after the merge. Green compile + clean auto-merge tells you the text merged; it says nothing about whether the fork's invariant set is still internally consistent with upstream's new assertions. (auto memory [claude])

This doc is the sibling of `docs/solutions/workflow-issues/merge-conflict-checkout-theirs-drops-fork-only-members.md`. That doc covers the *overwrite* surface — losing fork-only *members within a single file* to a `--theirs` whole-file checkout. This doc covers the *test-detection* surface — fork customizations as cross-file invariant sets, and upstream's new tests (plus the locale parity test) as the only thing that surfaces fork-code × upstream-test collisions. The two share one thesis sentence (the invariant set) and the same three concrete instances, but their root causes and fixes differ; they are complementary surfaces of one upgrade, not duplicates.

## Guidance

**Treat every fork customization as an invariant set, not a diff.** When you carry a customization across an upgrade, enumerate its full footprint before the merge: the implementing component(s), the test(s) that pin it, and the keys it adds to *each* locale bundle. A customization is not "preserved" until all three legs are re-validated against the merged tree, not just until the code leg still compiles.

**Run upstream's new tests as the collision detector — do not trust a clean merge.** After the merge compiles, run the test suite (or at minimum the suites for files upstream touched). A fork-code × upstream-test collision produces *no merge conflict and no type error*; the test failure is the first and only signal. Budget for this: it is the expected cost of an upgrade, not an anomaly. When a new upstream test fails on the merged tree, ask "which fork customization does this test's implicit invariant now contradict?" rather than "why is upstream's test buggy?"

**Use `parity.test.ts` as a fork-only-key detector.** The locale parity suite (`packages/views/locales/parity.test.ts`) asserts, for every namespace and every non-English locale, both directions of coverage — `zh/ja/ko covers every EN key` (`packages/views/locales/parity.test.ts:72-77`) and `EN covers every zh/ja/ko key` (`packages/views/locales/parity.test.ts:79-84`). The second direction is the detector: any key present in a non-English bundle but absent from English fails `EN covers every <locale> key`. After an upgrade that restores fork-only locale keys, this assertion enumerates exactly the fork's locale-only surface. Treat its failure list as the roster of fork-added keys you must triage — not as noise.

**Restore add-only, then prune dead keys with code-reference proof.** When restoring fork locale keys after a merge, deep-merge them back add-only (do not overwrite upstream's wording for shared keys). Then triage the parity failure list into two buckets, proving each with a code reference:

- **LIVE key** — still referenced by a component: restore it *and* add English coverage so both parity directions pass. Proof: a `t(($) => $.ns.key)` call site, e.g. `execution_log.view_run` referenced at `packages/views/issues/components/comment-card.tsx:622` and `:964`, or the `welcome_after_onboarding.*` block referenced throughout `packages/views/workspace/welcome-after-onboarding.tsx:163-184`.
- **DEAD key** — no remaining code reference: delete it from all locales rather than translating dead weight.

Never keep a key "just in case," and never delete a key without a negative grep across `*.tsx` for its reference.

**Verify fork-origin before restoring a "fork customization."** The most expensive mistake is resurrecting code upstream deliberately retired. Before stitching any "fork customization" back after a merge, confirm it is genuinely fork-originated: present in the fork's merge-base *and* not something upstream removed on purpose. If upstream deleted the surface in the release you are merging, "restoring" it resurrects upstream-removed code and fights the upgrade. Check upstream's intent (the release diff / the removing commit) before treating an absent feature as a customization to recover.

**Verify the customization exists at the fork merge-base — grep the working tree, not just refs.** (session history) The badge fix went through a triple reversal: it looked like 5 independent composer/sticky failures → then like a fork badge-customization colliding with the probe → then the truth: `git grep IssueIdentifierBadge` at fork v0.4.18 and upstream v0.4.20 returned **zero** — the badge existed only as a local fork customization on `main`, invisible to a ref-based grep. Before diagnosing a collision as "fork customization × upstream test," confirm the customization actually exists at the fork's merge-base rather than trusting intermediate reconstruction state or a ref grep.

## Why This Matters

The failure mode is **silent**. A fork-code × upstream-test collision produces no merge conflict marker, no compiler error, and no type error. The tree builds. If you equate "merged clean + compiles" with "customizations survived," you ship the break.

The asymmetry is structural and worth stating plainly: **a 3-way merge can only report disagreement, and a fork-code × upstream-test collision is a case where the two sides never textually disagreed.** The fork edited its component; upstream edited its test. Both edits applied cleanly. The contradiction only exists in the *composed* tree, and the only artifact that evaluates the composed tree is the test run. There is no merge flag to read instead — you must execute the tests.

(session history) Why the fork never saw the badge collision on its own side: the fork's issue-detail tests used only the plural `getAllByText`/`findAllByText` for the title (never the singular `getByText`), so the duplicated title text never failed on the fork side. Upstream v0.4.20's new singular-`getByText` probes were the first to demand uniqueness — and they were load-complete signals, not hard DOM assertions, which is what made a minimal fix (relocate the badge) sufficient rather than a redesign.

The cost asymmetry compounds this. Discovery deferred past the upgrade means discovery in production: a uniqueness probe that now matches two nodes, a locale key that silently falls back to English in `ja`/`ko`/`zh-Hans`, a feature whose test no longer describes its behavior. Because the fork ships four languages, every locale mistake is multiplied across bundles, and a missing-EN key does not throw — it quietly renders the wrong language to a real user. Catching these at upgrade time, with the test suite as the detector, is orders of magnitude cheaper than catching them after deploy. (auto memory [claude])

## When to Apply

Apply this on **every upstream upgrade / sync merge** of the self-host fork, during the conflict-resolution and post-merge verification phases.

Signals that a file or feature is **fork-additive** (and therefore needs its invariant set re-validated, not assumed preserved):

- It appears in the fork but not in upstream's tree at the merge-base, or it carries an explicit `// Fork customization:` comment (e.g. `packages/views/issues/components/issue-detail.tsx:2640`).
- It adds keys present only in some locale bundles (surfaced by the `EN covers every <locale> key` parity assertion).
- It has a fork-specific test block asserting behavior upstream's suite does not know about.

Signals from **parity failures** and how to triage them:

- A burst of `EN covers every <locale> key` failures right after restoring locale keys is the expected roster of fork-only keys — triage each as LIVE (restore + add EN coverage) or DEAD (delete), with a code-reference grep as the deciding proof.
- A `_one`-key dead-plural failure (`packages/views/locales/parity.test.ts:95-111`) in `ja`/`ko`/`zh-Hans` signals orphan plural keys accumulating — prune them, since i18next only resolves `_other` for those locales.

Signal to **stop and verify fork-origin**: you are about to restore a feature that is absent from the merged tree and you cannot point to the fork commit that introduced it. If the absence is because upstream retired the surface in this release, do not restore it.

## Examples

### 1. IssueIdentifierBadge × `getByText` uniqueness collision

The fork adds a standalone tappable `<IssueIdentifierBadge issue={issue} .../>` plus a separate bare-title span in the issue detail header. Upstream v0.4.20's tests use a singular `getByText("Implement authentication")` as a render-complete probe — e.g. `packages/views/issues/components/issue-detail.test.tsx:699` and `:909`. That singular query carries an **implicit invariant: "the bare title text is globally unique in the rendered tree."** Upstream's own breadcrumb leaf renders `{issue.identifier} {issue.title}` as one text node ("MUL-123 Implement authentication"), so the pure title text appears exactly once — in the H1 — and the singular probe passes.

The fork's badge-plus-standalone-title created a *second* bare-title node, so `getByText` threw "Found multiple elements" and 5 tests failed. The 3-way merge compiled clean — the fork had edited `issue-detail.tsx`, upstream had edited `issue-detail.test.tsx`, neither side conflicted textually. **Only running upstream's new test exposed it.** (session history) All five failures shared that single root cause — none were actually about composer/sticky/subscribe despite first appearances.

Resolution (user-chosen, "badge + 合并文本"): keep the breadcrumb leaf as upstream's single merged `{identifier} {title}` text node (`packages/views/issues/components/issue-detail.tsx:2463-2509`), and relocate the badge above the title in the body (`packages/views/issues/components/issue-detail.tsx:2645-2650`), under an explicit `// Fork customization:` comment (`:2640-2644`) recording *why* — "the breadcrumb leaf must stay a single `{identifier} {title}` text node so upstream's `getByText(title)` uniqueness probes keep resolving to the H1." The fork's own leaf-link test was updated to the new contract, asserting the merged-leaf regex `/TES-1\s+Implement authentication/` and the badge-by-role separately (`packages/views/issues/components/issue-detail.test.tsx:794-805`). The merge commit records this: "Phase 5 relocated the badge from the breadcrumb leaf to above the title so upstream's title-uniqueness test probes resolve to the H1 (badge customization preserved, position moved)." Result: issue-detail suite 59/59.

(session history) The generalizable move: when a fork customization and a new upstream constraint are mutually exclusive on the same DOM node, **moving the customization to an adjacent node the constraint doesn't cover beats deleting one or the other.** And because the fork had *also* written its own test asserting "badge sits beside the title inside the same link," that fork test had to be updated to the new structure — demonstrating a fork customization is a code+test bundle, not code alone.

### 2. Locale parity test as the fork-only-key detector

`packages/views/locales/parity.test.ts` flattens each bundle's keys, normalizes i18next plurals (`_one`/`_other` → `_count`, `:42-44`), and asserts symmetric coverage per namespace per locale. The detecting direction is `EN covers every <locale> key` (`:79-84`), which fails on any key present in a translated bundle but absent from English.

After the upgrade restored fork-only keys to the non-EN locales, this assertion surfaced roughly 80 fork-only keys lacking English coverage (9 parity failures) — i.e. it enumerated the fork's locale-only surface automatically. That forced the live-vs-dead triage:

- **LIVE** — `execution_log.view_run` is referenced at `packages/views/issues/components/comment-card.tsx:622` and `:964`; the `welcome_after_onboarding.*` block backs the fork's own live Mika/welcome page at `packages/views/workspace/welcome-after-onboarding.tsx:163-184`. These were restored and given English coverage (now present at `packages/views/locales/en/issues.json:535` and `packages/views/locales/en/onboarding.json`).
- **DEAD** — keys with no remaining code reference were deleted. The merge commit names them: "Phase 5 then pruned genuinely dead keys (token-usage sidebar panel + runtime_aside + step_header — upstream retired those surfaces) and completed EN coverage of the live fork keys (parity gate)."

The parity suite did double duty: it detected the fork-only keys *and* enforced that the kept ones are translated across all four languages. (session history) The back-fill surfaced ~80 missing keys (6 issues + 72 onboarding + 0 layout); 78 had traceable English values in fork `main`'s EN, and the remaining 2 were genuine upstream keys. These were confirmed to be live fork features (Mika onboarding welcome page, runtime aside, token-usage panel) rather than orphans — parity's design intent is exactly to force EN coverage of fork-only keys. After back-fill, parity passed 166/166.

### 3. Verify fork-origin before restoring: the token-usage sidebar

The fork's token-usage sidebar panel was initially assumed to be a fork customization to restore after the merge. Verification showed otherwise: it was **upstream's own old implementation**, which upstream v0.4.20 deliberately deleted in commit `ba129b196` (`feat(issues): show per-run token usage on the execution log (MUL-5762) (#6440)`, a verified ancestor of HEAD on this checkout), replacing the sidebar with per-run execution-log usage (`issue-usage-dialog.tsx`, reworked `execution-log-section.tsx`). "Restoring" the sidebar would have resurrected code upstream intentionally removed and fought the upgrade. The user chose deletion.

(session history) The parity back-fill unexpectedly acted as a *feature-loss detector* here: `detail.section_token_usage` had English values in fork `main` (looked like a live feature) yet had **zero** code references in the reconstructed `issue-detail.tsx`. Investigation revealed the sidebar was upstream's **old** implementation the fork had simply carried forward — upstream v0.4.20 removed it (MUL-5762) in favor of per-run token usage on the execution log, keeping the `/api/issues/:id/usage` endpoint only for the CLI. So "having forgotten to stitch it back" accidentally matched upstream's direction of travel. The still-live `execution_log.view_run` and the 72 live `welcome_after_onboarding` keys were kept; the 6 dead token-usage keys were deleted from all four locales.

The general lesson: before stitching any absent "fork customization" back after a merge, confirm it is fork-originated (present in the fork merge-base, absent from upstream's intent). An absent feature is not automatically a customization to recover — it may be a surface upstream retired in the very release you are merging.

## Related

- `docs/solutions/workflow-issues/merge-conflict-checkout-theirs-drops-fork-only-members.md` — **the sibling learning** (same upgrade, same invariant-set thesis). That doc covers the *overwrite* surface (`checkout --theirs` drops fork-only members within a file → `git merge-file` + loss scan); this doc covers the *test-detection* surface (fork-code × upstream-test collisions → run upstream's new tests + parity detector). Cross-linked bidirectionally; the two are complementary surfaces of one upgrade.
- `docs/solutions/workflow-issues/upstream-type-scale-refactor-fork-only-files-blindspot.md` — sibling "only an executable guard test catches fork-only drift" learning. Type-scale is about a fork-only *file* invisible to the upstream diff (guard = source-text grep test); this doc is about fork *code* colliding with upstream's *new tests* (guard = running upstream's own suite). Same meta-root-cause family.
- `docs/solutions/workflow-issues/run-typecheck-after-upstream-merge.md` — adjacent post-merge verification gate. That doc says "vitest green ≠ tsc green"; this doc adds "the fork's suite green ≠ safe — you must run upstream's *newly-added* tests, which assert invariants the fork's suite doesn't know about."
- `docs/solutions/workflow-issues/safe-upstream-upgrade-with-local-customizations.md` — the canonical upgrade SOP; this doc's "run upstream's new tests + treat each fork customization as an invariant set" rule plugs into its post-merge verification step.
- `docs/solutions/workflow-issues/upstream-orthogonal-signature-double-change-blindspot.md` and `upstream-single-sided-fork-param-convergence-merge.md` — the Strategy D silent-merge family (3-way merge loses one side's intent at the signature level); different detection surface (`go build`) than this doc's test run.
- `docs/solutions/workflow-issues/merge-feature-branch-customized-main.md` — **refresh target**: its Step 1 recommends `checkout --theirs` with no fork-only-member caveat; should cross-link both this doc (test-collision surface) and the sibling (overwrite surface).
- Process artifacts: `docs/upgrades/v0.4.20-plan.md` (Phase 5 record), `docs/customizations.md` ("Last upgrade — v0.4.18 → v0.4.20").
- Referenced upstream/fork commits: `e4b0277ba` (the v0.4.18→v0.4.20 merge), `ba129b196` (upstream MUL-5762, retired the token-usage sidebar). Both are local-fork / upstream commits on this self-host checkout — verified ancestors of HEAD, not yet pushed to origin.
