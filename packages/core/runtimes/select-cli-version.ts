/**
 * Cross-list representative selector for the Help-menu CLI version row.
 *
 * The Help menu displays a single "CLI" version (most-recently-active
 * daemon) — it cannot carry the full set of connected daemons in the
 * compact sidebar slot, and per-machine aggregation already lives in the
 * Runtimes surfaces. This selector picks one representative across the
 * entire `AgentRuntime[]` list using the same ordering rule as the per-machine
 * `currentMachineMetadata` helper in `packages/views/runtimes/components/runtime-machines.ts`
 * (online first, then most-recently-reported), but iterates the cross-list
 * set instead of a single machine's rows and falls through to the next
 * daemon when the top-ranked row carries no `cli_version`.
 *
 * Pure function over `AgentRuntime[]` — no React Query, no config store.
 */
import type { AgentRuntime } from "@multica/core/types/agent";
import { compareRuntimeReports } from "./runtime-report-time";
import { readRuntimeCliVersion } from "./cli-version";

/** Pick the most-recently-active daemon's `cli_version`, falling through to
 *  the next online (then any) row when the top-ranked row has no value.
 *  Returns null when no row has a `cli_version`. */
export function selectRepresentativeCliVersion(runtimes: AgentRuntime[]): string | null {
  if (!runtimes || runtimes.length === 0) return null;
  const online = runtimes.filter((runtime) => runtime.status === "online");
  const candidates = online.length > 0 ? online : runtimes;

  for (const runtime of candidates.toSorted(compareRuntimeReports)) {
    const v = readRuntimeCliVersion(runtime.metadata);
    if (v.trim()) return v;
  }
  return null;
}

