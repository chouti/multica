"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Agent } from "@multica/core/types";
import { renderWithI18n } from "../test/i18n";
import { SkillAgentPicker } from "./skill-agent-picker";

const listAgents = vi.hoisted(() => vi.fn());
const getSkill = vi.hoisted(() => vi.fn());

vi.mock("@multica/core/api", () => ({
  api: {
    listAgents,
    getSkill,
  },
}));

vi.mock("@multica/core/agents", () => ({
  useAgentPresenceDetail: () => ({ availability: "online", workload: "idle" }),
}));

function agentFixture(overrides: Partial<Agent>): Agent {
  return {
    id: "agent-1",
    workspace_id: "ws-1",
    runtime_id: "runtime-1",
    name: "Walt",
    description: "",
    instructions: "",
    avatar_url: null,
    runtime_mode: "local",
    runtime_config: {},
    custom_args: [],
    visibility: "workspace",
    permission_mode: "public_to",
    invocation_targets: [],
    status: "idle",
    max_concurrent_tasks: 1,
    model: "",
    owner_id: null,
    skills: [],
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
    archived_at: null,
    archived_by: null,
    ...overrides,
  };
}

function renderPicker({
  agents,
  skillName,
  selectedAgentIds = [],
  onChange = vi.fn(),
}: {
  agents: Agent[];
  skillName?: string;
  selectedAgentIds?: string[];
  onChange?: (agentIds: string[]) => void;
}) {
  listAgents.mockResolvedValue(agents);
  getSkill.mockResolvedValue({
    id: "skill-1",
    workspace_id: "ws-1",
    name: skillName ?? "code-review",
    description: "",
    config: {},
    created_by: null,
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
  });

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return {
    onChange,
    ...renderWithI18n(
      <QueryClientProvider client={queryClient}>
        <SkillAgentPicker
          skillId="skill-1"
          wsId="ws-1"
          fallbackSkillName="label-fallback"
          selectedAgentIds={selectedAgentIds}
          onChange={onChange}
        />
      </QueryClientProvider>,
    ),
  };
}

describe("SkillAgentPicker", () => {
  it("renders active agents and toggles selections", async () => {
    const onChange = vi.fn();
    renderPicker({
      onChange,
      agents: [
        agentFixture({ id: "agent-1", name: "Walt" }),
        agentFixture({ id: "agent-2", name: "Bob" }),
      ],
    });

    expect(await screen.findByText("Walt")).toBeInTheDocument();
    expect(screen.getByText("Bob")).toBeInTheDocument();
    expect(screen.queryByText(/bound/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Toggle Walt" }));
    expect(onChange).toHaveBeenCalledWith(["agent-1"]);

    fireEvent.click(screen.getByRole("button", { name: "Toggle Bob" }));
    expect(onChange).toHaveBeenCalledWith(["agent-2"]);
  });

  it("supports multi-select by appending to the current selection", async () => {
    const onChange = vi.fn();
    renderPicker({
      onChange,
      selectedAgentIds: ["agent-1"],
      agents: [
        agentFixture({ id: "agent-1", name: "Walt" }),
        agentFixture({ id: "agent-2", name: "Bob" }),
      ],
    });

    fireEvent.click(await screen.findByRole("button", { name: "Toggle Bob" }));
    expect(onChange).toHaveBeenCalledWith(["agent-1", "agent-2"]);
  });

  it("omits archived agents from the list", async () => {
    renderPicker({
      agents: [
        agentFixture({ id: "agent-1", name: "Active Agent" }),
        agentFixture({
          id: "agent-2",
          name: "Archived Agent",
          archived_at: "2026-07-10T00:00:00Z",
        }),
      ],
    });

    expect(await screen.findByText("Active Agent")).toBeInTheDocument();
    expect(screen.queryByText("Archived Agent")).not.toBeInTheDocument();
  });

  it("populates from a cold cache by fetching agents via useQuery", async () => {
    renderPicker({
      agents: [agentFixture({ id: "agent-1", name: "Cold Cache Agent" })],
    });

    expect(screen.queryByText("Cold Cache Agent")).not.toBeInTheDocument();
    expect(await screen.findByText("Cold Cache Agent")).toBeInTheDocument();
    await waitFor(() => expect(listAgents).toHaveBeenCalled());
  });

  it("prefers the fetched skill name over the markdown label", async () => {
    renderPicker({
      skillName: "true-skill-name",
      agents: [agentFixture({ id: "agent-1", name: "Walt" })],
    });

    expect(await screen.findByText("true-skill-name")).toBeInTheDocument();
    expect(screen.queryByText("label-fallback")).not.toBeInTheDocument();
  });
});
