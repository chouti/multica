/**
 * Strip mention markdown syntax to plain text.
 *
 * Handles:
 * - Simple mentions: `[@Name](mention://agent/id)` → `@Name`
 * - Escaped brackets in names: `[@David\[TF\]](mention://agent/id)` → `@David[TF]`
 * - Issue mentions (no @): `[MUL-123](mention://issue/id)` → `MUL-123`
 * - Does NOT touch regular markdown links: `[docs](https://...)` stays unchanged
 * - Does NOT touch backslash-escaped mentions: `\[@Name](mention://...)` stays unchanged
 *
 * The regex mirrors the tokenizer in mention-extension.ts.
 */
export function stripMentionMarkdown(text: string): string {
  return text.replace(
    /(?<![\\])\[(@?)((?:\\.|[^\]])+)\]\(mention:\/\/\w+\/[^)]+\)/g,
    (_, prefix: string, rawLabel: string) => {
      const label = rawLabel.replace(/\\\[/g, "[").replace(/\\\]/g, "]");
      return `${prefix}${label}`;
    },
  );
}

/**
 * Strip ONLY skill mention markdown to plain text, leaving every other
 * mention type as a live chip: `[@code-review](mention://skill/id)` →
 * `@code-review` while `[@Alice](mention://member/id)` stays untouched.
 *
 * Used where skill designation has no business meaning but other mentions
 * still do — the manual→agent mode switch seeds the agent prompt from the
 * description, and the agent-mode panel suppresses skill items in its `@`
 * menu (KD5), so a skill chip must not cross the switch as a dead affordance.
 *
 * The regex mirrors stripMentionMarkdown with the mention type pinned to
 * `skill`.
 */
export function stripSkillMentionMarkdown(text: string): string {
  return text.replace(
    /(?<![\\])\[(@?)((?:\\.|[^\]])+)\]\(mention:\/\/skill\/[^)]+\)/g,
    (_, prefix: string, rawLabel: string) => {
      const label = rawLabel.replace(/\\\[/g, "[").replace(/\\\]/g, "]");
      return `${prefix}${label}`;
    },
  );
}
