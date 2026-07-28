import { describe, it, expect } from "vitest";
import type { AgentRuntime } from "@multica/core/types/agent";
import { selectRepresentativeCliVersion } from "./select-cli-version";

function makeRuntime(overrides: Partial<AgentRuntime> = {}): AgentRuntime {
  return {
    id: "r",
    workspace_id: "ws",
    daemon_id: "d",
    name: "n",
    custom_name: null,
    runtime_mode: "local",
    provider: "p",
    launch_header: "h",
    status: "online",
    device_info: "i",
    metadata: {},
    owner_id: null,
    visibility: "private",
    profile_id: null,
    last_seen_at: "2026-07-28T00:00:00Z",
    created_at: "2026-07-28T00:00:00Z",
    updated_at: "2026-07-28T00:00:00Z",
    ...overrides,
  };
}

describe("selectRepresentativeCliVersion", () => {
  it("returns null on an empty runtime list", () => {
    expect(selectRepresentativeCliVersion([])).toBeNull();
  });

  it("returns the only row's cli_version when present", () => {
    expect(
      selectRepresentativeCliVersion([
        makeRuntime({ metadata: { cli_version: "v0.4.12" } }),
      ]),
    ).toBe("v0.4.12");
  });

  it("prefers an online daemon over an offline one", () => {
    const offline = makeRuntime({
      id: "offline",
      status: "offline",
      last_seen_at: "2026-07-29T00:00:00Z", // newer, but offline
      metadata: { cli_version: "v0.4.99" },
    });
    const online = makeRuntime({
      id: "online",
      status: "online",
      last_seen_at: "2026-07-28T00:00:00Z", // older, but online
      metadata: { cli_version: "v0.4.12" },
    });
    expect(selectRepresentativeCliVersion([offline, online])).toBe("v0.4.12");
  });

  it("falls through within the online set to the next online row", () => {
    const blank = makeRuntime({
      id: "blank-online",
      status: "online",
      last_seen_at: "2026-07-29T00:00:00Z",
      metadata: {},
    });
    const filled = makeRuntime({
      id: "filled-online",
      status: "online",
      last_seen_at: "2026-07-28T00:00:00Z",
      metadata: { cli_version: "v0.4.12" },
    });
    expect(selectRepresentativeCliVersion([blank, filled])).toBe("v0.4.12");
  });

  it("falls through to offline rows when no online rows exist at all", () => {
    const stale = makeRuntime({
      id: "stale-offline",
      status: "offline",
      last_seen_at: "2026-07-28T00:00:00Z",
      metadata: { cli_version: "v0.4.12-stale" },
    });
    expect(selectRepresentativeCliVersion([stale])).toBe("v0.4.12-stale");
  });

  it("orders online rows by most-recent last_seen_at first", () => {
    const older = makeRuntime({
      id: "older",
      status: "online",
      last_seen_at: "2026-07-20T00:00:00Z",
      metadata: { cli_version: "v0.4.10" },
    });
    const newer = makeRuntime({
      id: "newer",
      status: "online",
      last_seen_at: "2026-07-28T00:00:00Z",
      metadata: { cli_version: "v0.4.12" },
    });
    expect(selectRepresentativeCliVersion([older, newer])).toBe("v0.4.12");
  });

  it("returns null when no row has a cli_version", () => {
    expect(
      selectRepresentativeCliVersion([
        makeRuntime({ metadata: {} }),
        makeRuntime({ id: "r2", metadata: { cli_version: "" } }),
      ]),
    ).toBeNull();
  });

  it("ignores non-string cli_version metadata (defensive)", () => {
    expect(
      selectRepresentativeCliVersion([
        makeRuntime({ metadata: { cli_version: 42 as unknown as string } }),
      ]),
    ).toBeNull();
  });
});
