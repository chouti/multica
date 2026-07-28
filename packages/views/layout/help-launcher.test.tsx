import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configStore } from "@multica/core/config";
import enLayout from "../locales/en/layout.json";
import { HelpLauncher } from "./help-launcher";

// Stubs for hooks the HelpLauncher pulls in. The network / React Query plumbing
// is exercised by integration tests elsewhere; here we drive the runtimes
// read deterministically via the useQuery mock per test.
vi.mock("@multica/core/paths", () => ({
  useCurrentWorkspace: () => ({ id: "ws-test" }),
}));

let runtimesForQuery: unknown = undefined;
vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>(
    "@tanstack/react-query",
  );
  return {
    ...actual,
    useQuery: () => ({ data: runtimesForQuery }),
  };
});

vi.mock("@multica/core/runtimes/queries", () => ({
  runtimeListOptions: (wsId: string) => ({
    queryKey: ["runtimes", wsId, "list"],
    queryFn: () => Promise.resolve([]),
  }),
}));

// react-i18next isn't initialised in the views test env, so resolve the
// selector against the real en/layout.json to assert on actual copy.
vi.mock("../i18n", () => ({
  useT: () => ({
    t: (
      sel: (r: typeof enLayout) => string,
      vars?: Record<string, string>,
    ) => {
      const template = sel(enLayout);
      return vars
        ? template.replace(/\{\{(\w+)\}\}/g, (_, key) => String(vars[key] ?? ""))
        : template;
    },
  }),
}));

// Follows the app-sidebar.test.tsx convention of flattening the Base UI
// dropdown primitives to plain children so the menu content is always in the
// DOM, instead of exercising the real portal/open-state interaction.
//
// The mock deliberately preserves ONE real invariant: DropdownMenuLabel wraps
// Base UI's Menu.GroupLabel, whose useMenuGroupRootContext() throws when it has
// no Menu.Group ancestor. A plain-<div> mock silently swallowed that contract,
// which is exactly how MUL-4819 shipped — a version row rendered outside a
// DropdownMenuGroup crashed the whole app (no error boundary above the sidebar)
// the moment the Help menu opened. Mirroring the throw here keeps the guard.
vi.mock("@multica/ui/components/ui/dropdown-menu", async () => {
  const { createContext, useContext } = await import("react");
  const GroupContext = createContext(false);
  return {
    DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
    DropdownMenuContent: ({ children }: { children: ReactNode }) => <>{children}</>,
    DropdownMenuItem: ({ children }: { children: ReactNode }) => <>{children}</>,
    DropdownMenuGroup: ({ children }: { children: ReactNode }) => (
      <GroupContext.Provider value={true}>{children}</GroupContext.Provider>
    ),
    DropdownMenuLabel: ({ children }: { children: ReactNode }) => {
      if (!useContext(GroupContext)) {
        throw new Error(
          "Base UI: MenuGroupRootContext is missing. Menu group parts must be used within <Menu.Group>.",
        );
      }
      return <div>{children}</div>;
    },
    DropdownMenuSeparator: () => null,
    DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  };
});

afterEach(() => {
  configStore.getState().setBackendBaseline("");
  configStore.setState({ backendBaselineStatus: "loading" });
  runtimesForQuery = undefined;
});

function makeRuntime(cli_version: string | undefined, status: "online" | "offline" = "online") {
  return {
    id: "r",
    workspace_id: "ws-test",
    daemon_id: "d",
    name: "n",
    custom_name: null,
    runtime_mode: "local" as const,
    provider: "p",
    launch_header: "h",
    status,
    device_info: "i",
    metadata: { cli_version },
    owner_id: null,
    visibility: "private" as const,
    profile_id: null,
    last_seen_at: "2026-07-28T00:00:00Z",
    created_at: "2026-07-28T00:00:00Z",
    updated_at: "2026-07-28T00:00:00Z",
  };
}

describe("HelpLauncher provenance rows", () => {
  it("renders CLI as unavailable when no runtimes data exists yet", () => {
    runtimesForQuery = undefined;
    render(<HelpLauncher />);
    expect(screen.getByText(enLayout.help.cli_label)).toBeInTheDocument();
    expect(screen.getByText(enLayout.help.cli_loading)).toBeInTheDocument();
    expect(screen.getByText(enLayout.help.backend_loading)).toBeInTheDocument();
  });

  it("renders CLI version when a daemon is connected and matches the server", () => {
    runtimesForQuery = [makeRuntime("v0.4.12")];
    configStore.getState().setBackendBaseline("v0.4.12");
    render(<HelpLauncher />);
    // Both rows show the same tag; assert both are present and neither carries
    // drift (daemon equal to server → no flag).
    const spans = screen.getAllByText("v0.4.12");
    expect(spans.length).toBeGreaterThanOrEqual(1);
    spans.forEach((s) => expect(s.className).not.toContain("text-destructive"));
  });

  it("renders the CLI version with destructive styling when the daemon is older than the server", () => {
    runtimesForQuery = [makeRuntime("v0.4.11")];
    configStore.getState().setBackendBaseline("v0.4.12");
    render(<HelpLauncher />);
    const valueSpans = screen.getAllByText("v0.4.11");
    expect(valueSpans.length).toBeGreaterThan(0);
    const valueSpan = valueSpans[0];
    expect(valueSpan).toBeDefined();
    expect(valueSpan!.className).toContain("text-destructive");
  });

  it("renders the CLI version without drift when the daemon is newer than the server", () => {
    runtimesForQuery = [makeRuntime("v0.4.13")];
    configStore.getState().setBackendBaseline("v0.4.12");
    render(<HelpLauncher />);
    const valueSpans = screen.getAllByText("v0.4.13");
    expect(valueSpans.length).toBeGreaterThan(0);
    const valueSpan = valueSpans[0];
    expect(valueSpan).toBeDefined();
    expect(valueSpan!.className).not.toContain("text-destructive");
  });

  it("renders CLI as unavailable when runtimes are loaded but none have a cli_version", () => {
    runtimesForQuery = [makeRuntime("")];
    configStore.getState().setBackendBaseline("v0.4.12");
    render(<HelpLauncher />);
    expect(screen.getByText(enLayout.help.cli_unavailable)).toBeInTheDocument();
    expect(screen.getByText("v0.4.12")).toBeInTheDocument();
  });

  it("renders both rows as unavailable after a config failure and an empty runtime list", () => {
    runtimesForQuery = [];
    configStore.getState().setBackendBaseline(); // settled, unavailable
    render(<HelpLauncher />);
    expect(screen.getByText(enLayout.help.cli_unavailable)).toBeInTheDocument();
    expect(screen.getByText(enLayout.help.backend_unavailable)).toBeInTheDocument();
  });

  // MUL-4819 (kept as a guardrail): both DropdownMenuLabels must sit inside a
  // DropdownMenuGroup. Rendering either outside a group would crash the app on
  // open. The DropdownMenuLabel mock throws if it has no Group ancestor.
  it("does not throw when rendering both rows under a DropdownMenuGroup", () => {
    runtimesForQuery = [makeRuntime("v0.4.12")];
    configStore.getState().setBackendBaseline("v0.4.12");
    expect(() => render(<HelpLauncher />)).not.toThrow();
  });
});
