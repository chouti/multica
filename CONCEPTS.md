# Concepts

Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

---

## Core Entities

### Skill
An agent-loadable instruction set that augments an AI agent's capabilities. Skills are authored as structured documents with metadata, imported from runtimes into workspaces, and can be assigned to agents. Skills have a `root` field indicating their discovery source (provider vs universal), enabling grouping and provenance tracking.
*In Chinese UI copy: keep "skill" in English, do not translate.*

### Runtime
A daemon-managed execution environment that exposes local skills for import. Runtimes are polled for available skills (typically every 500ms with a 30s timeout) and provide the source from which skills are copied into a workspace. Each runtime has a unique ID and status (online/offline).

### Daemon
The local agent process that manages runtime lifecycle, skill discovery, and agent execution. Daemons run on developer machines and expose skills through a discovery API that the backend polls. Its HTTP port is for health/runtime status only — it is not the workspace HTTP API server and does not serve `/api` requests or uploaded files; conflating the daemon with the API server is a common cause of self-host 502s. Older daemons may omit the `root` field on skill records.

### Official Release Baseline
The nearest reachable upstream official release tag a self-hosted build is based on, verified against the canonical upstream release tags at build time. It is embedded into the backend binary or frontend bundle at build time and is intentionally distinct from the checkout's exact commit, dirty state, image tag, and deployment configuration. A build whose baseline cannot be derived and verified against the upstream tags—or explicitly trusted by the operator—must not claim one.

Resolved on the host by `scripts/resolve-official-baseline.sh`, which verifies the candidate against the canonical upstream (`https://github.com/multica-ai/multica`) via `git ls-remote`. The single canonical-upstream URL constant lives in that script — a heavily-forked deployment that tracks a different upstream should retarget it in one place.

The frontend (`packages/core/config`) and backend (`server/cmd/server/provenance_baseline.go`) each run an `officialBaseline` sanitizer that maps `""`, `"dev"`, any non-`^v\d` string, any `-dirty` value, and any `git describe` commit-distance suffix (`-N-g<hash>`) to empty. An empty baseline is omitted from `/api/config` (`server_version` is `omitempty`) and rendered as "unavailable" in the Help menu — a deliberate silent-failure so an unstamped build never presents a hash or "dev" as a release baseline. The corollary operators hit: a forgotten re-stamp after an upgrade looks like "backend broken" while the service is healthy.

### Member
A human user's presence in one workspace — the join of a global human identity to a specific workspace. The person behind it carries a single **global user id** shared across every workspace; a member mention is resolved by that global user id joined to the workspace, so it is workspace-portable and needs no re-localization when content is copied between workspaces. A member's own per-workspace row id is **not** what a member mention resolves on. Contrast with **Agent**, whose id is per-workspace. Corollary for any reference: verify it against the field the resolution path actually filters on (here, the global user id), not merely by whether some id value exists in a table.

### Agent
An AI worker inside a workspace, first-class as an assignee that can own issues, comment, and change status. An agent is a **per-workspace entity with an independent id** — the "same" agent (e.g. the same persona) in two workspaces is two distinct rows with two distinct ids, with no shared identity across workspaces. Agent references (`mention://agent/<id>`, roster/routing tables) are therefore workspace-local and must be re-localized per workspace when configuration is copied; member references are not (see **Member**).

---

## Status Concepts

### Root
A skill's discovery source classification. Values: `provider` (runtime's own skill directory, e.g., `~/.claude/skills`), `universal` (cross-tool fallback directory, e.g., `~/.agents/skills`), or `undefined` (older daemons). Used for grouping skills in search interfaces. Skills with undefined root are bucketed into an "Other" group rather than dropped.

### Branch (UI)
A conditional rendering path in adaptive UI components. Computed directly from data (e.g., item count) in render, never synchronized via state + effect. Pattern: `branch = data.length === 0 ? "empty" : data.length <= 2 ? "summary" : "search"`. Ensures UI stays in lockstep with data and avoids transient off-by-one render bugs.

### Issue Status Category
The equivalence class a custom issue status declares in order to inherit platform behavior. A category's name is a built-in status key, and membership means full behavioral inheritance — counts, terminality, filtering, lifecycle — not a loose grouping: two statuses share a category only when the platform treats them identically. A status that differs from every built-in on any behavior axis therefore cannot be expressed as a category and must ride as a pseudo-builtin instead.

### Closed-not-completed
The fork's `archived` issue-status semantics: terminal for stage barriers and hidden from default lists like a closed status, yet NOT counted as completed in done-statistics or eligible for auto-archiving, unlike done/cancelled. The split is why archived cannot be expressed as a cancelled-category custom status — category inheritance is all-or-nothing, and cancelled carries exactly the two behaviors archived exists to avoid.

---

## Processes

### Skill Import
The act of copying a skill from a runtime into a workspace. Imports can be single (one skill) or bulk (multiple skills). Bulk imports may encounter name conflicts, which are resolved via overwrite, rename, or skip decisions. The import flow preserves selection state across UI branch switches when the dialog remains open.

### Skill Mention Gesture
The explicit "pick an agent" action attached to a `@skill` mention chip in the comment composer. Designating an agent and submitting durably binds the skill to that agent (when not already bound) and enqueues the agent to run with the skill's full bundle. Since the auto-bind redesign (2026-08-18), a chip inserted through the typed @-menu auto-opens the agent picker without stealing focus, pre-filled with the recommended agent (explicit `@agent` mention > reply-parent > conversation-continuation > issue assignee) — dismissing the popover (Esc, click-away, first keystroke, or submitting as-is) accepts that recommended default, so submit alone produces the binding. An explicit picker gesture (select or clear) always outranks the recommendation and is never machine-overridden; chips arriving by paste, undo, or draft hydration keep the manual chip-click gesture. A chip with no eligible candidate agent still reverts to plain text and never triggers on its own. This replaces the earlier binding-table reverse-lookup routing (`resolveSkillMentionTrigger`).

**Bind and run are decoupled.** The durable `agent_skill` row created by designating is independent of which trigger path (the explicit `@skill` mention or an implicit reply-parent / assignee / conversation-continuation) ends up enqueuing the task. Even if the comment's R5 trigger dedup keeps the agent's implicit trigger and drops the skill duplicate, the designated agent is still bound to the skill — the bind pass keys off the designated-agent map, not off the surviving trigger's source. Conversely, suppressing the agent this turn stops the run but does not undo the bind; the durable row persists for future runs. See `docs/solutions/logic-errors/bind-on-skip-when-dedup-rewrites-source.md` for the failure mode that motivated this invariant.

---

## Fork Maintenance

Vocabulary of maintaining this self-host fork against its upstream — the upgrade loop, the merge-resolution patterns, and the artifacts that carry state between sessions.

### Customization Ledger
The persistent record of every customization this fork carries relative to upstream, keyed by feature with its upstream-PR status and the files it touches. Rows live in status tables — open PR, adopted upstream, closed, withdrawn, pure-local — and move between them as upstream merges or rejects. A row that lags reality is itself a hazard in both directions: an un-recorded cluster is invisible to merge planning, and a cluster recorded as an open fork PR that upstream has since merged leaves the fork carrying a redundant "ghost" copy — ledger status is knowledge that expires and must be re-verified against the tracker every upgrade.

### Upgrade Plan Artifact
The resumable per-upgrade record that makes a long, interruptible upgrade safe to hand off: a single-value phase state machine (audit, preview, resolve, verify, gates, record, done), a checklist of irreversible-step gates, and adversarially-verified negative claims — each "we proved upstream is NOT doing X" entry carries the raw command that confirmed it. Phase values advance only as a phase genuinely completes so the artifact always reflects what is true on disk; the irreversible steps (DB migration, service restart) unlock only from the completed-verification state, never from intent, and the merge commit is recorded before them because the version re-stamp resolves the release tag from committed history.

### Strategy D (orthogonal-signature merge)
The merge-resolution pattern for when fork and upstream each extend the SAME function signature along independent axes — the fork adds a parameter upstream never had, upstream adds a different one or changes the return. The resolution is the UNION of both extensions, never either side: picking a side silently drops the other axis's functionality with no conflict marker. Mirror case: when upstream fully refactors the function and drops the fork's axis entirely, auto-merge quietly keeps the fork side and the danger moves from compilation to behavior — detected by the count asymmetry (symbol present at HEAD, absent in the upstream tag), not by any build gate.

### Compose-and-Keep
The merge-resolution pattern for when upstream ships a NEW system into a domain where the fork already carries a customization and the two conflict on data semantics — the new system's own files merge without a single conflict marker (nothing in the fork touches them yet), and while the old carrier files may still text-conflict on predicate lines, conflict markers carry no decision about how the fork's member should be expressed in the new model. The fork's extra member rides as a pseudo-builtin inside the new system's single resolution choke-point instead of surviving as parallel code or per-call-site patches. The new system's canonical vocabulary (seeding, ranking, category membership) deliberately stays upstream-shaped so upstream's future evolution does not overlap the fork delta; predicates both sides rewrote in opposite directions are composed — the new system's resolution function wrapped in the fork's classification — never chosen between. The carried surface is a replay set: every future upgrade that touches the domain must re-apply it, and a merge that resolves "clean" without replaying it is silently running broken semantics. See `docs/solutions/workflow-issues/fork-archived-status-semantic-collision-compose-into-upstream-issuestatus.md`.

### Pseudo-builtin
A member that the resolution layer of a system treats as built-in — accepted on writes, listed in validation messages, resolving to itself — while the system's canonical vocabulary (category set, catalog seeding, ranking) does not know it. The position exists for members whose semantics match no canonical category: declaring one would be a behavioral lie, so they must be recognizable without being classified.

### Fork Invariant Set
The principle that one fork customization is not one code change but a set of members spanning code + tests + every locale file, and every merge resolution must preserve the whole set. The unit of preservation is the fork-only member — a locale key, client method, route, or export that exists only on the fork side; whole-file conflict resolutions (`--theirs` / `--ours`) delete them silently and without a build failure. Completeness is verified by the **Loss Scan**, not by the absence of conflict markers; upstream's own tests collide with the set only at test time, so a merge that compiles clean has not yet proven the set intact.

### Loss Scan
The completeness check that turns "we think we kept everything" into a verifiable assertion: deep-flatten the fork's pre-merge state (every JSON key, every method/export name) and subtract the post-resolution state — the result must be empty. Run after every conflict resolution, not only after side-picking: a careful hand-merge drops a fork-only member just as silently as `--theirs`. Missing live members are restored add-only first; genuinely dead members (upstream retired the feature) are pruned only with code-reference proof.

---

## Agent Access

### AccessScope
The three-state model describing who can invoke (trigger) an agent: **workspace** (any workspace member, plus internal agents and system triggers), **specific-people** (only named members or teams designated as invocation targets), or **owner-only** (only the agent's owner). Derived from two backend fields — `permission_mode` ("private" or "public_to") and `invocation_targets` (workspace/member/team targets) — but is the operator-facing conceptual model displayed in the agents list UI. The legacy `visibility` field is a lossy two-state projection of this model (maps both "specific-people" and "owner-only" to "private"), so UI surfaces should use the three-state AccessScope, not the derived `visibility`, to avoid misleading operators.

---

## Principles

### Script as Source of Truth
The principle that any value (metric, count, classification, judgment) the spec promises must be produced deterministically by a script or reproducible component. The agent only locates, copies, sequences, and presents — it does not re-derive business values. When the deterministic source has no value for a field, the deliverable shows `—` and surfaces the gap rather than letting the agent improvise. The corollary operators hit: a script that is silent on a promised field produces drift, since the agent has no choice but to invent to complete the task; a rule that says "copy from the script" without a script value produces blanks or fabrications, defeating the rule. See `docs/solutions/workflow-issues/agent-script-as-source-of-truth.md` for the day-by-day fix pattern and the failure table.

### Deterministic vs Self-Judgment
The architectural distinction between a value derived from a defined algorithm (deterministic, reproducible across reruns) and a value produced by the agent's own LLM judgment (self-judgment, varies with context, path, and rerun state). The boundary is the operator's defense against drift: anything that a downstream reader or auditor could ask "why this number?" about must live on the deterministic side; only free-form narrative summaries whose wording is allowed to vary belong on the self-judgment side. See `docs/solutions/workflow-issues/agent-script-as-source-of-truth.md` for the worked example where this distinction turned noisy reports into stable ones.

### Verification Gate Ladder
The ordered levels of automated verification a change can pass through — compile (typecheck, build), test-compilation (lint/vet), execution (actually running tests or binaries), and production (health checks, live behavior). Each rung sees strictly more than the rung above it: a defect class invisible at compile level — here an init-time registration panic — can be plain at execution level. But ladders have a floor: a semantic collision between two systems is visible at NO rung once the merge is resolved — nothing fails, and tests pinned to the old contract get re-pinned rather than break — so it is detectable only by domain-level audit (asking what the upstream system means for fork data), not by adding gates. Three recurring failure modes: a gate list stabilizes at one rung because its catches keep validating it, so defects below that rung pass indefinitely (a green list proves only what its rungs can see, never that the code runs); a gate that is structurally unavailable on the host — a container-gated test entry on a container-less host — exits the routine silently rather than failing loudly; and a gate that fires outside the watched routine — a CI run whose red result nobody reads — is functionally absent even though it exists and fired. See `docs/solutions/runtime-errors/duplicate-pflag-registration-init-panic-invisible-to-static-gates.md` for the case where all three combined to hide a package-init panic for a month of green upgrades, and `docs/solutions/workflow-issues/fork-archived-status-semantic-collision-compose-into-upstream-issuestatus.md` for the below-the-floor class.

### Edit Layer vs Read Layer
The architectural distinction between *where a change is written* and *where a runtime reads from*. In multi-replica / multi-runtime systems the two can drift silently — Hermes-local skill copies vs Multica-workspace skill copies, Git branches vs deployed tags, Docker images vs running containers, K8s namespaces vs production routing. Edits to the wrong layer produce no error and no warning; the runtime simply keeps reading its own copy. The discipline is to verify the read layer *before* editing, then edit that same layer, then verify the runtime's view moved. See `docs/solutions/integration-issues/autopilot-reads-workspace-skill-not-hermes-local.md` for the protocol and the 2026-07-29 YUP-470 incident where 17 turns of "已修复" had no autopilot-visible effect.

### Invariant vs Proxy Verification
The discipline that a verification command written to confirm "no X happened" (no hazard fired, no feature lost, no symbol collided) must prove the **user-visible invariant** the operator actually relies on — a runtime behavior such as call-site liveness, feature behavior, or cursor coverage — and not a **proxy** for it (symbol definition count, file presence, declaration, hook name). The distinction that makes it non-obvious: the fork's existing member-preservation defenses all verify that a member is *present* in the merged tree; none verify that it is still *reached* by the runtime call graph. Call-site liveness is an independent dimension, not a refinement of membership — a member can be present, compiled, tested, and silently dead — so a merge that compiles clean and passes every test does not discharge a claim about a runtime invariant. The corollary operators hit: a "no redeclaration" or "definition unique" check is treated as proof of "the protection is live," and a "the hooks are gone" finding is treated as proof of "the feature is lost," when neither follows. See `docs/solutions/workflow-issues/negative-claim-must-prove-user-invariant.md` for the three-question self-check and the recurring-across-upgrades evidence.

---

## Relationships

- A **Runtime** exposes many **Skills**, each with a **Root** classification.
- A **Daemon** manages one or more **Runtimes** on a local machine.
- **Skill Import** transfers a **Skill** from a **Runtime** into a workspace.
- **Branch (UI)** determines which rendering path is shown based on skill count in a list dialog.
- An **Official Release Baseline** identifies the upstream release context of a running backend or frontend artifact without asserting that the artifact is an unmodified official image.
- A **Member** is a global human id joined to one workspace, so a member reference is workspace-portable; an **Agent** is scoped to one workspace, so an agent reference is workspace-local and must be re-localized on copy.
- **Script as Source of Truth** and **Deterministic vs Self-Judgment** are the same boundary seen from two sides: the principle names the discipline the spec must enforce, the distinction names the line the agent must not cross.
- **Edit Layer vs Read Layer** is the orthogonal discipline for change propagation: the layer the operator edits must be the same layer the runtime reads, and verification must compare `updated_at` before and after. Skipping this discipline produces silent drift even when the rule itself is correct.
- **Invariant vs Proxy Verification** is the audit-phase member of the same verification-discipline family: where **Edit Layer vs Read Layer** governs *where* a change takes effect and **Script as Source of Truth** governs *who* produces a value, **Invariant vs Proxy Verification** governs *what a verification command actually proves* — and notes that the fork's member-preservation defenses cover membership but not call-site reachability, so compile-clean + test-green does not discharge a behavioral claim.
- **Verification Gate Ladder** names the coverage dimension **Invariant vs Proxy Verification** presupposes: *which rung of gate can even see the claimed invariant*. A claim verified only at compile or test-compilation level has not been tested against the execution-level defects below it, so "the gate list is green" and "the code runs" are different statements.
- A **Customization Ledger** row enumerates the members of a **Fork Invariant Set**; the **Loss Scan** verifies the set survived a merge; an **Upgrade Plan Artifact** records the per-file strategies — including where **Strategy D (orthogonal-signature merge)** applies — and gates the irreversible steps on completed verification.
- **Verification Gate Ladder** governs which defect classes the upgrade's gates can even see; **Fork Invariant Set** + **Loss Scan** govern what a merge result must be checked against — membership-and-reachability is a different axis from gate coverage, and a green gate list does not discharge a loss scan.
