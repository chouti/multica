export type CommentType = "comment" | "status_change" | "progress_update" | "system";

// `system` is used by platform-generated rows (e.g. the parent-issue
// child-done notification, MUL-2538). System rows carry a zero UUID for
// author_id; render paths should branch on author_type rather than the UUID.
export type CommentAuthorType = "member" | "agent" | "system";

export interface Reaction {
  id: string;
  comment_id: string;
  actor_type: string;
  actor_id: string;
  emoji: string;
  created_at: string;
}

export interface Comment {
  id: string;
  issue_id: string;
  author_type: CommentAuthorType;
  author_id: string;
  content: string;
  type: CommentType;
  parent_id: string | null;
  reactions: Reaction[];
  attachments: import("./attachment").Attachment[];
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  resolved_by_type: CommentAuthorType | null;
  resolved_by_id: string | null;
  source_task_id?: string | null;
  // The quick action that produced this comment (MUL-5465). A quick action
  // posts an ORDINARY comment and marks it with this id; the collapsed card
  // keys off the id rather than a dedicated `type`, because `type` is
  // client-supplied on the generic comment endpoint and would be forgeable.
  quick_action_id?: string | null;
  // Per-target result of every explicit @agent / @squad mention in this comment
  // (MUL-4525 §2). Present only on create/edit responses; older servers omit it.
  trigger_outcomes?: CommentTriggerOutcome[];
}

// The domain result of one explicitly-mentioned trigger target. Success-shaped
// statuses (queued/coalesced/deferred) mean the mention was handled; `blocked`
// means it was refused with an enumeration-safe reason_code.
export type CommentTriggerStatus =
  | "queued"
  | "coalesced"
  | "deferred"
  | "blocked";

export interface CommentTriggerOutcome {
  target_type: string; // "agent" | "squad"
  target_id: string;
  status: CommentTriggerStatus | string;
  reason_code: string;
}

export type CommentTriggerSource =
  | "issue_assignee"
  | "mention_agent"
  | "mention_squad_leader"
  | "thread_parent"
  | "conversation_continuation"
  // Frontend-only: the composer tags a skill-designated preview row with this
  // source. The backend preview never emits it (it discards
  // skill_mention_agents), but the create-comment contract can.
  | "mention_skill";

export interface CommentTriggerPreviewAgent {
  id: string;
  name: string;
  avatar_url?: string;
  source: CommentTriggerSource | string;
  reason: string;
}

export interface CommentTriggerPreview {
  agents: CommentTriggerPreviewAgent[];
  // Explicit @agent / @squad mentions that will NOT trigger if posted as-is
  // (MUL-4525 §2). Additive: older servers omit it.
  blocked?: CommentTriggerOutcome[];
}

// Per-agent result of one @skill designation carried on an issue create or
// update request (R16, KTD10). Mirrors CommentTriggerOutcome — same status
// shape, same reason-code enumeration — so the toast surface can reuse a
// single reason-code → copy mapping. target_id is the agent id the caller
// itself designated (already known to it), never a name, so a blocked
// private target leaks nothing new. The new `bound` / `merged` statuses are
// non-error end states exclusive to the issue path (comment-path
// designations always enqueue).
export type IssueSkillDesignationStatus =
 | "queued"
 | "coalesced"
 | "deferred"
 | "blocked"
 | "bound"
 | "merged"
 | string;

export interface IssueSkillDesignationOutcome {
  target_type: string;
  target_id: string;
  status: IssueSkillDesignationStatus;
  reason_code: string;
}
