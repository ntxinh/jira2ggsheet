# jira2ggsheet

Sync Jira Cloud issues to a Google Sheet in near real-time. Free: runs entirely
on Google Apps Script — no servers.

**How it works:** a Jira webhook fires on issue create/update/delete and POSTs
the issue JSON to an Apps Script web app, which upserts a row in the sheet
keyed by issue key. Column ↔ field mapping is configurable (`src/Config.js`).

- Design: `docs/superpowers/specs/2026-06-03-jira2ggsheet-design.md`
- Deployment guide: `SETUP.md`

## Layout

| Path | What |
|---|---|
| `src/Config.js` | All settings: column map, custom field IDs, secret token, delete mode |
| `src/FieldExtractor.js` | Webhook JSON → cell values (ADF descriptions, sprint arrays, dates) |
| `src/SheetWriter.js` | Row upsert / delete (only file touching SpreadsheetApp) |
| `src/WebApp.js` | `doPost` entry point: token auth, project filter, event routing |
| `src/Test.js` | Tests runnable inside the Apps Script editor |
| `tests/` | Node test suite (zero dependencies) |

## Development

```bash
node tests/run.js   # run the full test suite (requires Node 14+)
```

The `src/*.js` files are plain Apps Script — paste them into the editor as-is
(see `SETUP.md`).
