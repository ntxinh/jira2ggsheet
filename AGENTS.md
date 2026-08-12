# AGENTS.md

Guidance for AI agents working in this repository.

## Overview

Syncs Jira issues into a Google Spreadsheet, one tab per sprint (`<sprintId>_<name>`). Two independent implementations live here:

- **`src/workers/`** — Cloudflare Worker (TypeScript, Hono, vitest, wrangler). The active codebase. Receives Jira webhooks (`POST /`) and a manual sprint sync (`GET /sync?sprintId=`); also runs on a cron schedule.
- **`src/gas/`** — Legacy Google Apps Script (plain JS, no framework). Kept as reference; do not add features to it unless asked.

## Commands

All worker commands run in `src/workers/` (also exposed via the root `Makefile`):

- `npm test` — vitest (`tests/`)
- `npm run typecheck` — `tsc --noEmit`
- `npm run dev` — `wrangler dev` (reads `src/workers/.dev.vars`)
- `npm run deploy` — `wrangler deploy --keep-vars`
- `node src/gas/tests/run.js` — GAS test harness (plain Node, asserts only)

CI (`.github/workflows/deploy.yml`): `npm ci` → `typecheck` → `test` on push/PR touching `src/workers/**`.

## Key flow

`searchIssues(jql)` (`src/workers/jira.ts`) → for each issue `upsertIssue(...)` (`src/workers/sheetWriter.ts`):

1. `pickSprint` picks the **active** sprint from the issue's sprint field, else the last one (fieldExtractor.ts).
2. `getOrCreateSprintSheet` finds/renames/duplicates the `<sprintId>_*` tab from the Template tab.
3. The issue is **deleted from every other sprint tab**, then upserted into its own tab (row found by `KEY_COLUMN`, else appended).

Sprint sync is **chunked**: the 15-min cron (`*/15 * * * *`) processes one rotating 50-issue slice per tick, paced `SYNC_DELAY_MS` (~4s, default 4000) between upserts so Sheets' 60 read + 60 write req/min per-user quota is respected. `TICK_MS` in `index.ts` must match the cron interval.

## Gotchas

- **Jira JQL endpoint pagination**: `/rest/api/3/search/jql` returns **no `total`** and ignores `startAt`. Paginate via `nextPageToken`/`isLast`. (A past bug truncated results to the first 100 issues.)
- **`pickSprint` is approximate**: an issue in two active sprints can land on the "wrong" tab — accepted trade-off, commented in `index.ts`.
- **Secrets**: `src/workers/.dev.vars` holds real production credentials (Jira token, Google service-account key, Sentry DSN). Never log or commit them; `.dev.vars.example` is the template.
- **Config** (`config.ts` + `.dev.vars`): `COLUMN_MAP_JSON` drives which columns map to which `EXTRACTORS` (fieldExtractor.ts); `CUSTOM_FIELDS_SPRINT`/`_STORY_POINTS` are Jira custom field IDs. `HEADER_ROWS=3`, `KEY_COLUMN=B` in prod.

## Conventions

- TypeScript strict; `@cloudflare/workers-types`, ES2022, no Node types in worker code.
- 2-space indent, LF, UTF-8 (see `.editorconfig`).
- No comments unless they encode intent (a `ponytail:` comment marks a deliberate shortcut).
- Match existing style; reuse existing helpers (`withToken`, `getConfig`, `extractField`) rather than re-implementing.
