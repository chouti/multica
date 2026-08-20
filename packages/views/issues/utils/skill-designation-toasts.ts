"use client";

import { toast } from "sonner";
import {
  bindOnlyIssueSkillDesignationOutcomes,
  unhandledIssueSkillDesignationOutcomes,
} from "@multica/core/issues/comment-trigger-outcomes";
import type { IssueSkillDesignationOutcome } from "@multica/core/types";
import { useT } from "../../i18n";
import { blockedShortReasonLabel, type IssuesT } from "../blocked-trigger-copy";

/**
 * U7 — post-create / post-edit designation outcome feedback (R13 / R16).
 *
 * Bind-only outcomes (`bound` / `merged` statuses) deserve a per-agent toast:
 * a durable binding wrote but no run was requested, so the user sees WHO the
 * skill landed on. Triggered outcomes (`queued` / `coalesced`) are visible
 * through the normal run channel — no extra toast needed (Q8 default).
 * Blocked outcomes aggregate into ONE warning toast regardless of N, with
 * the reason codes joined into a short summary. A malformed / missing
 * outcomes array is a no-op; the calling mutation's own success / error
 * toast already covers the happy path.
 *
 * Both create and edit paths call this with the parsed outcomes — the create
 * path parses off `issue.skill_designation_outcomes` (server returns the
 * field inline), the edit path parses it inside `useSkillDesignationSubmit`
 * and `surfaceActions.updateIssue`. KTD10 keeps the shape identical so the
 * same helper handles both.
 *
 * Two translators are required because the keys live under different
 * namespaces today: `skill_designation.*` lives under modals, while
 * `comment.trigger_blocked_short_*` lives under issues. Callers must
 * pass both from the same `useT` so the i18next instance has both
 * namespaces loaded (the test setup must mirror that — see
 * `create-issue.test.tsx` / `issue-detail.test.tsx` `TEST_RESOURCES`).
 */

export function surfaceDesignationOutcomes({
  outcomes,
  getActorName,
  tModals,
  tIssues,
}: {
  outcomes: IssueSkillDesignationOutcome[];
  /** Pass-through to the shared actor resolver. The skill_designation
   *  outcome carries the target_id (agent UUID) but no name — the wire
   *  intentionally omits private-target names, so we recover them from the
   *  caller's local directory. */
  getActorName: (type: "agent", id: string) => string;
  /** Localizer for the `modals.skill_designation.*` keys (bind-only
   *  toast copy). */
  tModals: ReturnType<typeof useT<"modals">>["t"];
  /** Localizer for the `issues.comment.trigger_blocked_short_*` keys
   *  (blocked reason summary). */
  tIssues: IssuesT;
}) {
  const bindOnly = bindOnlyIssueSkillDesignationOutcomes(outcomes);
  // Aggregate bind-only entries by agent so a single agent bound to N
  // skills renders once (R13 — "指出绑定 agent"). The bound count per
  // agent = number of bind-only outcomes for that target_id.
  const bindOnlyByAgent = new Map<string, number>();
  for (const outcome of bindOnly) {
    if (outcome.target_type !== "agent") continue;
    bindOnlyByAgent.set(
      outcome.target_id,
      (bindOnlyByAgent.get(outcome.target_id) ?? 0) + 1,
    );
  }
  for (const [agentId, count] of bindOnlyByAgent) {
    const agentName = getActorName("agent", agentId);
    toast.success(
      tModals(($) => $.skill_designation.outcome_bound, {
        count,
        agent: agentName,
      }),
    );
  }

  const blocked = unhandledIssueSkillDesignationOutcomes(outcomes);
  if (blocked.length === 0) return;
  // Aggregate reason codes per `blockedShortReasonLabel` so multiple
  // refusals sharing a reason collapse ("invocation_not_allowed +
  // runtime_offline" → "permission; runtime offline"). Deduplicated + joined
  // for the toast. The blocked-trigger-copy helper carries the same
  // vocabulary as the composer preview chip so the warning copy is
  // consistent.
  const seen = new Set<string>();
  const reasons: string[] = [];
  for (const outcome of blocked) {
    const label = blockedShortReasonLabel(outcome.reason_code, tIssues);
    if (seen.has(label)) continue;
    seen.add(label);
    reasons.push(label);
  }
  toast.warning(
    tModals(($) => $.skill_designation.outcome_blocked, {
      count: blocked.length,
      reasons: reasons.join(", "),
    }),
  );
}