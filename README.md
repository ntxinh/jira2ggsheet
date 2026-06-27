# jira2ggsheet

Sync Jira Cloud issues to a Google Sheet in near real-time. Two runtimes:

- **Google Apps Script** (legacy backup) — free, zero servers
- **Cloudflare Worker** (recommended) — faster, typed, deploy via `wrangler`

**How it works:** a Jira webhook fires on issue create/update/delete and POSTs
the issue JSON to the worker/app, which upserts a row into the issue's per-sprint
tab (`{Sprint Id}_{Sprint Name}`), cloned from a `Template` tab. Issues with no
sprint are skipped. Column ↔ field mapping is configurable.

- Design: `docs/superpowers/specs/2026-06-23-per-sprint-sheets-design.md`
- Deployment: `SETUP.md`

## Layout

| Path | What |
|---|---|
| `src/gas/` | **Google Apps Script** (legacy backup) |
| `src/gas/Config.js` | All settings: spreadsheet ID, column map, custom field IDs, secret token, delete mode, template tab name |
| `src/gas/FieldExtractor.js` | Webhook JSON → cell values (sprint arrays, dates) |
| `src/gas/SheetWriter.js` | Row upsert / delete (only file touching SpreadsheetApp) |
| `src/gas/WebApp.js` | `doPost` entry point: token auth, project filter, event routing |
| `src/gas/Test.js` | Tests runnable inside the Apps Script editor |
| `src/gas/tests/` | Node test suite for GAS logic (zero dependencies) |
| `src/workers/` | **Cloudflare Worker** (recommended) |
| `src/workers/index.ts` | `fetch` handler: token auth, webhook routing, background processing |
| `src/workers/config.ts` | Typed config from Worker env vars |
| `src/workers/auth.ts` | Google service account JWT (Web Crypto API, zero deps) |
| `src/workers/fieldExtractor.ts` | Port of `FieldExtractor.js` |
| `src/workers/sheetWriter.ts` | Google Sheets REST API v4 (replaces `SpreadsheetApp`) |

## Development — GAS (legacy)

```bash
node src/gas/tests/run.js        # Node test suite
# Or paste src/gas/*.js into the Apps Script editor and run testAll()
```

## Development — Cloudflare Worker

```bash
cd src/workers
npm run dev                     # wrangler dev (local dev server)
npm run typecheck               # tsc --noEmit
npm run deploy                  # wrangler deploy
```
