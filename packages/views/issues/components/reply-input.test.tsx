// U4 — auto-fill semantics in the REPLY composer (R3/R4/R6, KTD5).
//
// The reply path differs from the top-level composer in two ways the tests
// here pin: the fast-path recommendation comes from the reply-parent agent
// (resolved from the issue timeline), and replies under a draftKey survive
// virtualization remounts, so the touched/filled guards must persist with the
// draft or a remount would re-fill a skill the user explicitly cleared.
//
// Same editor seam as comment-input.test.tsx: a textarea stand-in whose
// menu-insert button fires `onSkillMentionInserted` (the typed-insert signal)
// and whose panel surfaces the composer-held designation map.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor, act } from "@testing-library/react";
import { forwardRef, useEffect, useImperativeHandle, useRef, type Ref } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useCommentDraftStore, type CommentDraftKey } from "@multica/core/issues/stores";
import { renderWithI18n } from "../../test/i18n";
import { ReplyInput } from "./reply-input";

const apiUploadFile = vi.hoisted(() => vi.fn());
const apiListAgents = vi.hoisted(() => vi.fn());
const apiGetIssue = vi.hoisted(() => vi.fn());
const apiListTimeline = vi.hoisted(() => vi.fn());
const uploadWithToast = vi.hoisted(() => vi.fn());
// Mutable preview state consumed by the useCommentTriggerPreview mock; mutate
// + re-render (any editor change) to advance the recommendation.
const previewState = vi.hoisted(() => ({
  agents: [] as Array<{ id: string; name: string; source: string; reason: string }>,
  backendAgents: [] as Array<{ id: string; name: string; source: string; reason: string }>,
  resolved: false,
}));

vi.mock("@multica/core/api", () => ({
  api: {
    uploadFile: apiUploadFile,
    listAgents: apiListAgents,
    getIssue: apiGetIssue,
    listTimeline: apiListTimeline,
    previewCommentTriggers: vi.fn().mockResolvedValue({ agents: [] }),
    listWorkspaces: vi.fn(),
    listQuickActions: vi.fn(),
    renderQuickAction: vi.fn(),
  },
  dispatchReasonCode: () => undefined,
}));

vi.mock("@multica/core/hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

vi.mock("../../common/actor-avatar", () => ({
  ActorAvatar: () => null,
}));

vi.mock("../hooks/use-comment-trigger-preview", async () => ({
  // Pure helpers (isNoteCommentDraft — the /note fill gate reads it) come
  // through importActual untouched.
  ...(await vi.importActual<typeof import("../hooks/use-comment-trigger-preview")>(
    "../hooks/use-comment-trigger-preview",
  )),
  useCommentTriggerPreview: () => ({
    agents: previewState.agents,
    blocked: [],
    backendAgents: previewState.backendAgents,
    resolved: previewState.resolved,
  }),
}));

vi.mock("../../editor", async () => ({
  ...(await vi.importActual<typeof import("../../editor/use-lazy-editor")>(
    "../../editor/use-lazy-editor",
  )),
  ...(await vi.importActual<typeof import("../../editor/use-upload-gate")>(
    "../../editor/use-upload-gate",
  )),
  ...(await vi.importActual<typeof import("../../editor/use-composer-submit")>(
    "../../editor/use-composer-submit",
  )),
  useEditorUpload: () => ({ uploadWithToast, upload: vi.fn(), uploading: false }),
  useFileDropZone: () => ({ isDragOver: false, dropZoneProps: {} }),
  FileDropOverlay: () => null,
  ContentEditor: forwardRef(function SkillMenuEditor(
    {
      defaultValue,
      onUpdate,
      onSubmit,
      onReady,
      skillMentionContext,
      onSkillMentionInserted,
    }: {
      defaultValue?: string;
      onUpdate?: (markdown: string) => void;
      onSubmit?: () => void;
      onReady?: () => void;
      skillMentionContext?: {
        wsId: string;
        skillMentionAgents: Record<string, string[]>;
        onSkillMentionChange: (skillId: string, agentIds: string[]) => void;
        openPopoverFor: string | null;
        setOpenPopoverFor: (skillId: string | null) => void;
      };
      onSkillMentionInserted?: (skillId: string) => void;
    },
    ref: Ref<unknown>,
  ) {
    const valueRef = useRef(defaultValue ?? "");
    // Mirrors the real editor's skill-mention nodes.
    const skillMentionIdsRef = useRef<string[]>([]);

    useEffect(() => {
      onReady?.();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useImperativeHandle(ref, () => ({
      getMarkdown: () => valueRef.current,
      getSkillMentionIds: () => skillMentionIdsRef.current,
      clearContent: () => {
        valueRef.current = "";
        skillMentionIdsRef.current = [];
      },
      focus: () => {},
      focusAtCoords: () => {},
      blur: () => {},
      uploadFile: () => {},
      hasActiveUploads: () => false,
      insertUploadPlaceholder: () => true,
      settleUploadPlaceholder: () => false,
    }));

    return (
      <div>
        <textarea
          data-testid="editor"
          defaultValue={defaultValue}
          onChange={(event) => {
            valueRef.current = event.target.value;
            onUpdate?.(event.target.value);
          }}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") onSubmit?.();
          }}
        />
        {skillMentionContext && (
          <div data-testid="skill-panel">
            <span data-testid="skill-popover-open-for">
              {skillMentionContext.openPopoverFor ?? ""}
            </span>
            <span data-testid="skill-designations">
              {JSON.stringify(skillMentionContext.skillMentionAgents)}
            </span>
            {/* Typed @-menu selection with the debounced update tick. */}
            <button
              type="button"
              data-testid="menu-insert-skill"
              onClick={() => {
                skillMentionIdsRef.current = ["skill-1"];
                onSkillMentionInserted?.("skill-1");
                onUpdate?.(valueRef.current);
              }}
            >
              Insert skill via menu
            </button>
            {/* Typed insert whose debounced update has NOT fired yet — pins
                the submit terminal fill (state effect cannot see the chip). */}
            <button
              type="button"
              data-testid="menu-insert-skill-no-update"
              onClick={() => {
                skillMentionIdsRef.current = ["skill-1"];
                onSkillMentionInserted?.("skill-1");
              }}
            >
              Insert skill (no update tick)
            </button>
            {/* Explicit clear gesture in the popover. */}
            <button
              type="button"
              data-testid="clear-designations"
              onClick={() => skillMentionContext.onSkillMentionChange("skill-1", [])}
            >
              Clear designations
            </button>
          </div>
        )}
      </div>
    );
  }),
}));

const REPLY_DRAFT_KEY = "reply:issue-1:comment-1" as const;
const parentAgentId = "agent-parent";
const asyncAgentId = "agent-async";

function agentFixture(id: string) {
  return {
    id,
    name: `Agent ${id}`,
    avatar_url: null,
    archived_at: null,
    runtime_id: "runtime-1",
  };
}

function previewRow(id: string, source = "thread_parent") {
  return { id, name: `Agent ${id}`, source, reason: "" };
}

const parentTimeline = [
  { type: "comment", id: "comment-1", actor_type: "agent", actor_id: parentAgentId },
];

function renderReplyInput(
  onSubmit = vi.fn().mockResolvedValue(true),
  { draftKey }: { draftKey?: CommentDraftKey } = {},
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return renderWithI18n(
    <QueryClientProvider client={queryClient}>
      <ReplyInput
        issueId="issue-1"
        parentId="comment-1"
        avatarType="member"
        avatarId="user-1"
        onSubmit={onSubmit}
        size="sm"
        draftKey={draftKey}
      />
    </QueryClientProvider>,
  );
}

function designations(): Record<string, string[]> {
  return JSON.parse(screen.getByTestId("skill-designations").textContent ?? "{}");
}

/** Advance the mocked preview state into the reply composer. */
let driveSeq = 0;
async function driveRecUpdate() {
  fireEvent.change(screen.getByTestId("editor"), {
    target: { value: `draft-${++driveSeq}` },
  });
  await act(async () => {});
}

function getSubmitButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "Send" });
}

beforeEach(() => {
  uploadWithToast.mockReset();
  apiUploadFile.mockReset();
  apiListAgents.mockReset();
  apiGetIssue.mockReset().mockResolvedValue({ assignee_type: null, assignee_id: null });
  apiListTimeline.mockReset().mockResolvedValue(parentTimeline as any);
  previewState.agents = [];
  previewState.backendAgents = [];
  previewState.resolved = false;
  driveSeq = 0;
  useCommentDraftStore.setState({ drafts: {} });
});

async function activateReplyBox() {
  fireEvent.click(screen.getByTestId("reply-composer-shell"));
  await screen.findByTestId("skill-panel");
}

describe("reply composer — skill mention auto-bind (U4)", () => {
  it("bridges the cold start with the reply-parent agent (fast-path fill, R3)", async () => {
    apiListAgents.mockResolvedValue([agentFixture(parentAgentId)]);
    renderReplyInput();
    await activateReplyBox();

    fireEvent.click(screen.getByTestId("menu-insert-skill"));

    await waitFor(() =>
      expect(designations()).toEqual({ "skill-1": [parentAgentId] }),
    );
  });

  it("replaces the fast-path fill with the async answer exactly once (reply path)", async () => {
    apiListAgents.mockResolvedValue([agentFixture(parentAgentId), agentFixture(asyncAgentId)]);
    renderReplyInput();
    await activateReplyBox();

    fireEvent.click(screen.getByTestId("menu-insert-skill"));
    await waitFor(() =>
      expect(designations()).toEqual({ "skill-1": [parentAgentId] }),
    );

    previewState.backendAgents = [previewRow(asyncAgentId, "conversation_continuation")];
    previewState.resolved = true;
    await driveRecUpdate();

    await waitFor(() =>
      expect(designations()).toEqual({ "skill-1": [asyncAgentId] }),
    );

    // Sticky: a later answer changes nothing.
    previewState.backendAgents = [previewRow(parentAgentId, "mention_agent")];
    await driveRecUpdate();
    await act(async () => {});
    expect(designations()).toEqual({ "skill-1": [asyncAgentId] });
  });

  it("the submit terminal fill covers the pre-debounce window on the reply path (AE1)", async () => {
    apiListAgents.mockResolvedValue([agentFixture(asyncAgentId)]);
    previewState.backendAgents = [previewRow(asyncAgentId)];
    previewState.resolved = true;
    const onSubmit = vi.fn().mockResolvedValue(true);
    renderReplyInput(onSubmit);
    await activateReplyBox();

    fireEvent.click(screen.getByTestId("menu-insert-skill-no-update"));
    await act(async () => {});
    expect(designations()).toEqual({});

    fireEvent.change(screen.getByTestId("editor"), { target: { value: "hello" } });
    fireEvent.click(getSubmitButton());

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]![3]).toEqual({ "skill-1": [asyncAgentId] });
  });

  it("a draftKey remount does not re-fill an explicitly cleared skill (guards persist)", async () => {
    apiListAgents.mockResolvedValue([agentFixture(parentAgentId)]);
    const first = renderReplyInput(vi.fn().mockResolvedValue(true), {
      draftKey: REPLY_DRAFT_KEY,
    });
    await activateReplyBox();

    fireEvent.click(screen.getByTestId("menu-insert-skill"));
    await waitFor(() =>
      expect(designations()).toEqual({ "skill-1": [parentAgentId] }),
    );
    fireEvent.click(screen.getByTestId("clear-designations"));
    // Keystroke: persists content + guards into the draft store.
    fireEvent.change(screen.getByTestId("editor"), { target: { value: "kept reply" } });
    first.unmount();

    const payload = useCommentDraftStore
      .getState()
      .getDraftPayload(REPLY_DRAFT_KEY);
    expect(payload?.touchedSkillIds).toEqual(["skill-1"]);

    // Virtualization remount: draft rehydrates (live editor mounts at once),
    // and a fresh typed insertion still cannot re-fill the cleared skill.
    renderReplyInput(vi.fn().mockResolvedValue(true), {
      draftKey: REPLY_DRAFT_KEY,
    });
    await screen.findByTestId("skill-panel");
    fireEvent.click(screen.getByTestId("menu-insert-skill"));
    await waitFor(() =>
      expect(screen.getByTestId("skill-popover-open-for").textContent).toBe("skill-1"),
    );
    await act(async () => {});
    await act(async () => {});
    expect(designations()).toEqual({});
  });
});
