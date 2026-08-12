# Manual Sprint Sync Trigger

## Purpose

Let a user manually trigger the sprint sync — the logic currently bound only to
the Cloudflare scheduled handler — by hitting an HTTP endpoint and optionally
specifying which sprint to sync.

## Interface

- `GET /sync?sprintId=123`
- `sprintId` is **optional**. When absent, falls back to `env.SPRINT_ID` (same
  sprint the scheduled run uses).
- **No authentication** (explicit user choice — consistent with public
  `/docs` and `/openapi.json`; a manual sync only re-pulls Jira → Sheets and
  exposes no data).
- Response: `200` with `{ sprintId, issuesSynced, issuesFailed }`.

## Changes — `src/workers/index.ts`

1. Refactor `syncSprint` to accept the sprint id:

   ```ts
   async function syncSprint(sprintId: string, env: Env): Promise<{ issuesSynced: number; issuesFailed: number }>
   ```

   - JQL becomes `project = ${PROJECT_KEY} AND sprint = ${sprintId} ORDER BY created ASC`.
   - Return counts instead of `void`.

2. Scheduled wrapper keeps the same signature the runtime expects:

   ```ts
   scheduled: (_controller, env) => syncSprint(env.SPRINT_ID, env)
   ```

3. Add route `GET /sync` (Zod query schema `{ sprintId?: string }`):

   - `const sprintId = query.sprintId ?? env.SPRINT_ID`
   - Run the sync **inline** (not `waitUntil`) and return the summary JSON.
   - Reuse `syncSprint`; callers get the result, unlike the webhook's "ok".

## Out of scope

- Auth on `/sync`
- POST variant
- Background `waitUntil` (loses the result; switch if a sync times out)