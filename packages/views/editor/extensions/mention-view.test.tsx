import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import type { MentionView } from "./mention-view";
import {
  SkillMentionContext,
  type SkillMentionContextValue,
} from "../skill-mention-context";

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

// Keep the gesture layer lightweight: the composer popover/picker integration
// is covered by the dedicated picker test, while this file only asserts the
// chip's visual states and click behavior.
vi.mock("@multica/ui/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
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
  PopoverContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="popover-content">{children}</div>
  ),
}));

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
      context: makeSkillContext({ onSkillMentionChange }),
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
      }),
    });

    expect(screen.getByTestId("skill-mention-count")).toHaveTextContent("1");

    fireEvent.click(screen.getByTestId("skill-mention-trigger-skill-1"));
    fireEvent.click(screen.getByTestId("skill-picker-clear"));
    expect(onSkillMentionChange).toHaveBeenCalledWith("skill-1", []);
  });
});
