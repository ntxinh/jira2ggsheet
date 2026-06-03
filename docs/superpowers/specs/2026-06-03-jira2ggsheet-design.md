# Jira → Google Sheet Sync — Design

**Date:** 2026-06-03
**Status:** Approved

## Goal

Replicate Jira issue data into a Google Sheet in near real-time. Every issue change in Jira (create, update, transition, delete) is reflected in the sheet within seconds, at zero hosting cost.

## Decisions

| Decision | Choice |
|---|---|
| Jira | Cloud (`myorg.atlassian.net`), admin webhook access confirmed |
| Hosting | Google Apps Script web app (free, bound to the sheet) |
| Sync mechanism | Jira webhook (push) → Apps Script `doPost` |
| Scope | One Jira project; no initial backfill — rows are created on first event for an issue (upsert) |
| Delete handling | Configurable `DELETE_MODE`: `'delete'` removes the row (default), `'mark'` writes `Deleted` to the status column |
| Sprint | One row per issue; an issue belongs to one sprint. Sprint cell holds the sprint ID |
| Assignee format | Display name |
| Column mapping | Dynamic config: column letter → field extractor name |

## Architecture

```
Jira Cloud ──webhook POST──► Apps Script Web App (doPost)
                                    │
                              verify secret token (URL param)
                                    │
                              parse event type
                       (created / updated / deleted)
                                    │
                              extract fields via CONFIG mapping
                                    │
                              upsert row in Google Sheet
                              (find by Issue Key column, else append)
```

The webhook payload contains the full issue JSON, so the script never calls the Jira API and stores no Jira credentials.

### Components

Apps Script project bound to the target spreadsheet, one file per component:

| File | Purpose |
|---|---|
| `Config.gs` | All configuration: column→field mapping, sheet tab name, custom field IDs, secret token, delete mode |
| `WebApp.gs` | `doPost(e)` — auth check, project filter, route by webhook event, always respond 200 quickly |
| `FieldExtractor.gs` | Extract values from the webhook JSON per mapping (nested paths, sprint array, ADF description→plain text, date formatting) |
| `SheetWriter.gs` | Upsert: locate row by issue key, update mapped cells only, append if missing, delete/mark on delete event |
| `Test.gs` | Sample payloads + assertions, runnable from the editor |

## Configuration (`Config.gs`)

```javascript
const CONFIG = {
  SHEET_NAME: 'Issues',          // tab name
  KEY_COLUMN: 'C',               // column holding issue key — used for row lookup
  HEADER_ROWS: 1,                // rows to skip at top
  DELETE_MODE: 'delete',         // 'delete' = remove row | 'mark' = write "Deleted" to status column
  PROJECT_KEY: 'ABC',            // ignore events from other projects (safety filter)
  SECRET_TOKEN: 'long-random-string',  // must match ?token= in webhook URL

  // column letter → field extractor name
  COLUMN_MAP: {
    A: 'sprintId',
    C: 'issueKey',
    D: 'issueType',
    E: 'priority',
    F: 'description',
    G: 'status',
    L: 'createdDate',
    P: 'storyPoints',
    U: 'assignee',
  },

  // Jira custom field IDs (differ per site — discovery guide in SETUP.md)
  CUSTOM_FIELDS: {
    sprint: 'customfield_10020',
    storyPoints: 'customfield_10016',
  },

  DATE_FORMAT: 'yyyy-MM-dd HH:mm',  // for createdDate
  TIMEZONE: 'Asia/Ho_Chi_Minh',
};
```

The map values are extractor names rather than raw JSON paths because several fields need logic a path cannot express: the sprint field is an array, the description arrives as ADF (Atlassian Document Format), dates need formatting. Adding a new column later means adding one map entry and, if the field is new, one small extractor function.

Columns not present in `COLUMN_MAP` (B, H–K, M–O, Q–T, …) are never touched; manual data there is safe.

## Webhook Handling

One webhook registered in Jira, JQL-filtered to `project = ABC`, subscribed to:

| Jira event | Action |
|---|---|
| `jira:issue_created` | upsert (append) |
| `jira:issue_updated` | upsert (update; append if the row does not exist yet) |
| `jira:issue_deleted` | per `DELETE_MODE` |

`doPost(e)` flow:

1. Check `e.parameter.token === CONFIG.SECRET_TOKEN`; on mismatch log, return an error text response, stop.
2. Parse JSON body → `webhookEvent`, `issue`.
3. Project filter: if `issue.fields.project.key !== CONFIG.PROJECT_KEY`, ignore.
4. Route to the matching handler. Always return 200 quickly — Jira retries failed deliveries, and we do not want a retry storm caused by our own bug.

### Field extractors

All read from `issue.fields` unless noted:

| Extractor | Logic |
|---|---|
| `issueKey` | `issue.key` |
| `issueType` | `fields.issuetype.name` |
| `priority` | `fields.priority?.name`, empty string if null |
| `status` | `fields.status.name` |
| `assignee` | `fields.assignee?.displayName`, empty string if unassigned |
| `createdDate` | `fields.created` formatted per `DATE_FORMAT` / `TIMEZONE` |
| `storyPoints` | `fields[CUSTOM_FIELDS.storyPoints]`, empty string if null |
| `sprintId` | `fields[CUSTOM_FIELDS.sprint]` is an array → pick the active sprint, else the last entry → its `id` |
| `description` | ADF object → walk nodes, join text content with newlines. If the value is already a plain string (legacy format), pass through |

### Concurrency

Two webhooks can arrive near-simultaneously (e.g. bulk edit). The upsert is wrapped in `LockService.getScriptLock()` with a 30-second wait to prevent duplicate appended rows.

## Sheet Write (`SheetWriter.gs`)

1. Read the key column (`C`) values once via `getRange().getValues()`; find the row index of the issue key.
2. Found → write only the mapped cells (one `setValue` per entry; ~9 cells, fast enough).
3. Not found → append at the next empty row after the last data row.
4. Delete event → `DELETE_MODE === 'delete'`: `deleteRow(row)`; `'mark'`: write `Deleted` to the status column (`G`). Row not found → no-op.

## Error Handling

| Failure | Behavior |
|---|---|
| Bad token | Log + reject; sheet untouched |
| Malformed JSON / missing `issue` | Log payload snippet, return 200 (avoid Jira retries) |
| Extractor throws (unexpected payload shape) | Catch per field → write empty string for that cell, log the field name; rest of the row still written |
| Lock timeout | Log, return 200 — event lost (acceptable v1; a daily polling sweep is a future option) |
| Sheet/tab missing | Log loud error, return 200 |

Logging via `console.log` → visible in the Apps Script executions panel and Cloud Logging. No external log infrastructure.

## Testing

- `Test.gs` holds sample webhook payloads (created / updated / deleted; edge cases: no assignee, no sprint, ADF description) with assertions on extractor outputs. Run `testAll()` from the editor.
- `doPost` can be exercised via `curl` with a sample payload and the token.
- Manual end-to-end: deploy → register webhook → create a test issue in Jira → verify the row appears; update assignee → verify the cell changes.

## Setup Guide (ships as `SETUP.md`)

1. **Create sheet + Apps Script project** — Extensions → Apps Script (bound script), paste the five files.
2. **Find custom field IDs** — open `https://myorg.atlassian.net/rest/api/2/issue/ABC-1?expand=names`, search for "Sprint" / "Story point" in the `names` block, copy the `customfield_xxxxx` IDs into `CONFIG.CUSTOM_FIELDS`.
3. **Set config** — project key, tab name, generate a long random secret token.
4. **Deploy web app** — Deploy → New deployment → Web app → Execute as: *Me*, Access: *Anyone* → copy the URL. After code edits, update the existing deployment (Manage deployments → edit → new version) to keep the same URL.
5. **Register Jira webhook** — `https://myorg.atlassian.net/plugins/servlet/webhooks` → Create:
   - URL: `https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec?token=<SECRET>`
   - JQL filter: `project = ABC`
   - Events: Issue created, Issue updated, Issue deleted
6. **Test** — create an issue → row appears within seconds; update assignee → cell changes; check the Apps Script "Executions" panel for logs.
7. **Troubleshooting** — token mismatch, wrong custom field ID, reading errors in the Executions panel. Note: Apps Script responds with a 302 redirect to an HTML page; Jira treats this as a successful delivery.

## Out of Scope (v1)

- Initial backfill of existing issues
- Polling sweep to catch missed webhook deliveries
- Multiple Jira projects or multiple sheets
- Two-way sync (sheet edits back to Jira)
