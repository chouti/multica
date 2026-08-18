// U3 — typed-insert auto-open of the skill-mention agent picker (R1/R7).
//
// Behavior under test: selecting a skill from the @ suggestion menu (the
// suggestion command path, KTD3) must auto-open the agent picker popover
// without a click, gated on the workspace agent list having settled non-empty
// (KTD4). Pasted skill markup never auto-opens; the manual chip-click gesture
// keeps working.
//
// The editor is a textarea stand-in with the same seam the real one exposes:
// `onSkillMentionInserted` fires ONLY from the typed-menu path, and the panel
// surfaces `skillMentionContext.openPopoverFor` so the composer-held popover
// target can be asserted without booting Tiptap.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor, act } from "@testing-library/react";
import { forwardRef, useEffect, useImperativeHandle, useRef, type Ref } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useCommentDraftStore } from "@multica/core/issues/stores";
import { renderWithI18n } from "../../test/i18n";
import { CommentInput } from "./comment-input";
import { ReplyInput } from "./reply-input";

const apiUploadFile = vi.hoisted(() => vi.fn());
const apiListAgents = vi.hoisted(() => vi.fn());
const uploadWithToast = vi.hoisted(() => vi.fn());

vi.mock("@multica/core/api", () => ({
  api: {
    uploadFile: apiUploadFile,
    // Serves the KTD4 auto-open gate (agentListOptions in
    // use-skill-mention-auto-open) and the skill-designation preview strip.
    listAgents: apiListAgents,
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

// The trigger-preview chips have their own suite; inert here so this file
// stays about the auto-open gate and the popover target.
vi.mock("../hooks/use-comment-trigger-preview", () => ({
  useCommentTriggerPreview: () => ({ agents: [], blocked: [] }),
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
    // Mirrors the real editor's skill-mention nodes: menu inserts and pastes
    // put the chip in the document, so getSkillMentionIds answers it and the
    // composer's text-gesture consistency does not prune the designation.
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
            {/* Typed @-menu selection: the suggestion command inserted the
                chip and notified the composer (the ONLY auto-open source). */}
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
            {/* Paste path: the chip lands in the document, but no suggestion
                command ran, so no notification fires. */}
            <button
              type="button"
              data-testid="paste-skill-markup"
              onClick={() => {
                skillMentionIdsRef.current = ["skill-1"];
                valueRef.current = `${valueRef.current} [@code-review](mention://skill/skill-1)`;
                onUpdate?.(valueRef.current);
              }}
            >
              Paste skill markup
            </button>
            {/* Manual gesture (R7): clicking the chip opens the popover. */}
            <button
              type="button"
              data-testid="click-chip"
              onClick={() => skillMentionContext.setOpenPopoverFor("skill-1")}
            >
              Click chip
            </button>
            {/* Keyboard designation: an agent picked in the popover list. */}
            <button
              type="button"
              data-testid="designate-agent"
              onClick={() => skillMentionContext.onSkillMentionChange("skill-1", ["agent-2"])}
            >
              Designate agent-2
            </button>
          </div>
        )}
      </div>
    );
  }),
}));

type AgentFixture = {
  id: string;
  name: string;
  avatar_url: null;
  archived_at: string | null;
};

function agentFixture(id: string, archived = false) {
  return {
    id,
    name: `Agent ${id}`,
    avatar_url: null,
    archived_at: archived ? "2026-01-01T00:00:00Z" : null,
  } as unknown as AgentFixture;
}

function renderView(ui: React.ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return renderWithI18n(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

function renderCommentInput(onSubmit = vi.fn().mockResolvedValue(true)) {
  const view = renderView(<CommentInput issueId="issue-1" onSubmit={onSubmit} />);
  return { ...view, onSubmit };
}

function renderReplyInput(onSubmit = vi.fn().mockResolvedValue(true)) {
  const view = renderView(
    <ReplyInput
      issueId="issue-1"
      parentId="comment-1"
      avatarType="member"
      avatarId="user-1"
      onSubmit={onSubmit}
      size="sm"
    />,
  );
  return { ...view, onSubmit };
}

function activateComposer(shell: "comment-composer-shell" | "reply-composer-shell") {
  fireEvent.click(screen.getByTestId(shell));
}

/** The composer-held popover target exposed by the editor harness. */
function popoverTarget(): string {
  return screen.getByTestId("skill-popover-open-for").textContent ?? "";
}

function getSubmitButton(container: HTMLElement): HTMLButtonElement {
  const buttons = container.querySelectorAll("button");
  const button = buttons[buttons.length - 1];
  if (!button) throw new Error("Expected submit button to render");
  return button;
}

beforeEach(() => {
  uploadWithToast.mockReset();
  apiUploadFile.mockReset();
  apiListAgents.mockReset();
  useCommentDraftStore.setState({ drafts: {} });
});

describe("skill mention auto-open popover (U3)", () => {
  it("auto-opens the agent popover after a typed @-menu skill selection (top-level composer)", async () => {
    apiListAgents.mockResolvedValue([agentFixture("agent-1")]);
    renderCommentInput();
    activateComposer("comment-composer-shell");
    await screen.findByTestId("skill-panel");

    fireEvent.click(screen.getByTestId("menu-insert-skill"));

    await waitFor(() => expect(popoverTarget()).toBe("skill-1"));
  });

  it("auto-opens the agent popover in the reply composer too", async () => {
    apiListAgents.mockResolvedValue([agentFixture("agent-1")]);
    renderReplyInput();
    activateComposer("reply-composer-shell");
    await screen.findByTestId("skill-panel");

    fireEvent.click(screen.getByTestId("menu-insert-skill"));

    await waitFor(() => expect(popoverTarget()).toBe("skill-1"));
  });

  it("holds the auto-open while the agent list is in flight, then opens once it settles", async () => {
    let resolveAgents!: (agents: unknown[]) => void;
    apiListAgents.mockImplementationOnce(
      () => new Promise((resolve) => { resolveAgents = resolve; }),
    );
    renderCommentInput();
    activateComposer("comment-composer-shell");
    await screen.findByTestId("skill-panel");

    fireEvent.click(screen.getByTestId("menu-insert-skill"));

    // Still loading: the popover must not open yet.
    expect(popoverTarget()).toBe("");

    await act(async () => {
      resolveAgents([agentFixture("agent-1")]);
    });

    await waitFor(() => expect(popoverTarget()).toBe("skill-1"));
  });

  it("does not auto-open when the workspace has no bindable agents", async () => {
    apiListAgents.mockResolvedValue([agentFixture("agent-1", /* archived */ true)]);
    renderCommentInput();
    activateComposer("comment-composer-shell");
    await screen.findByTestId("skill-panel");
    // Let the agent-list query settle so the gate reads its final answer.
    await waitFor(() => expect(apiListAgents).toHaveBeenCalledTimes(1));
    await act(async () => { await Promise.resolve(); });

    fireEvent.click(screen.getByTestId("menu-insert-skill"));
    await act(async () => { await Promise.resolve(); });

    expect(popoverTarget()).toBe("");
  });

  it("does not auto-open when a skill chip arrives via paste", async () => {
    apiListAgents.mockResolvedValue([agentFixture("agent-1")]);
    renderCommentInput();
    activateComposer("comment-composer-shell");
    await screen.findByTestId("skill-panel");
    await waitFor(() => expect(apiListAgents).toHaveBeenCalledTimes(1));
    await act(async () => { await Promise.resolve(); });

    fireEvent.click(screen.getByTestId("paste-skill-markup"));
    await act(async () => { await Promise.resolve(); });

    // The chip is in the document (draft persisted) but the popover stays shut.
    expect(popoverTarget()).toBe("");
    expect(useCommentDraftStore.getState().getDraft("new:issue-1")).toContain(
      "mention://skill/skill-1",
    );
  });

  it("keeps the manual chip-click gesture opening the popover (R7)", async () => {
    apiListAgents.mockResolvedValue([agentFixture("agent-1")]);
    renderReplyInput();
    activateComposer("reply-composer-shell");
    await screen.findByTestId("skill-panel");

    fireEvent.click(screen.getByTestId("click-chip"));

    expect(popoverTarget()).toBe("skill-1");
  });

  it("forwards a keyboard-picked agent designation through the submit payload", async () => {
    apiListAgents.mockResolvedValue([agentFixture("agent-1"), agentFixture("agent-2")]);
    const { container, onSubmit } = renderCommentInput();
    activateComposer("comment-composer-shell");
    await screen.findByTestId("skill-panel");

    fireEvent.click(screen.getByTestId("menu-insert-skill"));
    fireEvent.click(screen.getByTestId("designate-agent"));
    fireEvent.change(screen.getByTestId("editor"), { target: { value: "hello" } });
    fireEvent.click(getSubmitButton(container));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith("hello", undefined, undefined, {
        "skill-1": ["agent-2"],
      }),
    );
  });
});
