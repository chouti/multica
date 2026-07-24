---
title: "Admin list stale after mutation — invalidate no-op from query-key shape mismatch"
date: 2026-07-24
category: ui-bugs
module: admin
problem_type: ui_bug
component: admin-user-management
symptoms:
  - "Admin users list does not refresh after a rename, role change, workspace add/remove, or invitation create"
  - "Rename toasts 'success' but the row still shows the old name until a manual refetch (search keystroke, window refocus, navigation)"
  - "Latent: invisible while the affected mutation hook was dead code — surfaces only once a page starts using it"
root_cause: query_key_shape_mismatch
resolution_type: code_fix
severity: medium
tags:
  - react-query
  - cache
  - invalidation
  - partialMatchKey
  - query-keys
  - admin
  - mutation
related_components:
  - packages/core/admin/mutations.ts
  - packages/core/admin/queries.ts
---

# Admin list stale after mutation — invalidate no-op from query-key shape mismatch

## Problem

Every admin mutation hook (`useUpdateUserName`, `useAdminCreateInvitations`,
`useAdminAddUserToWorkspaces`, `useAdminRemoveUserFromWorkspace`,
`useAdminUpdateUserRole`) invalidated with the **no-arg** form of the query-key
factory:

```ts
// packages/core/admin/mutations.ts (before)
onSuccess: () => {
  qc.invalidateQueries({ queryKey: adminKeys.users() });
}
```

`adminKeys.users()` with no arguments returns
`["admin", "users", { search: undefined, limit: undefined, offset: undefined }]`.
But the live query is created with real arguments
(`userListOptions({ search })`, where `search` is a `useState("")` — always a
string):

```ts
// packages/core/admin/queries.ts
users: (search?, limit?, offset?) => ["admin", "users", { search, limit, offset }] as const
// live cache key: ["admin", "users", { search: "", limit: undefined, offset: undefined }]
```

The `onSuccess` invalidation **never matched** the live query, so the users list
never refetched after any admin mutation. The backend write succeeded; the UI
just kept showing stale rows.

## Symptoms

- After renaming a user in `/admin`, the success toast fires but the row keeps
  showing the old name. It corrects itself only on the next refetch (typing in
  the search box, refocusing the window, or navigating away and back).
- The same staleness affects the other four admin mutations (create invitation,
  add/remove workspace, update role) — they all shared the identical broken
  invalidate.
- The bug was latent: `useUpdateUserName` existed in `mutations.ts` and was even
  exported, but no page used it, so the broken invalidation was never exercised.
  It became visible only when the super-admin user-management page was wired to
  it (the rename fix), which is when someone finally expected the list to
  refresh.

## What Didn't Work

A reasonable reviewer assumed the no-arg call acts as a wildcard — "if I pass no
params, it should match any users query regardless of its search/limit/offset."
During plan review this was even asserted as correct ("`adminKeys.users()` uses
undefined everywhere so `partialDeepEqual` treats it as a wildcard —
invalidation works even with an active search term"). That assumption is wrong,
and it is the trap.

The sibling factories `adminKeys.invitations()` and `adminKeys.workspaces()`
return plain two-element arrays (`["admin", "invitations"]`,
`["admin", "workspaces"]`) with no params object, so their invalidations *did*
work. That accidental correctness made the broken `users()` invalidate look
innocent by analogy — the three factories look identical at the call site but
behave differently because only `users()` takes arguments.

## Solution

Invalidate by a **prefix array** instead of the no-arg factory call:

```ts
// packages/core/admin/mutations.ts (after)
onSuccess: () => {
  // Invalidate by prefix, not adminKeys.users(): the no-arg form embeds
  // {search:undefined,...}, which partialMatchKey rejects vs the live query's
  // {search:'',...} (typeof mismatch), so the users list would never refresh.
  // The prefix hits every admin users query regardless of its search/limit/offset.
  qc.invalidateQueries({ queryKey: ["admin", "users"] });
}
```

Applied to all five affected mutation hooks. `useAdminRevokeInvitation` was
unaffected — it invalidates `adminKeys.invitations()`, which is already a prefix.

## Why This Works

`invalidateQueries` defaults to `exact: false`, which matches queries via
`partialMatchKey`. In `@tanstack/query-core@5.96.2`
(`src/utils.ts`, `partialMatchKey`):

```ts
export function partialMatchKey(a: any, b: any): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;          // <-- the trap
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    return Object.keys(b).every((key) => partialMatchKey(a[key], b[key]));
  }
  return false;
}
```

`matchQuery` calls `partialMatchKey(query.queryKey, queryKey)` — i.e.
`partialMatchKey(cacheKey, filterKey)` — so the object branch iterates the
**filter's** keys. For the `search` field:

- filter value: `undefined` (from the no-arg factory)
- cache value: `""` (from `useState("")`)

`partialMatchKey("", undefined)` hits `typeof "" !== typeof undefined`
(`"string" !== "undefined"`) and returns **false**. One failed field fails the
whole object, so the query is not matched and not invalidated.

A plain prefix array sidesteps this entirely: `partialMatchKey` walks the
filter's array indices, and when the filter is shorter than the cache key
(`["admin","users"]` vs `["admin","users",{...}]`), every filter element matches
and the cache key's extra tail is ignored — a true prefix match. No object field
comparison ever runs, so `undefined`-vs-`""` never comes up.

## Prevention

**Never invalidate a parameterized query with the no-arg form of its key
factory.** The no-arg call embeds `{field: undefined, ...}`, which
`partialMatchKey` rejects against any live query whose field is a concrete value
of a different type (`""`, `0`, `false`). "No argument" is not "wildcard" — it
is "assert this field is `undefined`," and almost no real query key has every
optional field literally `undefined`.

Two safe patterns:

1. **Invalidate by prefix** — pass the shared leading path only:
   `qc.invalidateQueries({ queryKey: ["admin", "users"] })`. This matches every
   query under that prefix regardless of its params object.
2. **Expose a prefix constant** from the key factory for clarity:
   `usersRoot: ["admin", "users"] as const`, then invalidate with that. Keeps the
   magic string out of call sites.

Code review should flag any `invalidateQueries({ queryKey: someKeys.list() })`
(no-arg call on a factory that takes params) — it is almost always a no-op.

A useful grep for review:

```bash
# invalidateQueries / setQueryData keyed by a no-arg factory call whose
# factory also accepts params — these are suspect invalidations
rg "invalidateQueries\(\{ queryKey: \w+\.\w+\(\) \}\)" --type ts
```

Also: a query-key factory that takes params (`users(search, limit, offset)`)
should not be visually grouped with factories that take none
(`invitations()`, `workspaces()`) without a comment — they look interchangeable
at the call site but match very differently under `partialMatchKey`.

## Related Issues

- `docs/solutions/ui-bugs/skill-autocomplete-cold-cache.md` — same layer
  (TanStack Query cache), opposite failure mode: a cache-only *read* that was
  never primed, vs. here a cache *invalidate* that never matched.

## Related Artifacts

- Plan: `docs/plans/2026-07-23-001-fix-admin-user-rename-plan.md`
- Fix commit: `ee6d1e031` — `fix(admin): invalidate users list by prefix so admin
  mutations refresh it`
- Surfaced by: `ce-code-review` correctness reviewer (the rename fix activated
  the previously-dead `useUpdateUserName`, making the latent no-op visible).
  Confirmed by reading `@tanstack/query-core@5.96.2` `src/utils.ts`
  `partialMatchKey`.
