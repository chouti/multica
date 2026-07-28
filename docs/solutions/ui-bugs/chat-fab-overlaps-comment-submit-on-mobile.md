---
title: "Floating chat FAB overlaps the comment submit button on mobile issue detail"
date: 2026-07-28
category: ui-bugs
module: packages/views/issues
problem_type: ui_bug
component: floating-chat-fab
symptoms:
  - "On a narrow viewport (iPhone 15 Pro, ~393pt) the floating chat FAB (absolute bottom-2 right-2 size-10 z-50) covers the issue comment submit button at the bottom-right of the pinned comment input"
  - "The submit button is untappable where it sits under the FAB; desktop widths are unaffected"
root_cause: scope_issue
resolution_type: code_fix
severity: medium
tags: [floating-chat, fab, mobile, z-index, viewport, pin-comment, submit-button, issue-detail]
---

# Floating chat FAB overlaps the comment submit button on mobile issue detail

## Problem

On narrow viewports (iPhone 15 Pro, ~393pt), the floating chat FAB — `ChatFab` (`packages/views/chat/components/chat-fab.tsx:62`), an `absolute bottom-2 right-2 z-50 size-10` circular button mounted on every dashboard page — sits on top of the issue detail's bottom-right submit button, making the comment submit button untappable where it sits underneath. Desktop widths are unaffected. This is a fork customization (`pin-comment`) conflicting with an upstream global component (`ChatFab`), not a regression introduced by any specific release.

## Symptoms

- On mobile Safari (iPhone 15 Pro), the chat FAB (a round bubble with the `MessageCircle` icon) sits on top of the comment submit button at the bottom-right of the issue detail page.
- The submit button cannot be tapped in the region the FAB covers.
- Desktop and wide viewports are unaffected — the two elements share the bottom-right corner only when the viewport is too narrow for them to coexist.

## What Didn't Work

- **Keyword-searching `comment-input.tsx` for "send"/"submit"** returned nothing useful. The submit control is a shared `<SubmitButton>` component (`packages/views/issues/components/comment-input.tsx:314`), so a literal keyword search for "send" misses it. The actionable element is the *container* that pins `CommentInput` to the bottom of the detail panel, not anything inside `CommentInput`.
- **Considering hiding the FAB on the issue page.** Rejected: the FAB is the global entry point to floating chat (`packages/views/chat/floating-chat.tsx:20`, mounted once in the dashboard layout at `apps/web/app/[workspaceSlug]/(dashboard)/layout.tsx:18`). Hiding it removes a global affordance to paper over a fork-introduced layout bug.

## Solution

The conflict is between an upstream global component (the FAB) and a fork-local customization (the pinned comment input). Move the fork side, not the upstream side. The pinned comment container in `packages/views/issues/components/issue-detail.tsx:2712` gains a mobile-only right padding that reserves the FAB's corner:

```tsx
// before
<div className="shrink-0 border-t bg-background px-8 py-3">

// after — pl-8 pr-14 on mobile reserves the bottom-right for the FAB
// (its 48px corner: right-2 8px + size-10 40px); sm:pr-8 restores the
// symmetric 32px padding once the viewport is wide enough to coexist.
<div className="shrink-0 border-t bg-background pl-8 pr-14 py-3 sm:pr-8">
```

Arithmetic: the FAB occupies the rightmost 48px of the viewport (`right-2` 8px + `size-10` 40px). With `pr-14` (56px) the submit button's right edge moves to viewport − 62px (`pr-14` 56 + the `right-1.5` 6px of the button group at `packages/views/issues/components/comment-input.tsx:308`), leaving a 14px gap from the FAB's left edge at viewport − 48px. `sm:pr-8` (≥640px) restores the symmetric 32px padding, since the two elements no longer compete for the corner at desktop widths.

Deploy: this is a frontend-only change — rebuild the standalone frontend and restart only the frontend job (backend, DB, and daemon are untouched).

## Why This Works

`upstream`'s `ChatFab` is designed assuming the page's bottom-right corner is empty — it is a global floating affordance mounted once per dashboard layout. The fork's pinned-comment customization (`issue-detail.tsx:2712`, the `shrink-0 border-t ... px-8 py-3` container) violates that assumption: upstream's `CommentInput` lives inside the scrolling timeline (not pinned), so upstream never has a bottom input competing with the FAB; the fork parks the submit button in the same corner. On wide viewports the comment box is offset enough that they don't collide; on a phone they overlap exactly.

Fixing the fork side (the pin-comment container) rather than the upstream side (the FAB) keeps the blast radius minimal: the FAB is shared by every dashboard page, the pin-comment container exists only on the issue detail page. This matches `CLAUDE.md`'s "prefer existing patterns, avoid broad refactors" — a one-line responsive padding change versus teaching the global FAB about page-specific bottom inputs.

## Prevention

- **When a fork customization parks an element in a corner that upstream reserves for a global floating component, give the fork side a responsive margin/padding on the narrow breakpoint.** Do not move the global component — its positioning contract is page-independent, and changing it affects every page.
- **Do not keyword-search for the submit control itself.** Multica's submit affordance is a shared `<SubmitButton>` component; locate it via the container that positions it, not by the word "send".
- **Test fork customizations that change page-level layout (sticky/pinned bars, bottom inputs) on a real phone-width viewport**, not just desktop. `z-index` / `absolute` overlap conflicts are viewport-dependent and invisible on wide screens; they only surface when a user reports them from a phone.
- The fix lives at `issue-detail.tsx:2712` (commit `748059058`); the pin-comment container is also flagged in `docs/customizations.md` as a fork hot file, so this conflict should be re-checked after any upstream change to `ChatFab`'s positioning or size.

## Related Issues

- `docs/customizations.md` — "Pin issue comment input to bottom of detail panel" entry (fork hot file, single recurring-conflict file).
- `docs/solutions/workflow-issues/safe-upstream-upgrade-with-local-customizations.md` — the upgrade workflow where fork customizations are audited against upstream changes each release.
