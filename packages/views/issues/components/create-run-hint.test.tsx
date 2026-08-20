// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CreateRunHint } from "./create-run-hint";

// Avoid dragging in the full editor / actor pipelines. The CreateRunHint
// only needs the agent name + a couple of i18n keys; we stub the heavy
// hooks at the module boundary so the unit test stays at component level.
vi.mock("../hooks/use-issue-trigger-preview", () => ({
  useIssueTriggerPreview: () => ({ isLoading: false, totalCount: 0, triggers: [] }),
}));

vi.mock("@multica/core/workspace/hooks", () => ({
  useActorName: () => ({
    getActorName: (_type: string, id: string) =>
      id === "agent-1" ? "Alice" : "Unknown",
  }),
}));

vi.mock("../../common/actor-avatar", () => ({
  ActorAvatar: () => <span data-testid="actor-avatar" />,
}));

import { I18nProvider } from "@multica/core/i18n/react";
import enCommon from "../../locales/en/common.json";
import enModals from "../../locales/en/modals.json";
import enIssues from "../../locales/en/issues.json";
import jaModals from "../../locales/ja/modals.json";

const enResources = { en: { common: enCommon, modals: enModals, issues: enIssues } };
const jaResources = { ja: { common: enCommon, modals: jaModals, issues: enIssues } };

function renderWithI18n(
  ui: React.ReactElement,
  resources: Record<string, unknown>,
  locale: string,
) {
  return render(
    <I18nProvider locale={locale as never} resources={resources as never}>
      {ui}
    </I18nProvider>,
  );
}

describe("CreateRunHint —", () => {
  it("renders no designation line when the designations array is empty", () => {
    renderWithI18n(
      <CreateRunHint status="todo" designations={[]} />,
      enResources,
      "en",
    );
    expect(screen.queryByTestId("create-run-hint-designation")).toBeNull();
  });

  it("renders a designation line per entry using the localized template", () => {
    renderWithI18n(
      <CreateRunHint
        status="todo"
        designations={[
          { skillLabel: "code-review", agentName: "Alice", willRun: true },
        ]}
      />,
      enResources,
      "en",
    );
    const lines = screen.getAllByTestId("create-run-hint-designation");
    expect(lines).toHaveLength(1);
    expect(lines[0]?.textContent).toContain("Designated @code-review for @Alice");
  });

  it("switches to the bind-only template when the entry is non-run-bound", () => {
    renderWithI18n(
      <CreateRunHint
        status="backlog"
        designations={[
          { skillLabel: "code-review", agentName: "Alice", willRun: false },
        ]}
      />,
      enResources,
      "en",
    );
    const lines = screen.getAllByTestId("create-run-hint-designation");
    expect(lines).toHaveLength(1);
    expect(lines[0]?.textContent).toContain("will run later");
  });

  it("renders the localized template per locale (ja)", () => {
    // The `ja` modals bundle carries a fully-translated
    // `skill_designation.run_hint_will_run` value, so the renderer picks
    // it up rather than falling back to en. This mirrors the locale
    // contract from conventions.mdx: keys follow the namespace, copy is
    // shipped in every supported locale.
    renderWithI18n(
      <CreateRunHint
        status="todo"
        designations={[
          { skillLabel: "code-review", agentName: "Alice", willRun: true },
        ]}
      />,
      jaResources,
      "ja",
    );
    const lines = screen.getAllByTestId("create-run-hint-designation");
    // The Japanese template names the skill and agent using `@name`;
    // exact wording is owned by the locale bundle — only the
    // "Designated" / 指定 framing + the @name references are load-bearing.
    expect(lines[0]?.textContent).toContain("@code-review");
    expect(lines[0]?.textContent).toContain("@Alice");
    expect(lines[0]?.textContent).toContain("指定");
  });

  it("renders the unresolved hint when unresolvedSkillLabels is non-empty", () => {
    renderWithI18n(
      <CreateRunHint
        status="todo"
        unresolvedSkillLabels={["code-review"]}
      />,
      enResources,
      "en",
    );
    expect(screen.getByTestId("create-run-hint-unresolved")).toBeInTheDocument();
  });
});