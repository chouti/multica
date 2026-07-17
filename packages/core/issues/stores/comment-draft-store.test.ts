// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { useCommentDraftStore } from "./comment-draft-store";

const flush = () =>
  new Promise<void>((resolve) => queueMicrotask(() => resolve()));

// Node 25 ships a partial `localStorage` shim under jsdom that's missing
// `clear`/`removeItem`; replace it with a real in-memory Storage so persist
// can round-trip values.
beforeAll(() => {
  if (typeof globalThis.localStorage?.clear !== "function") {
    const values = new Map<string, string>();
    const storage: Storage = {
      get length() {
        return values.size;
      },
      clear: () => values.clear(),
      getItem: (k) => values.get(k) ?? null,
      key: (i) => Array.from(values.keys())[i] ?? null,
      removeItem: (k) => {
        values.delete(k);
      },
      setItem: (k, v) => {
        values.set(k, v);
      },
    };
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: storage,
    });
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: storage,
    });
  }
});

describe("comment draft store — skillMentionAgents round-trip", () => {
  beforeEach(async () => {
    useCommentDraftStore.setState({ drafts: {} });
    // Allow any pending microtasks (persist rehydrate) to settle.
    await flush();
  });

  it("round-trips skillMentionAgents through getDraftPayload", () => {
    const { setDraft, getDraftPayload } = useCommentDraftStore.getState();

    setDraft("new:issue-1", {
      content: "hello",
      skillMentionAgents: {
        "skill-1": ["agent-uuid-1", "agent-uuid-2"],
      },
    });

    const payload = getDraftPayload("new:issue-1");
    expect(payload).toBeDefined();
    expect(payload!.content).toBe("hello");
    expect(payload!.skillMentionAgents).toEqual({
      "skill-1": ["agent-uuid-1", "agent-uuid-2"],
    });
  });

  it("omits skillMentionAgents when set to empty object", () => {
    const { setDraft, getDraftPayload } = useCommentDraftStore.getState();

    // First write with data.
    setDraft("new:issue-1", {
      content: "hello",
      skillMentionAgents: { "skill-1": ["agent-uuid-1"] },
    });
    expect(
      getDraftPayload("new:issue-1")!.skillMentionAgents,
    ).toEqual({ "skill-1": ["agent-uuid-1"] });

    // Overwrite with empty map — store omits the field to keep disk clean.
    setDraft("new:issue-1", {
      content: "updated",
      skillMentionAgents: {},
    });

    const payload = getDraftPayload("new:issue-1");
    expect(payload).toBeDefined();
    expect(payload!.content).toBe("updated");
    expect(payload!.skillMentionAgents).toBeUndefined();
  });

  it("preserves content when skillMentionAgents is not provided", () => {
    const { setDraft, getDraftPayload } = useCommentDraftStore.getState();

    setDraft("new:issue-2", {
      content: "plain comment",
    });

    const payload = getDraftPayload("new:issue-2");
    expect(payload).toBeDefined();
    expect(payload!.content).toBe("plain comment");
    expect(payload!.skillMentionAgents).toBeUndefined();
  });

  it("returns undefined for a key that was never written", () => {
    const { getDraftPayload } = useCommentDraftStore.getState();
    expect(getDraftPayload("new:nonexistent")).toBeUndefined();
  });
});
