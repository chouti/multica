"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { IssueSkillDesignationOutcome, UpdateIssueRequest } from "@multica/core/types";
import type { IssueCreateDefaults } from "./types";

export type IssueSurfaceMutationOptions = {
  errorMessage?: string;
  onSuccess?: () => void;
  /** U7 — fires with the parsed `skill_designation_outcomes` from the
   *  response body (R13 / R16 / KTD10). Mirrors `useSkillDesignationSubmit`'s
   *  own callback so the description autosave can surface bind-only /
   *  blocked toasts alongside the touch-only submit path. */
  onOutcomes?: (outcomes: IssueSkillDesignationOutcome[]) => void;
  onError?: (err: unknown) => void;
  onSettled?: () => void;
};

export interface IssueSurfaceActions {
  isPending: boolean;
  createIssue: (defaults?: IssueCreateDefaults) => void;
  updateIssue: (
    issueId: string,
    updates: Partial<UpdateIssueRequest>,
    options?: IssueSurfaceMutationOptions,
  ) => void;
  moveIssue: (
    issueId: string,
    updates: Partial<UpdateIssueRequest>,
    options?: IssueSurfaceMutationOptions,
  ) => void;
  batchUpdate: (
    issueIds: string[],
    updates: Partial<UpdateIssueRequest>,
  ) => Promise<void>;
  batchDelete: (issueIds: string[]) => Promise<void>;
}

const IssueSurfaceActionsContext = createContext<IssueSurfaceActions | null>(
  null,
);

export function IssueSurfaceActionsProvider({
  actions,
  children,
}: {
  actions: IssueSurfaceActions;
  children: ReactNode;
}) {
  return (
    <IssueSurfaceActionsContext.Provider value={actions}>
      {children}
    </IssueSurfaceActionsContext.Provider>
  );
}

export function useIssueSurfaceActionsOptional() {
  return useContext(IssueSurfaceActionsContext);
}
