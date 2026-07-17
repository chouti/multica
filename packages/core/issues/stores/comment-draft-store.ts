import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { createWorkspaceAwareStorage, registerForWorkspaceRehydration } from "../../platform/workspace-storage";
import { defaultStorage } from "../../platform/storage";

/**
 * Per-comment draft persistence — survives:
 *  - virtualization unmount (the reason this exists: when a TipTap editor
 *    scrolls out of the Virtuoso viewport, its in-memory state is lost)
 *  - tab close / accidental Cmd-W
 *  - reload
 *
 * Keys are issue-scoped because createWorkspaceAwareStorage only partitions
 * by workspace, not by issue. Without issueId in the key, two issues with
 * thread replies open in adjacent desktop tabs would collide.
 */

export type CommentDraftKey =
  | `new:${string}`              // top-level CommentInput, key = `new:${issueId}`
  | `reply:${string}:${string}`  // ReplyInput inside a thread, key = `reply:${issueId}:${rootCommentId}`
  | `edit:${string}:${string}`;  // inline edit on existing comment, key = `edit:${issueId}:${commentId}`

interface CommentDraft {
  content: string;
  /**
   * Composer-held skill→agent-id map for skill mentions with explicit
   * agent designations. Persisted so a reload restores the user's
   * chip-by-chip designations — review finding #7.
   */
  skillMentionAgents?: Record<string, string[]>;
  updatedAt: number;
}

export interface CommentDraftPayload {
  content: string;
  skillMentionAgents?: Record<string, string[]>;
}

interface CommentDraftStore {
  drafts: Record<string, CommentDraft>;
  getDraft: (key: CommentDraftKey) => string | undefined;
  /**
   * Read the persisted draft content AND the skill-mention designations.
   * Both are returned together so a restored draft hydrates the
   * composer state as a unit (review finding #7).
   */
  getDraftPayload: (key: CommentDraftKey) => CommentDraftPayload | undefined;
  setDraft: (key: CommentDraftKey, payload: CommentDraftPayload) => void;
  clearDraft: (key: CommentDraftKey) => void;
}

// Drafts older than 30 days are dropped on store init. Without TTL the store
// would accumulate every edit attempt across every issue indefinitely and
// slowly leak localStorage quota.
const TTL_MS = 30 * 24 * 60 * 60 * 1000;

function pruneStaleDrafts(drafts: Record<string, CommentDraft>): Record<string, CommentDraft> {
  const cutoff = Date.now() - TTL_MS;
  const out: Record<string, CommentDraft> = {};
  for (const [k, v] of Object.entries(drafts)) {
    if (v.updatedAt >= cutoff && v.content.trim().length > 0) {
      out[k] = v;
    }
  }
  return out;
}

export const useCommentDraftStore = create<CommentDraftStore>()(
  persist(
    (set, get) => ({
      drafts: {},
      getDraft: (key) => get().drafts[key]?.content,
      getDraftPayload: (key) => {
        const d = get().drafts[key];
        if (!d) return undefined;
        return {
          content: d.content,
          skillMentionAgents: d.skillMentionAgents,
        };
      },
      setDraft: (key, payload) =>
        set((s) => {
          const next: CommentDraft = {
            content: payload.content,
            updatedAt: Date.now(),
          };
          // Only persist skillMentionAgents when there is something to
          // rehydrate — keeps the on-disk schema clean for the no-designation
          // common case and avoids noise in test diffs.
          if (payload.skillMentionAgents && Object.keys(payload.skillMentionAgents).length > 0) {
            next.skillMentionAgents = payload.skillMentionAgents;
          }
          return { drafts: { ...s.drafts, [key]: next } };
        }),
      clearDraft: (key) =>
        set((s) => {
          if (!(key in s.drafts)) return s;
          const next = { ...s.drafts };
          delete next[key];
          return { drafts: next };
        }),
    }),
    {
      name: "multica_comment_drafts",
      storage: createJSONStorage(() => createWorkspaceAwareStorage(defaultStorage)),
      onRehydrateStorage: () => (state) => {
        if (state) {
          state.drafts = pruneStaleDrafts(state.drafts);
        }
      },
    },
  ),
);

registerForWorkspaceRehydration(() => useCommentDraftStore.persist.rehydrate());
