import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@multica/core/api";
import type { CommentTriggerPreview } from "@multica/core/types";
import { useRecommendedSkillAgent } from "./use-recommended-skill-agent";

vi.mock("@multica/core/api", () => ({
  api: {
    listAgents: vi.fn(),
    previewCommentTriggers: vi.fn(),
    getIssue: vi.fn(),
    listTimeline: vi.fn(),
  },
}));

const listAgents = vi.mocked(api.listAgents);
const previewCommentTriggers = vi.mocked(api.previewCommentTriggers);
const getIssue = vi.mocked(api.getIssue);
const listTimeline = vi.mocked(api.listTimeline);

// Minimal agent shape the hook reads: id, archived_at, runtime binding.
interface FixtureAgent {
  id: string;
  name: string;
  archived_at: string | null;
  runtime_id: string;
  runtime_bound?: boolean;
}

const parentAgentId = "00000000-0000-0000-0000-00000000000a";
const mentionedAgentId = "00000000-0000-0000-0000-00000000000b";
const assigneeAgentId = "00000000-0000-0000-0000-00000000000c";
const archivedAgentId = "00000000-0000-0000-0000-00000000000d";
const unboundAgentId = "00000000-0000-0000-0000-00000000000e";

const eligible = (id: string): FixtureAgent => ({
  id,
  name: id,
  archived_at: null,
  runtime_id: "runtime-1",
  runtime_bound: true,
});

const parentTimeline = [
  {
    type: "comment" as const,
    id: "parent-1",
    actor_type: "agent",
    actor_id: parentAgentId,
    created_at: "2026-01-01T00:00:00Z",
  },
];

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

function renderRecommended(
  props: Partial<Parameters<typeof useRecommendedSkillAgent>[0]> = {},
) {
  return renderHook(
    () =>
      useRecommendedSkillAgent({
        wsId: "ws-1",
        issueId: "issue-1",
        content: "please run the build",
        ...props,
      }),
    { wrapper: createWrapper() },
  );
}

/** Keeps the debounced preview query in flight forever (cold-start window). */
function keepPreviewInFlight() {
  previewCommentTriggers.mockReturnValue(new Promise(() => {}));
}

describe("useRecommendedSkillAgent", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    listAgents.mockImplementation(() =>
      Promise.resolve([
        eligible(parentAgentId),
        eligible(assigneeAgentId),
        eligible(mentionedAgentId),
        { ...eligible(archivedAgentId), archived_at: "2026-01-02T00:00:00Z" },
        { ...eligible(unboundAgentId), runtime_id: "", runtime_bound: false },
      ] as any),
    );
    listTimeline.mockResolvedValue(parentTimeline as any);
    getIssue.mockResolvedValue({
      assignee_type: "agent",
      assignee_id: assigneeAgentId,
    } as any);
    keepPreviewInFlight();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("bridges the cold start with the reply-parent agent while the preview is in flight", async () => {
    const { result } = renderRecommended({ parentId: "parent-1" });

    await vi.waitFor(() => {
      expect(result.current).toEqual({ id: parentAgentId, from: "fast-path" });
    });
  });

  it("replaces the fast-path value with the async recommendation once the preview resolves", async () => {
    let resolvePreview!: (preview: CommentTriggerPreview) => void;
    previewCommentTriggers.mockReturnValue(
      new Promise<CommentTriggerPreview>((resolve) => {
        resolvePreview = resolve;
      }),
    );

    const { result } = renderRecommended({ parentId: "parent-1" });

    await vi.waitFor(() => {
      expect(result.current).toEqual({ id: parentAgentId, from: "fast-path" });
    });

    await act(async () => {
      resolvePreview({
        agents: [
          {
            id: mentionedAgentId,
            name: "Kim",
            source: "mention_agent",
            reason: "",
          },
        ],
      });
    });

    await vi.waitFor(() => {
      expect(result.current).toEqual({ id: mentionedAgentId, from: "async" });
    });
  });

  it("returns null once the backend answers with zero candidates, overriding the fast path", async () => {
    previewCommentTriggers.mockResolvedValue({ agents: [] });

    const { result } = renderRecommended({ parentId: "parent-1" });

    // Fast-path value shows first, then the resolved-empty answer wins —
    // and an answered-with-zero is authoritative ("async"), not a fallback.
    await vi.waitFor(() => {
      expect(result.current).toEqual({ id: null, from: "async" });
    });
  });

  it("skips an archived reply-parent author and falls back to the issue assignee", async () => {
    listTimeline.mockResolvedValue([
      {
        ...parentTimeline[0],
        actor_type: "agent",
        actor_id: archivedAgentId,
      },
    ] as any);

    const { result } = renderRecommended({ parentId: "parent-1" });

    await vi.waitFor(() => {
      expect(result.current).toEqual({ id: assigneeAgentId, from: "fast-path" });
    });
  });

  it("never recommends a runtime-unbound fast-path candidate", async () => {
    listTimeline.mockResolvedValue([
      { ...parentTimeline[0], actor_id: unboundAgentId },
    ] as any);
    getIssue.mockResolvedValue({ assignee_type: null, assignee_id: null } as any);

    const { result } = renderRecommended({ parentId: "parent-1" });

    await vi.waitFor(() => {
      expect(result.current.id).toBeNull();
    });
  });

  it("never recommends a suppressed fast-path candidate", async () => {
    getIssue.mockResolvedValue({ assignee_type: null, assignee_id: null } as any);

    const { result } = renderRecommended({
      parentId: "parent-1",
      suppressedAgentIds: new Set([parentAgentId]),
    });

    await vi.waitFor(() => {
      expect(result.current.id).toBeNull();
    });
  });

  it("returns null with no fast-path inputs while the preview is unresolved", async () => {
    getIssue.mockResolvedValue({ assignee_type: null, assignee_id: null } as any);

    const { result } = renderRecommended();

    await act(async () => {});
    expect(result.current.id).toBeNull();
  });

  it("ranks only eligible backend rows once the preview resolves", async () => {
    previewCommentTriggers.mockResolvedValue({
      agents: [
        { id: archivedAgentId, name: "A", source: "mention_agent", reason: "" },
        { id: assigneeAgentId, name: "C", source: "issue_assignee", reason: "" },
      ],
    });

    const { result } = renderRecommended();

    await vi.waitFor(() => {
      // The top-tier mention row fails the visibility check (archived), so
      // the recommendation-side check skips it for the visible assignee.
      expect(result.current).toEqual({ id: assigneeAgentId, from: "async" });
    });
  });

  it("returns null for empty content with no fast-path inputs", async () => {
    getIssue.mockResolvedValue({ assignee_type: null, assignee_id: null } as any);

    const { result } = renderRecommended({ content: "" });

    await act(async () => {});
    expect(result.current.id).toBeNull();
  });
});
