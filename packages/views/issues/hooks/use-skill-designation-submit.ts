"use client";

/**
 * U6 — the description-editor skill-designation submit pipeline (edit path).
 *
 * Wires the manual-mode description editor's `skillMentionAgents` map into
 * the update mutation payload with three guarantees carried over from the
 * parent auto-bind plan and its KTDs:
 *
 *  - **KTD1 (single-consumption)** — submitting the same
 *    `skill_mention_agents` payload twice would produce two duplicate enqueue
 *    tasks; the server has no idempotency layer on this path (the comment
 *    path is no better — only the pending-task unique index catches it,
 *    and only AFTER the second request lands). The hook tracks an in-flight
 *    `useRef<boolean>` so the second invocation short-circuits with no
 *    network effect.
 *  - **D1 (failure keeps pending)** — if the FIRST submit fails, the chip
 *    stays in `skillMentionAgents` and the next autosave / popover-close /
 *    explicit retry re-sends the same payload. The hook restores nothing
 *    itself — the composer owns `skillMentionAgents` — but exposes
 *    `lastError` so the consumer can render a "failed, will retry" toast.
 *  - **R10 / AE8 (touch-only)** — submission only happens when the upstream
 *    signal marks a real user gesture (`user-typing` / `paste`); programmatic
 *    seeds (manual→agent mode switch, undo / redo / spell intermediate
 *    states, autosave debounce ticks that touched nothing new) are ignored.
 *
 * The create path uses the existing `useComposerSubmit` + `finalizeSkillMentionAgents`
 * flow rather than this hook — the create handler has to do post-create
 * property / child / label work that the hook cannot replicate. The hook
 * owns the EDIT path because that's where KTD1 / R10 / AE8 matter: an edit
 * autosave fires on every keystroke (debounced 1500ms) and a touch-only
 * `updateIssue` runs without a description change (AE8) — the single-
 * consumption guard is the only thing that prevents duplicate enqueues.
 *
 * KD5 still binds: the agent-mode prompt carries no skill designation, and
 * this hook only ever reads the manual-mode `skillMentionAgents` map. A
 * future agent-mode path is out of scope.
 */

import { useCallback, useRef, useState } from "react";
import { useUpdateIssue } from "@multica/core/issues/mutations";
import type {
  IssueSkillDesignationOutcome,
  UpdateIssueRequest,
} from "@multica/core/types";
import { parseIssueSkillDesignationOutcomes } from "@multica/core/issues/comment-trigger-outcomes";

/** Sources the upstream editor may pass to `submit()` (R10 / AE8).
 *
 *  - `user-typing` — the user typed new content into the description editor
 *    since the last autosave. The trigger fires.
 *  - `paste` — the user pasted new content (markdown carry-in). The trigger
 *    fires; a pasted @skill chip does NOT count as a user gesture for
 *    auto-fill (U5) but DOES count as one here because the chip landed in
 *    the doc and any pending designation applies to it.
 *  - `undo` / `spell` / `mode-switch` / `autosave` / `other` — programmatic
 *    or non-content edits. The hook short-circuits; no submission, no
 *    snapshot, no toast surface touched. AE8 lives here too — a popover-only
 *    touch with no description change goes through `autosave`, NOT
 *    `user-typing`, so the autosave listener routes the bare designation
 *    payload through `submit({ source: "user-typing" })` directly (the host
 *    knows the difference).
 */
export type SkillDesignationSubmitSource =
  | "user-typing"
  | "paste"
  | "undo"
  | "spell"
  | "mode-switch"
  | "autosave"
  | "other";

/** Touch-only sources that DO trigger a submit. All other sources are
 *  ignored (R10 / AE8 / KD8). `paste` is included because a pasted @skill
 *  chip is a content change the user made — the chip lands in the doc and
 *  any pending designation applies to it; programmatic auto-fill does NOT
 *  count (U5) but the designation itself can. */
const TOUCHED_SOURCES: ReadonlySet<SkillDesignationSubmitSource> = new Set([
  "user-typing",
  "paste",
]);

/** Map an `updateIssue` mutation result back into outcomes. Mirrors what
 *  `createIssue` does — the client receives the same field shape on both
 *  paths (KTD10). Returns [] when the body is unparseable / the field is
 *  absent so the caller can render the empty-state. */
function outcomesFromUpdateResponse(raw: unknown): IssueSkillDesignationOutcome[] {
  if (!raw || typeof raw !== "object") return [];
  const outcomes = (raw as { skill_designation_outcomes?: unknown })
    .skill_designation_outcomes;
  return parseIssueSkillDesignationOutcomes(outcomes);
}

export interface UseSkillDesignationSubmitParams {
  /** Edit-path identifier — the issue being updated. */
  issueId: string;
  /** Composer-held `skillMentionAgents` map (the same one `useSkillAutoBind`
   *  writes into). The hook reads it synchronously inside `submit`; React
   *  state is fine here because the host's submit handler always closes
   *  over the latest map through its render. */
  skillMentionAgents: Record<string, string[]>;
  /** Optional hook for the consumer to react to a successful submission
   *  (the post-settle toast, the run-visibility refresh). The mutation
   *  itself already takes care of cache reconciliation. */
  onSuccess?: (outcomes: IssueSkillDesignationOutcome[]) => void;
  /** Optional hook for failures — the consumer can attach an inline error
   *  toast (KTD1: the user MUST see something went wrong). The default is
   *  no-op so the consumer controls copy entirely. */
  onError?: (err: Error) => void;
}

export interface UseSkillDesignationSubmitResult {
  /** Fire one submission attempt. Returns the outcomes (or null on a no-op
   *  source / single-consumption short-circuit / failure). The host may
   *  ignore the return value when it doesn't need to render R16 feedback
   *  inline; the toast layer reads the mutation onSuccess hook instead. */
  submit: (opts?: {
    source?: SkillDesignationSubmitSource;
    /** Edit-path extras — passed through to `updateIssue` alongside the
     *  designation payload so the popover-only "touch" trigger can ride the
     *  same autosave machinery (R10 / AE8). The consumer's autosave already
     *  passes the description + description_base; this hook only adds
     *  `skill_mention_agents`. */
    extras?: Partial<UpdateIssueRequest>;
  }) => Promise<IssueSkillDesignationOutcome[] | null>;
  isSubmitting: boolean;
  lastError: Error | null;
}

export function useSkillDesignationSubmit({
  issueId,
  skillMentionAgents,
  onSuccess,
  onError,
}: UseSkillDesignationSubmitParams): UseSkillDesignationSubmitResult {
  const updateIssueMutation = useUpdateIssue();

  // Single-consumption guard (KTD1). `useRef<boolean>` because every render
  // rebuilds the closures; a useState would mark isSubmitting=true twice on
  // a back-to-back call before the first one settled. The ref is local to
  // the hook instance, so re-mounting the editor (issueId switch) re-arms
  // it for the new submission.
  const inFlightRef = useRef(false);
  // Last-error mirror — exposed to the host so a toast layer can render
  // "failed, will retry" without each call having to re-derive. Cleared on
  // a successful subsequent submit so the user doesn't see a stale error
  // after a successful retry. Backed by useState so the host re-renders
  // when the value flips (a toast layer only re-renders on a re-render).
  const [lastError, setLastError] = useState<Error | null>(null);

  const submit = useCallback(
    async (opts?: {
      source?: SkillDesignationSubmitSource;
      extras?: Partial<UpdateIssueRequest>;
    }): Promise<IssueSkillDesignationOutcome[] | null> => {
      const source: SkillDesignationSubmitSource = opts?.source ?? "user-typing";
      // Touch-only gate (R10 / AE8 / KD8). A programmatic source is a no-op;
      // do not consume, do not snapshot, do not toast.
      if (!TOUCHED_SOURCES.has(source)) {
        return null;
      }
      // Single-consumption guard (KTD1). A second invocation before the
      // first settled is a no-op. We do not throw — callers chain onSubmit
      // handlers and a throw would surface as a misleading "submit failed"
      // in their error path.
      if (inFlightRef.current) {
        return null;
      }
      // Empty map → no designation to send. The server interprets the
      // omitted field as "do not touch bindings" (R12), but sending `{}`
      // would explicitly clear — a behavior the user did not ask for here.
      // Skip the network call entirely.
      const entries = Object.entries(skillMentionAgents);
      if (entries.length === 0) {
        return null;
      }
      const payload: Record<string, string[]> = {};
      for (const [skillId, agentIds] of entries) {
        // Skip entries with empty agent lists — same reasoning as
        // `finalizeSkillMentionAgents` in the comment composer. A touched
        // empty list means "I explicitly chose nothing"; we honor that as a
        // no-op designation (R12 silent no-op contract).
        if (!agentIds || agentIds.length === 0) continue;
        payload[skillId] = [...agentIds];
      }
      if (Object.keys(payload).length === 0) {
        return null;
      }

      inFlightRef.current = true;
      setLastError(null);
      try {
        // Edit path: route through `useUpdateIssue` so cache reconciliation
        // + the surgical control-field stripping matches every other
        // description save. `extras` carries description / description_base /
        // suppress_run / handoff_note so a touch-only submit (AE8) can ride
        // the same autosave plumbing; the host's autosave already calls
        // `submit({ extras })` with the same body it would have sent.
        const requestBody: UpdateIssueRequest = {
          ...(opts?.extras ?? {}),
          skill_mention_agents: payload,
        };
        const response = (await updateIssueMutation.mutateAsync({
          id: issueId,
          ...requestBody,
        })) as unknown;
        const outcomes = outcomesFromUpdateResponse(response);
        onSuccess?.(outcomes);
        return outcomes;
      } catch (err) {
        // D1: keep the chip pending. The host owns `skillMentionAgents`,
        // so we only surface the error. `lastError` survives so a retry
        // can re-submit the same payload + source.
        const wrapped = err instanceof Error ? err : new Error(String(err));
        setLastError(wrapped);
        onError?.(wrapped);
        // The host's retry calls `submit()` again with the same source
        // and the live (unchanged) `skillMentionAgents` map. The single-
        // consumption guard has cleared by this point (we left the try
        // block), so the retry proceeds — exactly D1's contract.
        return null;
      } finally {
        inFlightRef.current = false;
      }
    },
    [
      skillMentionAgents,
      issueId,
      updateIssueMutation,
      onSuccess,
      onError,
    ],
  );

  return {
    submit,
    // Reactive mirror of the in-flight flag. Reads happen between renders
    // (e.g. from the editor's onUpdate closure), so a `useState`-flavored
    // mirror would be stale until the next paint. We rely on the consumer
    // reading `isSubmitting` either in the same tick as `submit()` returns
    // (still true) or via a re-render after the mutation settles (already
    // back to false) — both are correct.
    isSubmitting: inFlightRef.current,
    lastError,
  };
}
