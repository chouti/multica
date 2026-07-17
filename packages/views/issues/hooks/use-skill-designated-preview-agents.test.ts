import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the api module so the real agentListOptions (which calls
// api.listAgents) returns controlled test data.
vi.mock("@multica/core/api", () => ({
  api: {
    listAgents: vi.fn(),
  },
}));

import { api } from "@multica/core/api";
import { useSkillDesignatedPreviewAgents } from "./use-skill-designated-preview-agents";

const listAgents = vi.mocked(api.listAgents);

// Mutable array that tests push agents into before rendering the hook.
// The mock resolves with this array, so the query returns whatever the
// current test has populated.
let agents: Array<{ id: string; name: string; avatar_url?: string }> = [];

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

describe("useSkillDesignatedPreviewAgents", () => {
  beforeEach(() => {
    agents = [];
    listAgents.mockImplementation(() => Promise.resolve(agents as any));
  });

  it("returns [] for an empty skillMentionAgents map", () => {
    const { result } = renderHook(
      () => useSkillDesignatedPreviewAgents("ws-1", {}),
      { wrapper: createWrapper() },
    );
    // The query is disabled when there are no agent ids, so result is
    // immediately empty.
    expect(result.current).toEqual([]);
  });

  it("resolves a single skill designating one agent", async () => {
    agents.push({ id: "a-1", name: "Agent One" });

    const { result } = renderHook(
      () =>
        useSkillDesignatedPreviewAgents("ws-1", {
          "skill-1": ["a-1"],
        }),
      { wrapper: createWrapper() },
    );

    await waitFor(() => expect(result.current).toHaveLength(1));
    expect(result.current[0]).toEqual(
      expect.objectContaining({
        id: "a-1",
        name: "Agent One",
        source: "mention_skill",
      }),
    );
  });

  it("deduplicates an agent referenced by two skills", async () => {
    agents.push({ id: "a-1", name: "Agent One" });

    const { result } = renderHook(
      () =>
        useSkillDesignatedPreviewAgents("ws-1", {
          "skill-1": ["a-1"],
          "skill-2": ["a-1"],
        }),
      { wrapper: createWrapper() },
    );

    await waitFor(() => expect(result.current).toHaveLength(1));
    expect(result.current[0]!.id).toBe("a-1");
  });

  it("silently drops agent IDs not present in the workspace list", async () => {
    agents.push({ id: "a-real", name: "Real Agent" });

    const { result } = renderHook(
      () =>
        useSkillDesignatedPreviewAgents("ws-1", {
          "skill-1": ["a-real", "a-deleted"],
        }),
      { wrapper: createWrapper() },
    );

    await waitFor(() => expect(result.current).toHaveLength(1));
    expect(result.current[0]!.id).toBe("a-real");
  });

  it("returns all distinct agents across multiple skills", async () => {
    agents.push(
      { id: "a-1", name: "Agent One" },
      { id: "a-2", name: "Agent Two" },
    );

    const { result } = renderHook(
      () =>
        useSkillDesignatedPreviewAgents("ws-1", {
          "skill-1": ["a-1"],
          "skill-2": ["a-2"],
        }),
      { wrapper: createWrapper() },
    );

    await waitFor(() => expect(result.current).toHaveLength(2));
    expect(result.current).toEqual([
      expect.objectContaining({ id: "a-1", name: "Agent One", source: "mention_skill" }),
      expect.objectContaining({ id: "a-2", name: "Agent Two", source: "mention_skill" }),
    ]);
  });
});
