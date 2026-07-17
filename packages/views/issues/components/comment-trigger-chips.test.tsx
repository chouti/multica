import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import type { CommentTriggerPreviewAgent } from "@multica/core/types";
import { renderWithI18n } from "../../test/i18n";
import { CommentTriggerChips } from "./comment-trigger-chips";

vi.mock("@multica/core/agents", () => ({
  useAgentPresenceDetail: () => ({ availability: "online", workload: "idle" }),
}));

vi.mock("@multica/core/paths", () => ({
  useCurrentWorkspace: () => ({ id: "ws-1" }),
}));

vi.mock("../../common/actor-avatar", () => ({
  AgentStatusDot: () => <span data-testid="status-dot" />,
}));

const walt: CommentTriggerPreviewAgent = {
  id: "agent-1",
  name: "Walt",
  source: "issue_assignee",
  reason: "",
};

const bob: CommentTriggerPreviewAgent = {
  id: "agent-2",
  name: "Bob",
  source: "mention_agent",
  reason: "",
};

// U1: skill mentions route via explicit designation
// (server/internal/handler/comment.go: bindAndEnqueueSkillMentions). The chip
// must surface WHY this agent was picked — without an explicit label the user
// would see "trigger", which is the unknown-source fallback and a lie.
const skillDesignee: CommentTriggerPreviewAgent = {
  id: "agent-3",
  name: "Gus",
  source: "mention_skill",
  reason: "A skill mention designated this agent.",
};

// Reply-parent: the agent owns the parent comment. Distinct from a fresh
// @mention because the source is "they posted the comment you're replying to".
const threadReply: CommentTriggerPreviewAgent = {
  id: "agent-4",
  name: "Hank",
  source: "thread_parent",
  reason: "This reply will trigger the parent comment's author.",
};

describe("CommentTriggerChips", () => {
  it("renders nothing without agents", () => {
    const { container } = renderWithI18n(
      <CommentTriggerChips agents={[]} suppressedAgentIds={new Set()} onToggle={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders a single agent as a full sentence and toggles on click", () => {
    const onToggle = vi.fn();
    renderWithI18n(
      <CommentTriggerChips agents={[walt]} suppressedAgentIds={new Set()} onToggle={onToggle} />,
    );

    const chip = screen.getByRole("button");
    expect(chip).toHaveTextContent("Will start when sent");
    expect(chip).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(chip);
    expect(onToggle).toHaveBeenCalledWith("agent-1");
  });

  it("dims a suppressed single agent into the skip state", () => {
    renderWithI18n(
      <CommentTriggerChips
        agents={[walt]}
        suppressedAgentIds={new Set(["agent-1"])}
        onToggle={vi.fn()}
      />,
    );

    const chip = screen.getByRole("button");
    expect(chip).toHaveTextContent("Won't start this time");
    expect(chip).toHaveAttribute("aria-pressed", "true");
  });

  it("collapses several agents into a stack with an active count", () => {
    renderWithI18n(
      <CommentTriggerChips
        agents={[walt, bob]}
        suppressedAgentIds={new Set()}
        onToggle={vi.fn()}
      />,
    );

    expect(screen.getByRole("button")).toHaveTextContent("2 agents will start when sent");
  });

  it("counts only non-suppressed agents in the sentence", () => {
    renderWithI18n(
      <CommentTriggerChips
        agents={[walt, bob]}
        suppressedAgentIds={new Set(["agent-2"])}
        onToggle={vi.fn()}
      />,
    );

    expect(screen.getByRole("button")).toHaveTextContent("1 agent will start when sent");
  });

  it("switches to the none-will-trigger state when every agent is suppressed", () => {
    renderWithI18n(
      <CommentTriggerChips
        agents={[walt, bob]}
        suppressedAgentIds={new Set(["agent-1", "agent-2"])}
        onToggle={vi.fn()}
      />,
    );

    expect(screen.getByRole("button")).toHaveTextContent("No agents will start");
  });

  it("opens the popover on click and toggles a row", () => {
    const onToggle = vi.fn();
    renderWithI18n(
      <CommentTriggerChips
        agents={[walt, bob]}
        suppressedAgentIds={new Set()}
        onToggle={onToggle}
      />,
    );

    fireEvent.click(screen.getByRole("button"));

    const row = screen.getByRole("button", { name: /Bob/ });
    expect(row).toHaveTextContent("Bob");
    fireEvent.click(row);
    expect(onToggle).toHaveBeenCalledWith("agent-2");
  });

  it("names a blocked mention with an error reason instead of a count", () => {
    renderWithI18n(
      <CommentTriggerChips
        agents={[]}
        blocked={[
          {
            target_type: "agent",
            target_id: "deadbeef-0001",
            status: "blocked",
            reason_code: "invocation_not_allowed",
          },
        ]}
        draftContent="[@Go](mention://agent/deadbeef-0001) hi"
        suppressedAgentIds={new Set()}
        onToggle={vi.fn()}
      />,
    );

    // The name the user typed (not a "1 mention won't trigger" count) plus the
    // short no-permission reason.
    expect(screen.getByText("Go")).toBeInTheDocument();
    expect(screen.getByText("No permission")).toBeInTheDocument();
    expect(screen.queryByText(/won't trigger/i)).not.toBeInTheDocument();
  });

  it("falls back to the reason alone when the label can't be correlated", () => {
    renderWithI18n(
      <CommentTriggerChips
        agents={[]}
        blocked={[
          {
            target_type: "agent",
            target_id: "deadbeef-0001",
            status: "blocked",
            reason_code: "invocation_not_allowed",
          },
        ]}
        // No matching mention markup for the blocked target → no label available.
        draftContent="plain text"
        suppressedAgentIds={new Set()}
        onToggle={vi.fn()}
      />,
    );

    expect(screen.getByText("No permission")).toBeInTheDocument();
    expect(screen.queryByText("Go")).not.toBeInTheDocument();
  });

  it("renders one named chip per blocked mention", () => {
    renderWithI18n(
      <CommentTriggerChips
        agents={[]}
        blocked={[
          { target_type: "agent", target_id: "deadbeef-0001", status: "blocked", reason_code: "invocation_not_allowed" },
          { target_type: "squad", target_id: "cafef00d-0002", status: "blocked", reason_code: "runtime_offline" },
        ]}
        draftContent="[@Go](mention://agent/deadbeef-0001) [@Ops](mention://squad/cafef00d-0002)"
        suppressedAgentIds={new Set()}
        onToggle={vi.fn()}
      />,
    );

    expect(screen.getByText("Go")).toBeInTheDocument();
    expect(screen.getByText("No permission")).toBeInTheDocument();
    expect(screen.getByText("Ops")).toBeInTheDocument();
    expect(screen.getByText("Runtime offline")).toBeInTheDocument();
  });

  // U1: a skill-designated agent must show WHY it was picked. Without the
  // explicit case the chip falls through to "trigger" (the unknown-source
  // label), which is a lie for a real, designated agent. The single-chip
  // visible surface is just the sentence ("Will start when sent") — the
  // source label lives in the tooltip aria-label, which we assert here.
  it("labels a mention_skill trigger with its dedicated source tag", () => {
    renderWithI18n(
      <CommentTriggerChips
        agents={[skillDesignee]}
        suppressedAgentIds={new Set()}
        onToggle={vi.fn()}
      />,
    );

    const chip = screen.getByRole("button", { name: /Gus/ });
    expect(chip.getAttribute("aria-label")).toContain("skill mention");
    // Must not fall through to the generic unknown-source fallback. The
    // fallback label is the single word "trigger" with no qualifier.
    expect(chip.getAttribute("aria-label")).not.toContain("trigger: trigger");
  });

  // Reply-parent is distinct from a fresh @mention: the trigger fires because
  // the user is replying to that agent's comment, not because they typed its
  // mention markup. A generic "trigger" label would erase that signal.
  it("labels a thread_parent trigger as a reply", () => {
    renderWithI18n(
      <CommentTriggerChips
        agents={[threadReply]}
        suppressedAgentIds={new Set()}
        onToggle={vi.fn()}
      />,
    );

    const chip = screen.getByRole("button", { name: /Hank/ });
    expect(chip.getAttribute("aria-label")).toContain("reply");
  });

  // The new sources must work in the multi-agent stack too, so a comment that
  // triggers three agents for three different reasons still distinguishes them
  // in the popover rows (one label per source).
  it("distinguishes mention_skill and thread_parent in the multi-agent popover", () => {
    renderWithI18n(
      <CommentTriggerChips
        agents={[walt, skillDesignee, threadReply]}
        suppressedAgentIds={new Set()}
        onToggle={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button"));
    // The popover renders each agent's source as the trailing label.
    expect(screen.getByText("assignee")).toBeInTheDocument();
    expect(screen.getByText("skill mention")).toBeInTheDocument();
    expect(screen.getByText("reply")).toBeInTheDocument();
  });
});
