/**
 * Pure timestamp utilities shared between the Help menu's runtimes selector
 * (`packages/core/runtimes/select-cli-version.ts`) and the Runtimes surfaces
 * (`packages/views/runtimes/components/runtime-machines.ts`). Keeping these in
 * `packages/core/runtimes` lets both call sites use the same "most-recent
 * report" ordering without duplicating the `last_seen_at ?? updated_at`
 * fallback or the NaN guard.
 */
import type { AgentRuntime } from "@multica/core/types/agent";

/**
 * Wall-clock milliseconds since the unix epoch for the runtime's most recent
 * report. Falls back to `updated_at` when `last_seen_at` is absent, and to
 * `0` when neither parses as a date — sort-stable for "never reported" rows.
 */
export function runtimeReportTime(runtime: AgentRuntime): number {
  const reportedAt = runtime.last_seen_at ?? runtime.updated_at;
  const timestamp = Date.parse(reportedAt);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

/** Descending comparator: the most recently reported runtime sorts first. */
export function compareRuntimeReports(a: AgentRuntime, b: AgentRuntime): number {
  return runtimeReportTime(b) - runtimeReportTime(a);
}
