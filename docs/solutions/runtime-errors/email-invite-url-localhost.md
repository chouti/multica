---
title: "Invitation emails contain localhost URL instead of production domain"
date: 2026-08-03
category: runtime-errors
module: server/email
problem_type: runtime_error
component: email_processing
symptoms:
  - "Invitation email links point to localhost:3001 instead of the production domain"
  - "Invitees cannot accept invitations because the localhost URL is unreachable from their network"
root_cause: config_error
resolution_type: config_change
severity: medium
tags:
  - email
  - invitation
  - frontend-origin
  - environment-config
  - self-host
---

# Invitation emails contain localhost URL instead of production domain

## Problem

Invitation emails sent from a self-hosted Multica instance contained invite links pointing to `localhost:3001` instead of the production domain (`https://multica.aicake.com`), making it impossible for invitees to accept the invitation.

## Symptoms

- Received invitation emails showed "Accept invitation" links with `http://localhost:3001/invite/{id}` as the base URL
- Invitees clicking the link could not reach the Multica instance unless they happened to be on the same machine

## What Didn't Work

- Assuming `MULTICA_APP_URL` was the only environment variable needed for self-host URL configuration — the email service does not consult it

## Solution

Set `FRONTEND_ORIGIN` to the production domain in `.env`:

```env
# .env
FRONTEND_ORIGIN=https://multica.aicake.com
MULTICA_APP_URL=https://multica.aicake.com
```

Both variables should be set. `FRONTEND_ORIGIN` controls email URLs (and OAuth callbacks, etc.); `MULTICA_APP_URL` is used by `resolveFrontendAppURL()` in the handler layer and takes priority when both are set.

Restart the backend process after changing the environment.

## Why This Works

`SendInvitationEmail` in `server/internal/service/email.go:369` constructs the invite URL using only `FRONTEND_ORIGIN`:

```go
appURL := strings.TrimSpace(os.Getenv("FRONTEND_ORIGIN"))
if appURL == "" {
    appURL = "https://multica.ai"
}
inviteURL := fmt.Sprintf("%s/invite/%s", appURL, invitationID)
```

This is inconsistent with the rest of the backend, which prefers `MULTICA_APP_URL` first and falls back to `FRONTEND_ORIGIN` (see `resolveFrontendAppURL()` in `server/internal/handler/config.go:130-136` and `appURLFromEnv()` in `server/cmd/server/router.go:112-117`).

The default `.env.example` sets `FRONTEND_ORIGIN=http://localhost:${FRONTEND_PORT}`, which is correct for local development but must be overridden for any deployment where the frontend is not on localhost.

## Prevention

- When deploying Multica to a real domain, set **both** `FRONTEND_ORIGIN` and `MULTICA_APP_URL` in `.env` before first run
- Consider adding a startup log warning when `FRONTEND_ORIGIN` resolves to `localhost` in a non-development mode
- The inconsistency in email.go (not consulting `MULTICA_APP_URL`) could be fixed upstream to align with the handler layer's two-tier fallback pattern

## Related

- `server/internal/service/email.go:366-386` — `SendInvitationEmail` URL construction
- `server/internal/handler/config.go:130-136` — `resolveFrontendAppURL()` (the two-tier pattern)
- `server/cmd/server/router.go:112-117` — `appURLFromEnv()` (same two-tier pattern)
