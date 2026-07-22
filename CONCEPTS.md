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

---

## Status Concepts

### Root
A skill's discovery source classification. Values: `provider` (runtime's own skill directory, e.g., `~/.claude/skills`), `universal` (cross-tool fallback directory, e.g., `~/.agents/skills`), or `undefined` (older daemons). Used for grouping skills in search interfaces. Skills with undefined root are bucketed into an "Other" group rather than dropped.

### Branch (UI)
A conditional rendering path in adaptive UI components. Computed directly from data (e.g., item count) in render, never synchronized via state + effect. Pattern: `branch = data.length === 0 ? "empty" : data.length <= 2 ? "summary" : "search"`. Ensures UI stays in lockstep with data and avoids transient off-by-one render bugs.

---

## Processes

### Skill Import
The act of copying a skill from a runtime into a workspace. Imports can be single (one skill) or bulk (multiple skills). Bulk imports may encounter name conflicts, which are resolved via overwrite, rename, or skip decisions. The import flow preserves selection state across UI branch switches when the dialog remains open.

### Skill Mention Gesture
The explicit "pick an agent" action attached to a `@skill` mention chip in the comment composer. A `@skill` chip is inert until the gesture designates an available agent; designating one and submitting durably binds the skill to that agent (when not already bound) and enqueues the agent to run with the skill's full bundle. A chip with no designated agent reverts to plain text and never triggers on its own. This replaces the earlier binding-table reverse-lookup routing (`resolveSkillMentionTrigger`).

---

## Agent Access

### AccessScope
The three-state model describing who can invoke (trigger) an agent: **workspace** (any workspace member, plus internal agents and system triggers), **specific-people** (only named members or teams designated as invocation targets), or **owner-only** (only the agent's owner). Derived from two backend fields — `permission_mode` ("private" or "public_to") and `invocation_targets` (workspace/member/team targets) — but is the operator-facing conceptual model displayed in the agents list UI. The legacy `visibility` field is a lossy two-state projection of this model (maps both "specific-people" and "owner-only" to "private"), so UI surfaces should use the three-state AccessScope, not the derived `visibility`, to avoid misleading operators.

---

## Relationships

- A **Runtime** exposes many **Skills**, each with a **Root** classification.
- A **Daemon** manages one or more **Runtimes** on a local machine.
- **Skill Import** transfers a **Skill** from a **Runtime** into a workspace.
- **Branch (UI)** determines which rendering path is shown based on skill count in a list dialog.
- An **Official Release Baseline** identifies the upstream release context of a running backend or frontend artifact without asserting that the artifact is an unmodified official image.
