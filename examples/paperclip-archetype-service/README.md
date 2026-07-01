# Paperclip + Archetype Local Service

This example runs Archetype as a local HTTP agent service for Paperclip's built-in `http` adapter.

## What it does

- starts a local webhook service at `POST /heartbeat`
- Paperclip calls that webhook on a heartbeat
- the service reads the Paperclip issue, runs an Archetype persona, and patches the issue back in Paperclip

## Why this shape

This uses Archetype statelessly and leaves Paperclip in charge of:

- orchestration
- heartbeats
- task ownership
- audit trail
- issue status and comments

## Start the service

From the Archetype repo:

```bash
npm run demo:paperclip-service
```

Optional:

- set `GEMINI_API_KEY` to use Gemini
- otherwise the example uses a deterministic demo provider so the integration still works locally
- set `PAPERCLIP_API_URL` if Paperclip is not running at `http://127.0.0.1:3100`
- set `ARCHETYPE_SERVICE_SECRET` if you want Paperclip to send a shared-secret header

## Bootstrap a demo in Paperclip

Once Paperclip is running locally:

```bash
npm run demo:paperclip-bootstrap
```

That script:

1. creates a company
2. creates an HTTP-backed agent
3. creates a `backlog` issue assigned to that agent
4. sends an explicit Paperclip `wakeup` with `payload.issueId`
5. waits for the Archetype service to update the issue

The example intentionally uses a `backlog` issue plus an explicit wakeup so the local demo is deterministic and does not rely on implicit assignment wakes.

## Files

- `index.mjs` — webhook service
- `bootstrap.mjs` — local demo bootstrap against a running Paperclip API
