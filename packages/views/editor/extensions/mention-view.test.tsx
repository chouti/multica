import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import type { MentionView } from "./mention-view";
import {
  SkillMentionContext,
  type SkillMentionContextValue,
} from "../skill-mention-context";
import { NavigationProvider } from "../../navigation/context";
import type { NavigationAdapter } from "../../navigation/types";

// Tiptap's NodeView primitives need a full editor to instantiate. Stub
// NodeViewWrapper so MentionView renders as a plain React component and the
// test can assert the chip DOM shape.
vi.mock("@tiptap/react", () => {
  const NodeViewWrapper = ({ children, ...rest }: any) => (
    <span data-testid="nvw" {...rest}>
      {children}
    </span>
  );
  return { NodeViewWrapper };
});

vi.mock("@multica/core/paths", () => ({
  useWorkspacePaths: () => ({
    issueDetail: (id: string) => `/acme/issues/${id}`,
    projectDetail: (id: string) => `/acme/projects/${id}`,
  }),
}));

const { newTabPreferred } = vi.hoisted(() => ({ newTabPreferred: { value: false } }));

vi.mock("@multica/core/issues/stores", () => ({
  useIssueLinkStore: (selector: (s: { openInNewTab: boolean }) => unknown) =>
    selector({ openInNewTab: newTabPreferred.value }),
}));

vi.mock("../../issues/components/issue-chip", () => ({
  IssueChip: ({ fallbackLabel }: { fallbackLabel?: string }) => (
    <span data-testid="issue-chip">{fallbackLabel}</span>
  ),
}));

vi.mock("../../projects/components/project-chip", () => ({
  ProjectChip: ({ fallbackLabel }: { fallbackLabel?: string }) => (
    <span data-testid="project-chip">{fallbackLabel}</span>
  ),
}));

// Keep the gesture layer lightweight: the composer popover/picker integration
// is covered by the dedicated picker test, while this file only asserts the
// chip's visual states and click behavior.
vi.mock("@multica/ui/components/ui/popover", () => {
  // Track the Popover's open state so PopoverContent conditionally renders
  // and tests can assert whether the popover is open or closed.
  let _open = false;
  return {
    Popover: ({
      children,
      open,
    }: {
      children: React.ReactNode;
      open?: boolean;
    }) => {
      _open = open ?? false;
      return (
        <span data-popover-open={String(!!open)}>{children}</span>
      );
    },
    PopoverTrigger: ({
      children,
      render,
    }: {
      children?: React.ReactNode;
      render?: (props: Record<string, unknown>) => React.ReactElement;
    }) => {
      const triggerProps = {
        onClick: () => {},
        "aria-expanded": false,
        "aria-haspopup": "dialog" as const,
      };
      const trigger = render?.(triggerProps) ?? <span {...triggerProps} />;
      return <span data-testid="popover-trigger">{trigger}{children}</span>;
    },
    PopoverContent: ({ children }: { children: React.ReactNode }) => {
      if (!_open) return null;
      return <div data-testid="popover-content">{children}</div>;
    },
  };
});

vi.mock("../skill-agent-picker", () => ({
  SkillAgentPicker: ({
    selectedAgentIds,
    onChange,
  }: {
    selectedAgentIds: string[];
    onChange: (agentIds: string[]) => void;
  }) => (
    <div>
      <button
        type="button"
        data-testid="skill-picker-select-agent"
        onClick={() => onChange([...selectedAgentIds, "agent-1"])}
      >
        Select agent
      </button>
      <button
        type="button"
        data-testid="skill-picker-clear"
        onClick={() => onChange([])}
      >
        Clear agents
      </button>
    </div>
  ),
}));

import { MentionView as MentionViewComponent } from "./mention-view";

function renderMention({
  type,
  label,
  id = "x",
  context,
}: {
  type: string;
  label: string;
  id?: string;
  context?: SkillMentionContextValue;
}) {
  const props = {
    node: { attrs: { type, id, label } },
  } as unknown as ComponentProps<typeof MentionView>;
  const ui = <MentionViewComponent {...props} />;
  if (!context) return render(ui);
  return render(
    <SkillMentionContext.Provider value={context}>{ui}</SkillMentionContext.Provider>,
  );
}

function makeSkillContext(
  overrides: Partial<SkillMentionContextValue> = {},
): SkillMentionContextValue {
  return {
    wsId: "ws-1",
    skillMentionAgents: {},
    onSkillMentionChange: vi.fn(),
    openPopoverFor: null,
    setOpenPopoverFor: vi.fn(),
    ...overrides,
  };
}

// --- MUL-5456 modifier-click helpers (upstream) ---
const PROJECT_ID = "8f14e45f-ceea-4d0e-a1a2-9b1c0d3e4f5a";
const PROJECT_PATH = `/acme/projects/${PROJECT_ID}`;

function makeAdapter(overrides: Partial<NavigationAdapter> = {}): NavigationAdapter {
  return {
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    pathname: "/",
    searchParams: new URLSearchParams(),
    getShareableUrl: (p) => `https://app.example${p}`,
    ...overrides,
  };
}

describe("MentionView — actor mentions render as avatar chips", () => {
  it("renders a member mention as an ActorMentionChip, not a plain .mention span", () => {
    const { container } = renderMention({ type: "member", label: "张三" });
    const chip = container.querySelector(".actor-mention-chip");
    expect(chip).not.toBeNull();
    // The legacy plain-text mention span is gone for actor mentions.
    expect(container.querySelector("span.mention")).toBeNull();
    expect(chip!.textContent).toContain("@张三");
  });

  it("renders an agent mention with brand tint", () => {
    const chip = renderMention({ type: "agent", label: "ReviewerBot" }).container.querySelector(
      ".actor-mention-chip",
    )!;
    expect(chip.className).toContain("bg-brand/10");
  });

  it("renders a squad mention with info tint", () => {
    const chip = renderMention({ type: "squad", label: "设计组" }).container.querySelector(
      ".actor-mention-chip",
    )!;
    expect(chip.className).toContain("bg-info/10");
  });

  it("renders an @all mention with warning tint and the all-members aria-label", () => {
    const chip = renderMention({ type: "all", label: "all" }).container.querySelector(
      ".actor-mention-chip",
    )!;
    expect(chip.className).toContain("bg-warning/10");
    expect(chip.getAttribute("aria-label")).toBe(
      "Mention: all workspace members",
    );
  });

  it("makes the editor chip keyboard-focusable with a focus-visible ring", () => {
    const chip = renderMention({ type: "member", label: "张三" }).container.querySelector(
      ".actor-mention-chip",
    )!;
    expect(chip.getAttribute("tabindex")).toBe("0");
    expect(chip.className).toContain("focus-visible:border-ring");
  });

  it("wraps the chip in a MentionHoverCard trigger", () => {
    const { container } = renderMention({ type: "member", label: "张三" });
    const trigger = container.querySelector(
      '[data-slot="hover-card-trigger"]',
    );
    expect(trigger).not.toBeNull();
    expect(trigger!.querySelector(".actor-mention-chip")).not.toBeNull();
  });

  it("layers the per-type hover tint on the chip", () => {
    const memberChip = renderMention({ type: "member", label: "张三" }).container.querySelector(
      ".actor-mention-chip",
    )!;
    expect(memberChip.className).toContain("hover:bg-accent");

    const agentChip = renderMention({ type: "agent", label: "ReviewerBot" }).container.querySelector(
      ".actor-mention-chip",
    )!;
    expect(agentChip.className).toContain("hover:bg-brand/15");
  });
});

describe("MentionView — skill mention gesture", () => {
  it("renders an undesignated skill chip with no count badge", () => {
    const { container } = renderMention({
      type: "skill",
      id: "skill-1",
      label: "code-review",
      context: makeSkillContext(),
    });

    const chip = container.querySelector(".skill-mention-chip")!;
    expect(chip).not.toBeNull();
    expect(chip.textContent).toContain("code-review");
    expect(screen.queryByTestId("skill-mention-count")).not.toBeInTheDocument();
  });

  it("shows the designated agent count on the chip", () => {
    const { container } = renderMention({
      type: "skill",
      id: "skill-1",
      label: "code-review",
      context: makeSkillContext({
        skillMentionAgents: { "skill-1": ["agent-1", "agent-2"] },
      }),
    });

    expect(container.querySelector(".skill-mention-chip")).not.toBeNull();
    expect(screen.getByTestId("skill-mention-count")).toHaveTextContent("2");
  });

  it("opens the picker on click and updates composer state", () => {
    const onSkillMentionChange = vi.fn();
    renderMention({
      type: "skill",
      id: "skill-1",
      label: "code-review",
      context: makeSkillContext({
        onSkillMentionChange,
        openPopoverFor: "skill-1",
      }),
    });

    fireEvent.click(screen.getByTestId("skill-mention-trigger-skill-1"));
    fireEvent.click(screen.getByTestId("skill-picker-select-agent"));
    expect(onSkillMentionChange).toHaveBeenCalledWith("skill-1", ["agent-1"]);
  });

  it("reverts to the undesignated state when the designation is cleared", () => {
    const onSkillMentionChange = vi.fn();
    renderMention({
      type: "skill",
      id: "skill-1",
      label: "code-review",
      context: makeSkillContext({
        skillMentionAgents: { "skill-1": ["agent-1"] },
        onSkillMentionChange,
        openPopoverFor: "skill-1",
      }),
    });

    expect(screen.getByTestId("skill-mention-count")).toHaveTextContent("1");

    fireEvent.click(screen.getByTestId("skill-mention-trigger-skill-1"));
    fireEvent.click(screen.getByTestId("skill-picker-clear"));
    expect(onSkillMentionChange).toHaveBeenCalledWith("skill-1", []);
  });

  it("popover open state survives a React re-render (hoisted into context, not local state)", () => {
    const props = {
      node: { attrs: { type: "skill", id: "skill-1", label: "code-review" } },
    } as unknown as ComponentProps<typeof MentionView>;

    const openContext = makeSkillContext({ openPopoverFor: "skill-1" });

    const { rerender, container } = render(
      <SkillMentionContext.Provider value={openContext}>
        <MentionViewComponent {...props} />
      </SkillMentionContext.Provider>,
    );

    // Popover is open because openPopoverFor matches the skill id.
    expect(screen.getByTestId("popover-content")).toBeInTheDocument();
    expect(container.querySelector('[data-popover-open="true"]')).not.toBeNull();

    // Simulate a NodeView recreation via a React re-render with identical
    // props.  The popover must stay open because the open state lives in
    // context, not in the NodeView's local useState.
    rerender(
      <SkillMentionContext.Provider value={openContext}>
        <MentionViewComponent {...props} />
      </SkillMentionContext.Provider>,
    );

    expect(screen.getByTestId("popover-content")).toBeInTheDocument();
    expect(container.querySelector('[data-popover-open="true"]')).not.toBeNull();

    // Clearing openPopoverFor should close the popover.
    const closedContext = makeSkillContext({ openPopoverFor: null });
    rerender(
      <SkillMentionContext.Provider value={closedContext}>
        <MentionViewComponent {...props} />
      </SkillMentionContext.Provider>,
    );

    expect(screen.queryByTestId("popover-content")).not.toBeInTheDocument();
    expect(container.querySelector('[data-popover-open="false"]')).not.toBeNull();
  });
});

// --- MUL-5456 modifier-click suites (upstream) ---
function renderMentionWithAdapter(
  attrs: { type: string; id: string; label?: string },
  adapter: NavigationAdapter,
) {
  return render(
    <NavigationProvider value={adapter}>
      <MentionViewComponent {...({ node: { attrs } } as any)} />
    </NavigationProvider>,
  );
}

function renderProjectMention(adapter: NavigationAdapter) {
  return renderMentionWithAdapter({ type: "project", id: PROJECT_ID, label: "Roadmap" }, adapter);
}

describe("MentionView project mention", () => {
  it("renders an anchor carrying the project path", () => {
    renderProjectMention(makeAdapter());

    expect(screen.getByTestId("project-chip").closest("a")).toHaveAttribute(
      "href",
      PROJECT_PATH,
    );
  });

  it("pushes on plain click and prevents the anchor's default navigation", () => {
    const push = vi.fn();
    renderProjectMention(makeAdapter({ push }));

    // fireEvent returns false when preventDefault was called.
    const defaultNotPrevented = fireEvent.click(screen.getByTestId("project-chip"));

    expect(defaultNotPrevented).toBe(false);
    expect(push).toHaveBeenCalledWith(PROJECT_PATH);
  });

  it("uses openInNewTab for cmd/ctrl click when available (desktop)", () => {
    const push = vi.fn();
    const openInNewTab = vi.fn();
    renderProjectMention(makeAdapter({ push, openInNewTab }));

    const defaultNotPrevented = fireEvent.click(screen.getByTestId("project-chip"), {
      metaKey: true,
    });

    expect(defaultNotPrevented).toBe(false);
    expect(openInNewTab).toHaveBeenCalledWith(PROJECT_PATH, "Roadmap");
    expect(push).not.toHaveBeenCalled();
  });

  it("leaves modifier-click to the browser when openInNewTab is absent (web)", () => {
    const push = vi.fn();
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    renderProjectMention(makeAdapter({ push }));

    for (const modifier of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }]) {
      const defaultNotPrevented = fireEvent.click(
        screen.getByTestId("project-chip"),
        modifier,
      );
      expect(defaultNotPrevented).toBe(true);
    }

    expect(push).not.toHaveBeenCalled();
    // Native anchor behaviour, not window.open — the latter would collapse
    // background tab / new window / foreground tab into one outcome.
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
  });
});

describe("MentionView issue mention", () => {
  const ISSUE_ID = "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed";
  const ISSUE_PATH = `/acme/issues/${ISSUE_ID}`;

  // The reference implementation the project mention was aligned to — guard it
  // so the two chips can't drift apart again.
  it("leaves modifier-click to the browser when openInNewTab is absent (web)", () => {
    const push = vi.fn();
    renderMentionWithAdapter({ type: "issue", id: ISSUE_ID, label: "MUL-7" }, makeAdapter({ push }));

    const defaultNotPrevented = fireEvent.click(screen.getByTestId("issue-chip"), {
      metaKey: true,
    });

    expect(defaultNotPrevented).toBe(true);
    expect(push).not.toHaveBeenCalled();
  });

  it("uses openInNewTab for cmd/ctrl click when available (desktop)", () => {
    const push = vi.fn();
    const openInNewTab = vi.fn();
    renderMentionWithAdapter(
      { type: "issue", id: ISSUE_ID, label: "MUL-7" },
      makeAdapter({ push, openInNewTab }),
    );

    const defaultNotPrevented = fireEvent.click(screen.getByTestId("issue-chip"), {
      metaKey: true,
    });

    expect(defaultNotPrevented).toBe(false);
    expect(openInNewTab).toHaveBeenCalledWith(ISSUE_PATH, "MUL-7");
    expect(push).not.toHaveBeenCalled();
  });
});
