# AGENTS.md

Guidance for AI agents working in this repository.

## Overview

Syncs Jira issues into a Google Spreadsheet, one tab per sprint (`<sprintId>_<name>`). Two independent implementations live here:

- **`src/workers/`** — Cloudflare Worker (TypeScript, Hono, vitest, wrangler). The active codebase. Receives Jira webhooks (`POST /`) for near-real-time updates and runs full-sprint syncs on a **Durable Object** (`SyncCoordinator`) kicked by a `*/5` cron and a manual `GET /sync`.
- **`src/gas/`** — Deprecated and Legacy Google Apps Script (plain JS, no framework). Kept as reference; do not add features to it unless asked.

## Commands

All worker commands run in `src/workers/` (also exposed via the root `Makefile`):

- `npm test` — vitest (`tests/`)
- `npm run typecheck` — `tsc --noEmit`
- `npm run dev` — `wrangler dev` (reads `src/workers/.dev.vars`)
- `npm run deploy` — `wrangler deploy --keep-vars`
- `node src/gas/tests/run.js` — GAS test harness (plain Node, asserts only)

CI (`.github/workflows/deploy.yml`): `npm ci` → `typecheck` → `test` on push/PR touching `src/workers/**`.

## Key flow

**Webhooks (`POST /`)** — `upsertIssue`/`deleteIssue` (`src/workers/sheetWriter.ts`): `pickSprint` picks the issue's sprint from its sprint field, `getOrCreateSprintSheet` finds/renames/duplicates the `<sprintId>_*` tab from the Template tab, row found by `KEY_COLUMN` else appended; the issue is deleted from every other sprint tab first.

**Full-sprint sync (`SyncCoordinator`, `src/workers/syncCoordinator.ts`)** — the `*/5` cron and `GET /sync` both call `kick()` on the DO; its alarm chain processes **one Jira page (100 issues) per tick**, ~3s apart, until `isLast`:

1. `searchIssuesPage(jql)` (`src/workers/jira.ts`) fetches one page using the stored `nextPageToken`.
2. `syncSprintPage(...)` (`src/workers/sheetWriter.ts`) writes the whole page in ONE `values:batchUpdate` + one `batchUpdate` per tab with stale copies (rows descending — batchUpdate applies sequentially), after 1 metadata read + 1 key-column `batchGet`.
3. The new cursor is persisted in DO storage (SQLite); more pages → `setAlarm(+3s)`, done → state cleared.
4. A failed tick keeps the cursor and retries with exponential backoff (5s·2^n, cap 5 min); a stale in-progress marker (>4 min) is restarted by the next cron kick. `GET /sync/status` polls progress.

This exists because of the Free plan's **10ms CPU per invocation** limit — one page per tick keeps JS work minimal, and the Google OAuth token is cached in DO storage (`withStoredToken`) so the RS256 JWT is signed ≤1/hr, not per tick.

## Gotchas

- **Jira JQL endpoint pagination**: `/rest/api/3/search/jql` returns **no `total`** and ignores `startAt`. Paginate via `nextPageToken`/`isLast`. (A past bug truncated results to the first 100 issues.)
- **`pickSprint` is approximate**: an issue in two active sprints can land on the "wrong" tab — accepted trade-off, commented in `sheetWriter.ts`.
- **DO in tests**: `SyncCoordinator extends DurableObject`, imported from the workerd-only module `cloudflare:workers` (the runtime rejects RPC on classes that don't). vitest resolves that module to a stub via `resolve.alias` in `vitest.config.ts` (`tests/mock-cloudflare-workers.ts`) since it doesn't exist in Node; the DO is unit-tested with a fake storage (`tests/syncCoordinator.test.ts`).
- **Secrets**: `src/workers/.dev.vars` holds real production credentials (Jira token, Google service-account key, Sentry DSN). Never log or commit them; `.dev.vars.example` is the template.
- **Sprint renames**: Jira doesn't reliably fire webhooks when a sprint is renamed, so `SyncCoordinator.kick()` (cron `*/5` + `GET /sync`) runs a best-effort `syncTabNames()` sweep first — it compares every `{sprintId}_*` tab against Jira's Agile API (`/rest/agile/1.0/sprint/{id}`) and renames mismatches in one `batchUpdate`; failures never block the page sync. Webhooks that *do* carry a renamed sprint still rename immediately via `getOrCreateSprintSheet`.
- **Config** (`config.ts` + `.dev.vars`): `COLUMN_MAP_JSON` drives which columns map to which `EXTRACTORS` (fieldExtractor.ts); `CUSTOM_FIELDS_SPRINT`/`_STORY_POINTS` are Jira custom field IDs. `JIRA_ASSIGNEE_COLUMN`/`DEV_ASSIGNEE_COLUMN`/`PRESERVE_COLUMNS` drive the DEV-assignee auto-fill: the DEV column is filled with a `Mapping!A:B` VLOOKUP formula on the Jira-assignee column while empty or still auto-filled (manual values and `PRESERVE_COLUMNS` like `J,N` are kept verbatim). `SPRINT_ID` is a **comma-separated list** (`690,691`) — `kick()` with no arg syncs each listed sprint fully, one after another (queue in `SyncState.sprintQueue`); `GET /sync?sprintId=` stays a single-ID override. `HEADER_ROWS=3`, `KEY_COLUMN=B` in prod. `SYNC_COORDINATOR` is a DO binding (`wrangler.jsonc` → `durable_objects` + `migrations`); cron `*/5` must stay in sync with the kick cadence assumptions in `syncCoordinator.ts` (`STALE_MS` < cron interval).

## Conventions

- TypeScript strict; `@cloudflare/workers-types`, ES2022, no Node types in worker code.
- 2-space indent, LF, UTF-8 (see `.editorconfig`).
- No comments unless they encode intent (a `ponytail:` comment marks a deliberate shortcut).
- Match existing style; reuse existing helpers (`withToken`, `withStoredToken`, `getConfig`, `pickSprint`, `getOrCreateSprintSheet`, `extractField`) rather than re-implementing.
