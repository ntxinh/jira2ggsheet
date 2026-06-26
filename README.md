# jira2ggsheet

Sync Jira Cloud issues to a Google Sheet in near real-time. Free: runs entirely
on Google Apps Script — no servers.

**How it works:** a Jira webhook fires on issue create/update/delete and POSTs
the issue JSON to an Apps Script web app, which upserts a row into the
issue's per-sprint tab (`{Sprint Id}_{Sprint Name}`), cloned from a `Template`
tab. Issues with no sprint are skipped. Column ↔ field mapping is configurable
(`src/Config.js`).

- Design: `docs/superpowers/specs/2026-06-23-per-sprint-sheets-design.md`
- Deployment guide: `SETUP.md`

## Layout

| Path | What |
|---|---|
| `src/Config.js` | All settings: spreadsheet ID (optional), column map, custom field IDs, secret token, delete mode, template tab name (`TEMPLATE_SHEET`) |
| `src/FieldExtractor.js` | Webhook JSON → cell values (sprint arrays, dates) |
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
