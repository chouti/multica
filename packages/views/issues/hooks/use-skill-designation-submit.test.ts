import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor, act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useSkillDesignationSubmit } from "./use-skill-designation-submit";

// ---------------------------------------------------------------------------
// Mutation plumbing: the hook drives `useUpdateIssue` which calls
// `api.updateIssue` through `mutationFn`. Mock the api singleton and the
// `useUpdateIssue` hook so the test fully controls the response surface;
// spreading the real `core/issues/mutations` module would pull in the
// React Query cache coordinator we don't need for unit-level hook tests.
// ---------------------------------------------------------------------------

const mockUpdateIssue = vi.hoisted(() => vi.fn());

vi.mock("@multica/core/api", () => ({
  api: {
    updateIssue: mockUpdateIssue,
  },
}));

vi.mock("@multica/core/issues/mutations", () => ({
  useUpdateIssue: () => ({
    mutateAsync: mockUpdateIssue,
  }),
}));

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

const SKILL_A = "00000000-0000-0000-0000-00000000000a";
const SKILL_B = "00000000-0000-0000-0000-00000000000b";
const AGENT_1 = "00000000-0000-0000-0000-0000000000c1";
const AGENT_2 = "00000000-0000-0000-0000-0000000000c2";
const ISSUE_ID = "00000000-0000-0000-0000-000000000fff";

describe("useSkillDesignationSubmit", () => {
  beforeEach(() => {
    mockUpdateIssue.mockReset();
    // Default: server returns the canonical create-shape response with two
    // successful outcomes. Tests override per-case.
    mockUpdateIssue.mockResolvedValue({
      id: ISSUE_ID,
      skill_designation_outcomes: [
        { target_type: "agent", target_id: AGENT_1, status: "queued", reason_code: "queued" },
        { target_type: "agent", target_id: AGENT_2, status: "bound", reason_code: "bound" },
      ],
    });
  });

  it("sends skill_mention_agents in the update body when called with a populated map", async () => {
    const { result } = renderHook(
      () =>
        useSkillDesignationSubmit({
          issueId: ISSUE_ID,
          skillMentionAgents: { [SKILL_A]: [AGENT_1] },
        }),
      { wrapper: createWrapper() },
    );

    let outcomes: Awaited<ReturnType<typeof result.current.submit>> = null;
    await act(async () => {
      outcomes = await result.current.submit({ source: "user-typing" });
    });

    expect(mockUpdateIssue).toHaveBeenCalledTimes(1);
    expect(mockUpdateIssue).toHaveBeenCalledWith({
      id: ISSUE_ID,
      skill_mention_agents: { [SKILL_A]: [AGENT_1] },
    });
    expect(outcomes).toHaveLength(2);
    expect(outcomes?.[0]).toMatchObject({ target_id: AGENT_1, status: "queued" });
    expect(outcomes?.[1]).toMatchObject({ target_id: AGENT_2, status: "bound" });
  });

  it("merges `extras` (description / description_base) into the update body so AE8 rides the same autosave path", async () => {
    const { result } = renderHook(
      () =>
        useSkillDesignationSubmit({
          issueId: ISSUE_ID,
          skillMentionAgents: { [SKILL_A]: [AGENT_1] },
        }),
      { wrapper: createWrapper() },
    );

    await act(async () => {
      await result.current.submit({
        source: "user-typing",
        extras: {
          description: "Use [@code-review](mention://skill/skill-a) here",
          description_base: "Use @code-review here",
        },
      });
    });

    expect(mockUpdateIssue).toHaveBeenCalledWith({
      id: ISSUE_ID,
      description: "Use [@code-review](mention://skill/skill-a) here",
      description_base: "Use @code-review here",
      skill_mention_agents: { [SKILL_A]: [AGENT_1] },
    });
  });

  it("short-circuits without sending when source is programmatic (autosave / undo / spell / mode-switch)", async () => {
    const { result } = renderHook(
      () =>
        useSkillDesignationSubmit({
          issueId: ISSUE_ID,
          skillMentionAgents: { [SKILL_A]: [AGENT_1] },
        }),
      { wrapper: createWrapper() },
    );

    for (const source of [
      "autosave",
      "undo",
      "spell",
      "mode-switch",
      "other",
    ] as const) {
      await act(async () => {
        const out = await result.current.submit({ source });
        expect(out).toBeNull();
      });
    }
    expect(mockUpdateIssue).not.toHaveBeenCalled();
  });

  it("short-circuits when the designation map is empty", async () => {
    const { result } = renderHook(
      () =>
        useSkillDesignationSubmit({
          issueId: ISSUE_ID,
          skillMentionAgents: {},
        }),
      { wrapper: createWrapper() },
    );

    await act(async () => {
      const out = await result.current.submit({ source: "user-typing" });
      expect(out).toBeNull();
    });
    expect(mockUpdateIssue).not.toHaveBeenCalled();
  });

  it("drops empty agent-list entries — an explicit clear is treated as a no-op designation", async () => {
    const { result } = renderHook(
      () =>
        useSkillDesignationSubmit({
          issueId: ISSUE_ID,
          skillMentionAgents: { [SKILL_A]: [], [SKILL_B]: [AGENT_1] },
        }),
      { wrapper: createWrapper() },
    );

    await act(async () => {
      await result.current.submit({ source: "user-typing" });
    });

    expect(mockUpdateIssue).toHaveBeenCalledWith({
      id: ISSUE_ID,
      skill_mention_agents: { [SKILL_B]: [AGENT_1] },
    });
  });

  it("KTD1: a second invocation while the first is in flight is a no-op (no duplicate mutation)", async () => {
    // Build a Promise that resolves on demand — the first submit hangs in
    // `await mutateAsync`, and the second fires before the first settles.
    let resolveFirst!: (value: unknown) => void;
    const firstInFlight = new Promise<unknown>((resolve) => {
      resolveFirst = resolve;
    });
    mockUpdateIssue.mockImplementationOnce(() => firstInFlight);
    mockUpdateIssue.mockResolvedValueOnce({
      id: ISSUE_ID,
      skill_designation_outcomes: [],
    });

    const { result } = renderHook(
      () =>
        useSkillDesignationSubmit({
          issueId: ISSUE_ID,
          skillMentionAgents: { [SKILL_A]: [AGENT_1] },
        }),
      { wrapper: createWrapper() },
    );

    let secondOutcome: Awaited<ReturnType<typeof result.current.submit>> | undefined;
    await act(async () => {
      const firstSubmit = result.current.submit({ source: "user-typing" });
      // Second invocation while the first is still in flight — must short-
      // circuit (return null), NOT fire a second mutation.
      secondOutcome = await result.current.submit({ source: "user-typing" });
      expect(secondOutcome).toBeNull();
      // Release the first; it should resolve with the single outcome the
      // mock returned.
      resolveFirst({
        id: ISSUE_ID,
        skill_designation_outcomes: [
          { target_type: "agent", target_id: AGENT_1, status: "queued", reason_code: "queued" },
        ],
      });
      const firstOutcome = await firstSubmit;
      expect(firstOutcome).toHaveLength(1);
    });

    expect(mockUpdateIssue).toHaveBeenCalledTimes(1);
  });

  it("D1: failure surfaces lastError, keeps the chip pending, and lets a retry re-send the same payload", async () => {
    const onSuccess = vi.fn();
    const onError = vi.fn();
    mockUpdateIssue
      .mockRejectedValueOnce(new Error("network exploded"))
      .mockResolvedValueOnce({
        id: ISSUE_ID,
        skill_designation_outcomes: [
          { target_type: "agent", target_id: AGENT_1, status: "queued", reason_code: "queued" },
        ],
      });

    const { result } = renderHook(
      () =>
        useSkillDesignationSubmit({
          issueId: ISSUE_ID,
          skillMentionAgents: { [SKILL_A]: [AGENT_1] },
          onSuccess,
          onError,
        }),
      { wrapper: createWrapper() },
    );

    // First call fails.
    await act(async () => {
      const out = await result.current.submit({ source: "user-typing" });
      expect(out).toBeNull();
    });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect((onError.mock.calls[0]?.[0] as Error).message).toBe("network exploded");
    expect(onSuccess).not.toHaveBeenCalled();
    expect(result.current.lastError?.message).toBe("network exploded");

    // Retry with the same map — single-consumption guard has cleared, the
    // mutation fires again and succeeds.
    await act(async () => {
      const out = await result.current.submit({ source: "user-typing" });
      expect(out).toHaveLength(1);
    });
    expect(mockUpdateIssue).toHaveBeenCalledTimes(2);
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it("parseWithFallback: returns outcomes from the response body or [] for malformed/absent field", async () => {
    const { result } = renderHook(
      () =>
        useSkillDesignationSubmit({
          issueId: ISSUE_ID,
          skillMentionAgents: { [SKILL_A]: [AGENT_1] },
        }),
      { wrapper: createWrapper() },
    );

    // Absent field → [].
    mockUpdateIssue.mockResolvedValueOnce({ id: ISSUE_ID });
    let out: Awaited<ReturnType<typeof result.current.submit>> | undefined;
    await act(async () => {
      out = await result.current.submit({ source: "user-typing" });
      expect(out).toEqual([]);
    });

    // Malformed (non-array) → [].
    mockUpdateIssue.mockResolvedValueOnce({
      id: ISSUE_ID,
      skill_designation_outcomes: { not: "an array" },
    });
    await act(async () => {
      out = await result.current.submit({ source: "user-typing" });
      expect(out).toEqual([]);
    });

    // Mixed: one valid row + one missing-target_id row → only the valid
    // row survives (per-row drop, mirroring parseCommentTriggerOutcomes).
    mockUpdateIssue.mockResolvedValueOnce({
      id: ISSUE_ID,
      skill_designation_outcomes: [
        { target_type: "agent", target_id: AGENT_1, status: "queued", reason_code: "queued" },
        { target_type: "agent", status: "queued", reason_code: "queued" },
      ],
    });
    await act(async () => {
      out = await result.current.submit({ source: "user-typing" });
      expect(out).toHaveLength(1);
      expect(out?.[0]?.target_id).toBe(AGENT_1);
    });
  });

  it("treats paste as a touched source — a pasted @skill chip lands the designation", async () => {
    const { result } = renderHook(
      () =>
        useSkillDesignationSubmit({
          issueId: ISSUE_ID,
          skillMentionAgents: { [SKILL_A]: [AGENT_1] },
        }),
      { wrapper: createWrapper() },
    );

    await act(async () => {
      await result.current.submit({ source: "paste" });
    });
    expect(mockUpdateIssue).toHaveBeenCalledTimes(1);
  });

  it("clears lastError after a successful retry", async () => {
    mockUpdateIssue
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce({
        id: ISSUE_ID,
        skill_designation_outcomes: [],
      });
    const { result } = renderHook(
      () =>
        useSkillDesignationSubmit({
          issueId: ISSUE_ID,
          skillMentionAgents: { [SKILL_A]: [AGENT_1] },
        }),
      { wrapper: createWrapper() },
    );

    await act(async () => {
      await result.current.submit({ source: "user-typing" });
    });
    expect(result.current.lastError?.message).toBe("transient");

    await act(async () => {
      await result.current.submit({ source: "user-typing" });
    });
    await waitFor(() => {
      expect(result.current.lastError).toBeNull();
    });
  });
});