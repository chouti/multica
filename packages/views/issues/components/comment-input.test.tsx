// U3 — typed-insert auto-open of the skill-mention agent picker (R1/R7).
//
// Behavior under test: selecting a skill from the @ suggestion menu (the
// suggestion command path, KTD3) must auto-open the agent picker popover
// without a click, gated on the workspace agent list having settled non-empty
// (KTD4). Pasted skill markup never auto-opens; the manual chip-click gesture
// keeps working.
//
// U4 — auto-fill + dismiss=accept + override semantics (R3/R4/R6, KTD5):
// the resolved recommendation lands in `skillMentionAgents` automatically,
// explicit picker gestures (designate / clear) are never overridden, a
// suppress gesture clears the machine default, fast-path fills are upgraded
// by the async answer exactly once, and the submit terminal fill covers the
// cold-start race. The trigger preview is driven through a mutable mock state
// (`previewState`) so tests can flip resolved/backendAgents without timers.
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
const apiGetIssue = vi.hoisted(() => vi.fn());
const apiListTimeline = vi.hoisted(() => vi.fn());
const uploadWithToast = vi.hoisted(() => vi.fn());
// U4: mutable preview state consumed by the useCommentTriggerPreview mock.
// Mutate + re-render (any editor change) to advance the recommendation.
const previewState = vi.hoisted(() => ({
  agents: [] as Array<{ id: string; name: string; source: string; reason: string }>,
  backendAgents: [] as Array<{ id: string; name: string; source: string; reason: string }>,
  resolved: false,
}));

vi.mock("@multica/core/api", () => ({
  api: {
    uploadFile: apiUploadFile,
    // Serves the KTD4 auto-open gate (agentListOptions in
    // use-skill-mention-auto-open), the skill-designation preview strip, and
    // the recommendation hook's eligibility set.
    listAgents: apiListAgents,
    // Serves useRecommendedSkillAgent's fast path (issue assignee).
    getIssue: apiGetIssue,
    // Serves useRecommendedSkillAgent's reply-parent fast path.
    listTimeline: apiListTimeline,
    // The preview query itself is mocked at the hook level below; kept here
    // so any direct api access still resolves.
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
  // The trigger chips strip (suppress gesture) renders a status dot from the
  // same module; inert here.
  AgentStatusDot: () => null,
}));

// The trigger-preview hook is mocked with controllable state: `agents` feeds
// the chips strip (the suppress gesture lives there), `backendAgents` +
// `resolved` feed the U4 recommendation path through useRecommendedSkillAgent.
vi.mock("../hooks/use-comment-trigger-preview", () => ({
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
            {/* U4: the composer-held designation map, so auto-fill and user
                gestures can be asserted without the popover itself. */}
            <span data-testid="skill-designations">
              {JSON.stringify(skillMentionContext.skillMentionAgents)}
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
            {/* U4 pin for the submit terminal fill: the typed-insert signal
                fired but the debounced onUpdate has not — the fill effect
                cannot see the chip yet, only the submit-time doc read can. */}
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
            {/* U4: delete every chip for skill-1 (prune path). */}
            <button
              type="button"
              data-testid="remove-skill-chip"
              onClick={() => {
                skillMentionIdsRef.current = [];
                onUpdate?.(valueRef.current);
              }}
            >
              Remove skill chip
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
            {/* Same gesture for agent-1 (used to re-select a fast-path value
                through the picker, making the skill touched). */}
            <button
              type="button"
              data-testid="designate-agent-1"
              onClick={() => skillMentionContext.onSkillMentionChange("skill-1", ["agent-1"])}
            >
              Designate agent-1
            </button>
            {/* U4: explicit clear gesture in the popover (toggles the last
                agent off) — marks the skill touched. */}
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

type AgentFixture = {
  id: string;
  name: string;
  avatar_url: null;
  archived_at: string | null;
  runtime_id: string;
};

function agentFixture(id: string, archived = false) {
  // runtime_id set so the recommendation's eligibility check (unarchived AND
  // runtime-bound) passes; the auto-open gate only reads archived_at.
  return {
    id,
    name: `Agent ${id}`,
    avatar_url: null,
    archived_at: archived ? "2026-01-01T00:00:00Z" : null,
    runtime_id: "runtime-1",
  } as unknown as AgentFixture;
}

function previewRow(id: string, source = "issue_assignee") {
  return { id, name: `Agent ${id}`, source, reason: "" };
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

/** The composer-held skill→agents designation map exposed by the harness. */
function designations(): Record<string, string[]> {
  return JSON.parse(screen.getByTestId("skill-designations").textContent ?? "{}");
}

/** Advance the mocked preview state into the composer: mutate `previewState`
 *  first, then call this — any editor change re-renders and the recommendation
 *  hook re-reads the mock. */
let driveSeq = 0;
async function driveRecUpdate() {
  fireEvent.change(screen.getByTestId("editor"), {
    target: { value: `draft-${++driveSeq}` },
  });
  await act(async () => {});
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
  apiGetIssue.mockReset().mockResolvedValue({ assignee_type: null, assignee_id: null });
  apiListTimeline.mockReset().mockResolvedValue([]);
  previewState.agents = [];
  previewState.backendAgents = [];
  previewState.resolved = false;
  driveSeq = 0;
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

// U4 — auto-fill + dismiss=accept + override semantics (R3/R4/R6, KTD5).
// The recommendation is driven through previewState (backendAgents/resolved)
// and getIssue (fast-path assignee); the typed-insert signal comes from the
// menu-insert buttons, pasted chips from the paste button.
describe("skill mention auto-bind (U4)", () => {
  it("fills the resolved recommendation into the designation map and announces it (R3)", async () => {
    apiListAgents.mockResolvedValue([agentFixture("agent-1")]);
    previewState.backendAgents = [previewRow("agent-1", "issue_assignee")];
    previewState.resolved = true;
    renderCommentInput();
    activateComposer("comment-composer-shell");
    await screen.findByTestId("skill-panel");

    fireEvent.click(screen.getByTestId("menu-insert-skill"));

    await waitFor(() =>
      expect(designations()).toEqual({ "skill-1": ["agent-1"] }),
    );
    // The chip badge flip (0 -> 1 designated agent) is announced politely.
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain(
        "Recommended agent assigned",
      ),
    );
  });

  it("announces the auto-opened picker through the live region", async () => {
    apiListAgents.mockResolvedValue([agentFixture("agent-1")]);
    renderCommentInput();
    activateComposer("comment-composer-shell");
    await screen.findByTestId("skill-panel");

    // No recommendation at all (nothing resolves) — the announcement here is
    // purely about the popover opening without stealing focus.
    fireEvent.click(screen.getByTestId("menu-insert-skill"));

    await waitFor(() => expect(popoverTarget()).toBe("skill-1"));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain(
        "Agent picker opened",
      ),
    );
  });

  it("does not overwrite an explicit picker designation when the recommendation resolves (R4/AE2)", async () => {
    apiListAgents.mockResolvedValue([agentFixture("agent-1"), agentFixture("agent-2")]);
    renderCommentInput();
    activateComposer("comment-composer-shell");
    await screen.findByTestId("skill-panel");

    fireEvent.click(screen.getByTestId("menu-insert-skill"));
    fireEvent.click(screen.getByTestId("designate-agent"));

    previewState.backendAgents = [previewRow("agent-1", "mention_agent")];
    previewState.resolved = true;
    await driveRecUpdate();

    expect(designations()).toEqual({ "skill-1": ["agent-2"] });
  });

  it("never re-fills a designation the user explicitly cleared", async () => {
    apiListAgents.mockResolvedValue([agentFixture("agent-1")]);
    previewState.backendAgents = [previewRow("agent-1")];
    previewState.resolved = true;
    renderCommentInput();
    activateComposer("comment-composer-shell");
    await screen.findByTestId("skill-panel");

    fireEvent.click(screen.getByTestId("menu-insert-skill"));
    await waitFor(() =>
      expect(designations()).toEqual({ "skill-1": ["agent-1"] }),
    );

    fireEvent.click(screen.getByTestId("clear-designations"));
    await driveRecUpdate();
    await act(async () => {});

    expect(designations()).toEqual({});
  });

  it("suppressing an auto-filled agent clears the entry and the submit carries no binding; a touched entry survives", async () => {
    apiListAgents.mockResolvedValue([agentFixture("agent-1"), agentFixture("agent-2")]);
    // Fast-path fill from the issue assignee while the preview is in flight.
    apiGetIssue.mockResolvedValue({ assignee_type: "agent", assignee_id: "agent-1" });
    const { container, onSubmit } = renderCommentInput();
    activateComposer("comment-composer-shell");
    await screen.findByTestId("skill-panel");

    fireEvent.click(screen.getByTestId("menu-insert-skill"));
    await waitFor(() =>
      expect(designations()).toEqual({ "skill-1": ["agent-1"] }),
    );

    // Phase A: suppress the auto-filled agent (non-touched) — the strip
    // renders a single chip for it.
    previewState.agents = [previewRow("agent-1")];
    await driveRecUpdate();
    fireEvent.click(screen.getByRole("button", { name: /Agent agent-1 trigger/ }));
    expect(designations()).toEqual({});

    // The machine default must not come back, and the submit payload has no
    // skill binding (the suppress gesture is final for this fill).
    fireEvent.change(screen.getByTestId("editor"), { target: { value: "hello" } });
    fireEvent.click(getSubmitButton(container));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]![3]).toBeUndefined();

    // Phase B: a touched entry containing the suppressed agent survives. The
    // accepted submit cleared the editor (chip included), so re-insert the
    // chip before designating — a designation for an absent chip is pruned
    // by the doc sync.
    fireEvent.click(screen.getByTestId("menu-insert-skill"));
    fireEvent.click(screen.getByTestId("designate-agent"));
    previewState.agents = [previewRow("agent-2")];
    await driveRecUpdate();
    fireEvent.click(screen.getByRole("button", { name: /Agent agent-2 trigger/ }));
    expect(designations()).toEqual({ "skill-1": ["agent-2"] });
  });

  it("replaces a fast-path fill with the async answer exactly once, and not once touched", async () => {
    apiListAgents.mockResolvedValue([
      agentFixture("agent-1"),
      agentFixture("agent-2"),
      agentFixture("agent-3"),
    ]);
    // Low-tier fast path: the issue assignee fills while the preview is in flight.
    apiGetIssue.mockResolvedValue({ assignee_type: "agent", assignee_id: "agent-1" });
    renderCommentInput();
    activateComposer("comment-composer-shell");
    await screen.findByTestId("skill-panel");

    fireEvent.click(screen.getByTestId("menu-insert-skill"));
    await waitFor(() =>
      expect(designations()).toEqual({ "skill-1": ["agent-1"] }),
    );

    // The authoritative answer prefers a mentioned agent — replace once.
    previewState.backendAgents = [previewRow("agent-2", "mention_agent")];
    previewState.resolved = true;
    await driveRecUpdate();
    await waitFor(() =>
      expect(designations()).toEqual({ "skill-1": ["agent-2"] }),
    );

    // A later answer changes nothing: the first async value is sticky.
    previewState.backendAgents = [previewRow("agent-3", "mention_agent")];
    await driveRecUpdate();
    await act(async () => {});
    expect(designations()).toEqual({ "skill-1": ["agent-2"] });
  });

  it("does not replace a fast-path fill the user has since touched", async () => {
    apiListAgents.mockResolvedValue([agentFixture("agent-1"), agentFixture("agent-2")]);
    apiGetIssue.mockResolvedValue({ assignee_type: "agent", assignee_id: "agent-1" });
    renderCommentInput();
    activateComposer("comment-composer-shell");
    await screen.findByTestId("skill-panel");

    fireEvent.click(screen.getByTestId("menu-insert-skill"));
    await waitFor(() =>
      expect(designations()).toEqual({ "skill-1": ["agent-1"] }),
    );
    // The user re-selects the same agent through the picker (toggle off, on)
    // — the value looks identical but the skill is now touched.
    fireEvent.click(screen.getByTestId("clear-designations"));
    fireEvent.click(screen.getByTestId("designate-agent-1"));

    previewState.backendAgents = [previewRow("agent-2", "mention_agent")];
    previewState.resolved = true;
    await driveRecUpdate();
    await act(async () => {});

    expect(designations()).toEqual({ "skill-1": ["agent-1"] });
  });

  it("re-enables fill after the chip is deleted and re-inserted (untouched)", async () => {
    apiListAgents.mockResolvedValue([agentFixture("agent-1")]);
    previewState.backendAgents = [previewRow("agent-1")];
    previewState.resolved = true;
    renderCommentInput();
    activateComposer("comment-composer-shell");
    await screen.findByTestId("skill-panel");

    fireEvent.click(screen.getByTestId("menu-insert-skill"));
    await waitFor(() =>
      expect(designations()).toEqual({ "skill-1": ["agent-1"] }),
    );

    fireEvent.click(screen.getByTestId("remove-skill-chip"));
    await act(async () => {});
    expect(designations()).toEqual({});

    // Re-insertion (typed menu path) re-opens the popover and re-fills.
    fireEvent.click(screen.getByTestId("menu-insert-skill"));
    await waitFor(() =>
      expect(designations()).toEqual({ "skill-1": ["agent-1"] }),
    );
  });

  it("resets the fill/touched guards when the issueId changes", async () => {
    apiListAgents.mockResolvedValue([agentFixture("agent-1")]);
    previewState.backendAgents = [previewRow("agent-1")];
    previewState.resolved = true;
    const onSubmit = vi.fn().mockResolvedValue(true);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const view = renderWithI18n(
      <QueryClientProvider client={queryClient}>
        <CommentInput issueId="issue-1" onSubmit={onSubmit} />
      </QueryClientProvider>,
    );
    activateComposer("comment-composer-shell");
    await screen.findByTestId("skill-panel");

    fireEvent.click(screen.getByTestId("menu-insert-skill"));
    await waitFor(() =>
      expect(designations()).toEqual({ "skill-1": ["agent-1"] }),
    );

    // Switch the issue in place: state and guards reset together.
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <CommentInput issueId="issue-2" onSubmit={onSubmit} />
      </QueryClientProvider>,
    );
    await act(async () => {});
    expect(designations()).toEqual({});

    // The guards were reset too: a fresh insertion on the new issue fills again.
    fireEvent.click(screen.getByTestId("menu-insert-skill"));
    await waitFor(() =>
      expect(designations()).toEqual({ "skill-1": ["agent-1"] }),
    );
  });

  it("cold-start submit with an unresolved recommendation sends no designations (OQ3)", async () => {
    apiListAgents.mockResolvedValue([agentFixture("agent-1")]);
    // Preview unresolved AND no fast-path candidate.
    const { container, onSubmit } = renderCommentInput();
    activateComposer("comment-composer-shell");
    await screen.findByTestId("skill-panel");

    fireEvent.click(screen.getByTestId("menu-insert-skill"));
    await act(async () => {});
    fireEvent.change(screen.getByTestId("editor"), { target: { value: "hello" } });
    fireEvent.click(getSubmitButton(container));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]![3]).toBeUndefined();
  });

  it("the submit terminal fill carries the resolved recommendation even before the fill effect commits (AE1)", async () => {
    apiListAgents.mockResolvedValue([agentFixture("agent-1")]);
    previewState.backendAgents = [previewRow("agent-1")];
    previewState.resolved = true;
    const { container, onSubmit } = renderCommentInput();
    activateComposer("comment-composer-shell");
    await screen.findByTestId("skill-panel");

    // Insert WITHOUT the update tick: the fill effect cannot see the chip
    // (docSkillIds is still empty) — only the submit-time doc read can.
    fireEvent.click(screen.getByTestId("menu-insert-skill-no-update"));
    await act(async () => {});
    expect(designations()).toEqual({});

    fireEvent.change(screen.getByTestId("editor"), { target: { value: "hello" } });
    fireEvent.click(getSubmitButton(container));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]![3]).toEqual({ "skill-1": ["agent-1"] });
  });

  it("pasted skill chips never auto-fill or terminal-fill (KTD3 typed-insert anchor)", async () => {
    apiListAgents.mockResolvedValue([agentFixture("agent-1")]);
    previewState.backendAgents = [previewRow("agent-1")];
    previewState.resolved = true;
    const { container, onSubmit } = renderCommentInput();
    activateComposer("comment-composer-shell");
    await screen.findByTestId("skill-panel");

    fireEvent.click(screen.getByTestId("paste-skill-markup"));
    await act(async () => {});
    expect(designations()).toEqual({});

    fireEvent.click(getSubmitButton(container));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]![3]).toBeUndefined();
  });

  it("no qualifying candidate: no fill and an undefined payload (AE3/AE4)", async () => {
    apiListAgents.mockResolvedValue([agentFixture("agent-1")]);
    // Backend answered — with zero candidates (authoritative null).
    previewState.resolved = true;
    previewState.backendAgents = [];
    const { container, onSubmit } = renderCommentInput();
    activateComposer("comment-composer-shell");
    await screen.findByTestId("skill-panel");

    fireEvent.click(screen.getByTestId("menu-insert-skill"));
    await act(async () => {});
    expect(designations()).toEqual({});

    fireEvent.change(screen.getByTestId("editor"), { target: { value: "hello" } });
    fireEvent.click(getSubmitButton(container));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]![3]).toBeUndefined();
  });

  it("a draft remount does not re-fill an explicitly cleared skill, even after re-insertion (guards persist)", async () => {
    apiListAgents.mockResolvedValue([agentFixture("agent-1")]);
    previewState.backendAgents = [previewRow("agent-1")];
    previewState.resolved = true;
    const first = renderCommentInput();
    activateComposer("comment-composer-shell");
    await screen.findByTestId("skill-panel");

    // Fill, then the user explicitly clears the recommendation.
    fireEvent.click(screen.getByTestId("menu-insert-skill"));
    await waitFor(() =>
      expect(designations()).toEqual({ "skill-1": ["agent-1"] }),
    );
    fireEvent.click(screen.getByTestId("clear-designations"));
    // Keystroke: persists content + guards into the draft store.
    fireEvent.change(screen.getByTestId("editor"), { target: { value: "kept draft" } });
    first.unmount();

    const payload = useCommentDraftStore.getState().getDraftPayload("new:issue-1");
    expect(payload?.touchedSkillIds).toEqual(["skill-1"]);

    // Virtualization remount: the draft rehydrates (non-empty content mounts
    // the live editor immediately — no shell activation), and even a fresh
    // typed insertion of the same skill cannot re-fill it (touched is durable).
    renderCommentInput();
    await screen.findByTestId("skill-panel");
    fireEvent.click(screen.getByTestId("menu-insert-skill"));
    await waitFor(() => expect(popoverTarget()).toBe("skill-1"));
    await act(async () => {});
    await act(async () => {});
    expect(designations()).toEqual({});
  });
});
