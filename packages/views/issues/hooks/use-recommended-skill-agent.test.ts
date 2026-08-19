import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@multica/core/api";
import type { CommentTriggerPreviewAgent } from "@multica/core/types";
import type { UseCommentTriggerPreviewResult } from "./use-comment-trigger-preview";
import { useRecommendedSkillAgent } from "./use-recommended-skill-agent";

vi.mock("@multica/core/api", () => ({
  api: {
    listAgents: vi.fn(),
    getIssue: vi.fn(),
    listTimeline: vi.fn(),
  },
}));

const listAgents = vi.mocked(api.listAgents);
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

const previewRow = (
  id: string,
  source: string,
): CommentTriggerPreviewAgent =>
  ({ id, name: id, source, reason: "" }) as CommentTriggerPreviewAgent;

// The composer's preview instance is injected (same-query-key dedup); these
// are its two recommendation-relevant states.
const UNRESOLVED: Pick<UseCommentTriggerPreviewResult, "backendAgents" | "resolved"> = {
  backendAgents: [],
  resolved: false,
};

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
        preview: UNRESOLVED,
        ...props,
      }),
    { wrapper: createWrapper() },
  );
}

describe("useRecommendedSkillAgent", () => {
  beforeEach(() => {
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
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("bridges the cold start with the reply-parent agent while the preview is unresolved", async () => {
    const { result } = renderRecommended({ parentId: "parent-1" });

    await vi.waitFor(() => {
      expect(result.current).toEqual({ id: parentAgentId, from: "fast-path" });
    });
  });

  it("replaces the fast-path value with the async recommendation once the preview resolves", async () => {
    const { result, rerender } = renderHook(
      ({ preview }: { preview: Pick<UseCommentTriggerPreviewResult, "backendAgents" | "resolved"> }) =>
        useRecommendedSkillAgent({
          wsId: "ws-1",
          issueId: "issue-1",
          parentId: "parent-1",
          preview,
        }),
      { wrapper: createWrapper(), initialProps: { preview: UNRESOLVED } },
    );

    await vi.waitFor(() => {
      expect(result.current).toEqual({ id: parentAgentId, from: "fast-path" });
    });

    rerender({
      preview: { backendAgents: [previewRow(mentionedAgentId, "mention_agent")], resolved: true },
    });

    await vi.waitFor(() => {
      expect(result.current).toEqual({ id: mentionedAgentId, from: "async" });
    });
  });

  it("returns null once the backend answers with zero candidates, overriding the fast path", async () => {
    const { result } = renderRecommended({
      parentId: "parent-1",
      preview: { backendAgents: [], resolved: true },
    });

    // An answered-with-zero is authoritative ("async"), not a fallback.
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

    await vi.waitFor(() => {
      expect(result.current.id).toBeNull();
    });
  });

  it("ranks only eligible backend rows once the preview resolves", async () => {
    const { result } = renderRecommended({
      preview: {
        backendAgents: [
          previewRow(archivedAgentId, "mention_agent"),
          previewRow(assigneeAgentId, "issue_assignee"),
        ],
        resolved: true,
      },
    });

    await vi.waitFor(() => {
      // The top-tier mention row fails the visibility check (archived), so
      // the recommendation-side check skips it for the visible assignee.
      expect(result.current).toEqual({ id: assigneeAgentId, from: "async" });
    });
  });

  it("treats a preview result missing the recommendation fields as unresolved", async () => {
    // API-drift pin: a stale mock (or an older shape sneaking through) lacks
    // backendAgents/resolved — the hook must degrade to the fast path, never
    // crash and never treat the gap as an authoritative empty answer.
    getIssue.mockResolvedValue({ assignee_type: null, assignee_id: null } as any);

    const { result } = renderRecommended({
      parentId: "parent-1",
      preview: {} as Pick<UseCommentTriggerPreviewResult, "backendAgents" | "resolved">,
    });

    await vi.waitFor(() => {
      expect(result.current).toEqual({ id: parentAgentId, from: "fast-path" });
    });
  });
});
