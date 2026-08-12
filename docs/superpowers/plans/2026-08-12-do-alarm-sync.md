# Durable Object + Alarm-Chain Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the stateless chunked-cron sync with a `SyncCoordinator` Durable Object that self-schedules an alarm chain — one Jira page per tick — so the full-sprint sync fits Cloudflare **Free plan** limits (10ms CPU/invocation, 50 subrequests, 5 cron triggers). Verified Free-plan facts: DO **alarms** available on Free (15-min wall-clock per alarm invocation), DO **SQLite storage** included on Free.

**Architecture:** Cron `*/5` and manual `GET /sync` both wake the DO (`kick`); the DO's `alarm()` does one unit of work per tick (1 Jira page → 1 batched sheet write → save cursor → reschedule +3s or clear state). OAuth token cached in DO storage (sign JWT ≤1/hr). New `GET /sync/status` polls progress.

**Tech Stack:** Cloudflare Workers, Hono (`@hono/zod-openapi`), Durable Objects (SQLite), Zod, vitest.

## Global Constraints

- No new npm dependencies.
- Working dir for all commands: `src/workers/`.
- Follow AGENTS.md conventions: TypeScript strict, 2-space indent, no comments unless they encode intent, reuse existing helpers (`getConfig`, `withToken`, `getOrCreateSprintSheet`, `pickSprint`, `extractField`).
- `/sync` and `/sync/status` stay **unauthenticated** (user's explicit choice).
- Tests and mocks follow the existing patterns in `tests/webhook.test.ts`, `tests/sheetWriter.test.ts`, `tests/mock-env.ts`.
- Verify commands: `npm test` (vitest) and `npm run typecheck`.

---

### Task 1: `jira.ts` — one page per call

**Files:** `src/workers/jira.ts`, `src/workers/tests/jira.test.ts`

- [ ] **Step 1:** Add `searchIssuesPage(jql, subdomain, email, apiToken, nextPageToken?)` returning `{ issues, nextPageToken?, isLast }` — single request, no loop. Remove `searchIssues` (its only caller, the chunked `syncSprint`, is deleted in Task 5).
- [ ] **Step 2:** Rewrite `jira.test.ts` for the page function: URL + Basic auth, `nextPageToken` on later pages, `isLast`, non-OK throw.

### Task 2: `sheetWriter.ts` — batched page write + stored OAuth token

**Files:** `src/workers/sheetWriter.ts`, `src/workers/tests/sheetWriter.test.ts`

- [ ] **Step 1:** `readKeyColumns` — remove the `.catch(() => ({ valueRanges: [] }))` silent fallback (a failed key read must fail the tick, not duplicate up to 100 rows).
- [ ] **Step 2:** Add `withStoredToken(storage, email, privateKey, fn)` — read `oauth_token` from `DurableObjectStorage`; if fresh call `fn(token)`, else `getAccessToken` + store `{ token, expiresAt: now + 3600_000 - 60_000 }`.
- [ ] **Step 3:** Add `syncSprintPage(spreadsheetId, issues, token, config)` returning `{ rowsWritten }`:
  - 1 metadata `getSheets`, group issues by `pickSprint` (skip no-sprint).
  - Per group: `getOrCreateSprintSheet`, 1 key-column `batchGet` across all sprint tabs, compute rows (existing keys updated in place, new keys appended after last row, in-page dup keys deduped), collect stale rows to delete from other tabs.
  - Write: 1 `values:batchUpdate` (`valueInputOption: USER_ENTERED`) with all ranges; 1 `batchUpdate` with deduped `deleteDimension` requests.
- [ ] **Step 4:** Add tests: one `values:batchUpdate` containing all ranges; deduped deletes in one `batchUpdate`; in-place update of an existing key; append of new keys; no-sprint skip; `withStoredToken` fresh-cache hit and expired refresh (mock `../auth`).

### Task 3: `syncCoordinator.ts` — the Durable Object

**Files:** `src/workers/syncCoordinator.ts` (new), `src/workers/tests/syncCoordinator.test.ts` (new)

- [ ] **Step 1:** `SyncCoordinator extends DurableObject<Env>` with `ctx.storage` state under key `sync`:
  `{ sprintId, nextPageToken?, pagesDone, rowsWritten, startedAt, updatedAt, failures }`.
- [ ] **Step 2:** RPC `kick(sprintId?) → 'started' | 'in_progress'` — skip if state fresh (`updatedAt` < 4 min old), else write fresh state + `setAlarm(now + 1s)`.
- [ ] **Step 3:** RPC `getStatus() → SyncStatus` (`running`, `sprintId?`, `pagesDone?`, `rowsWritten?`, `startedAt?`, `updatedAt?`).
- [ ] **Step 4:** `alarm()` — load state (none ⇒ return); `searchIssuesPage` (1 fetch) → `withStoredToken` → `syncSprintPage`; save cursor/progress + `setAlarm(now + 3s)` if more pages, else delete state + completion log; on error keep cursor, `failures++`, `setAlarm(now + min(5s · 2^failures, 5min))`, `Sentry.captureException`.
- [ ] **Step 5:** Minimal `fetch` handler: `GET /status`, `POST /kick?sprintId=`, else 404.
- [ ] **Step 6:** Tests with a fake `DurableObjectState` (in-memory map + alarm) and mocked `../jira`, `../sheetWriter`, `@sentry/cloudflare`: kick idle/in-progress/stale; alarm advance/last-page/error-backoff; `getStatus`; fetch routing.

### Task 4: wire up config, routes, wrangler

**Files:** `src/workers/config.ts`, `src/workers/index.ts`, `src/workers/schema.ts`, `src/workers/wrangler.jsonc`, `src/workers/.dev.vars.example`, `src/workers/tests/mock-env.ts`, `src/workers/tests/webhook.test.ts`

- [ ] **Step 1:** `config.ts` — add `SYNC_COORDINATOR: DurableObjectNamespace<SyncCoordinator>` to `Env` (type-only import of `SyncCoordinator`; circular type import is erased).
- [ ] **Step 2:** `index.ts` — delete chunked `syncSprint`, `CHUNK_SIZE`, `TICK_MS`, `DEFAULT_SYNC_DELAY_MS`, `sleep`, `SyncStats`, `searchIssues` import. Add `coordinator(env)` helper (`get(idFromName('global'))`).
  - `scheduled`: `await coordinator(env).kick()`.
  - `GET /sync`: `status = await coordinator(env).kick(id)` → `c.json({ sprintId: id, status })`; 500 on throw.
  - New `GET /sync/status` route → `c.json(await coordinator(env).getStatus())`.
  - Update route summaries/descriptions; `schema.ts` unchanged (`SyncQuerySchema` already optional numeric).
- [ ] **Step 3:** `wrangler.jsonc` — cron `*/15 * * * *` → `*/5 * * * *`; add `durable_objects.bindings` (`SYNC_COORDINATOR` / `SyncCoordinator`) and `migrations` (`{ "tag": "v1", "new_sqlite_classes": ["SyncCoordinator"] }`).
- [ ] **Step 4:** `.dev.vars.example` — drop the `SYNC_DELAY_MS` comment (no longer used). `mock-env.ts` — remove `SYNC_DELAY_MS`, add `makeCoordinatorNamespace({ kick?, getStatus? })` helper + default on `testEnv`.
- [ ] **Step 5:** `webhook.test.ts` — drop `../jira` mock; scheduled test asserts `kick()` called; `/sync` tests assert `{ sprintId, status }` for started/in_progress/400/500; new `/sync/status` tests (idle + running). Remove the old chunk-rotation and pacing tests.

### Task 5: docs

- [ ] **Step 1:** `AGENTS.md` — update Key flow / Gotchas: chunked cron → DO alarm chain; `TICK_MS` note → `PAGE_ALARM_MS`/`STALE_MS`; add DO binding + migration to deployment notes.
- [ ] **Step 2:** `README.md` — add `syncCoordinator.ts` to the layout table and a line about the sync engine.

### Task 6: verify

- [ ] **Step 1:** `cd src/workers && npm run typecheck && npm test` — all green.
- [ ] **Step 2:** Commit (message follows repo style, e.g. `feat: DO-alarm-chain sprint sync (Free-plan-safe)`).
