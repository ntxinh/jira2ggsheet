# Cross-Account Sheet Access

**Date:** 2026-06-26
**Status:** Approved

## Goal

Support users whose Google Sheet owner Gmail is different from the Apps Script
owner Gmail, as long as the sheet owner shares the target spreadsheet with the
script owner as an editor.

## Decision

Add an optional explicit spreadsheet target:

```javascript
SPREADSHEET_ID: '',
```

When `SPREADSHEET_ID` is set, sheet writes use
`SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID)`. When it is empty, the app keeps
the current bound-script behavior with `SpreadsheetApp.getActiveSpreadsheet()`.

This keeps existing installs working and makes standalone or cross-account
deployments predictable.

## Architecture

Keep `SheetWriter.js` as the only module that touches `SpreadsheetApp`.

Add one helper:

```javascript
function getTargetSpreadsheet_() {
  if (CONFIG.SPREADSHEET_ID) return SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  return SpreadsheetApp.getActiveSpreadsheet();
}
```

Replace each direct `SpreadsheetApp.getActiveSpreadsheet()` call in
`SheetWriter.js` with `getTargetSpreadsheet_()`.

No webhook routing change is needed. `WebApp.js` continues to validate the token,
parse Jira payloads, filter project key, and call `upsertIssue` / `deleteIssue`.

## Setup Flow

For two Gmail accounts:

1. Sheet owner opens the target Google Sheet.
2. Sheet owner shares the sheet with the Apps Script owner Gmail as **Editor**.
3. Apps Script owner sets `CONFIG.SPREADSHEET_ID` from the Google Sheet URL.
4. Apps Script owner deploys the web app with **Execute as: Me** and
   **Who has access: Anyone**.

The sheet ID is the URL segment between `/d/` and `/edit`.

## Data Flow

```
Jira webhook
  -> WebApp.doPost
  -> handleWebhook
  -> SheetWriter.upsertIssue/deleteIssue
  -> getTargetSpreadsheet_
  -> openById(SPREADSHEET_ID) or getActiveSpreadsheet()
  -> existing per-sprint sheet routing
```

## Error Handling

- Empty `SPREADSHEET_ID` preserves current behavior.
- Wrong spreadsheet ID or missing editor permission will raise the Apps Script
  `openById` error. `doPost` already catches handler errors and logs them, then
  returns `ok` to avoid Jira retry storms.
- Existing template-tab error remains unchanged:
  `Template tab not found: <name>`.

## Testing

Update the fake `SpreadsheetApp` to support both:

- `getActiveSpreadsheet()`
- `openById(id)`

Add tests that prove:

- Empty `CONFIG.SPREADSHEET_ID` uses the active spreadsheet.
- Non-empty `CONFIG.SPREADSHEET_ID` uses `openById`.
- Upsert and delete behavior still work through the selected spreadsheet.
- `CONFIG` exposes `SPREADSHEET_ID` as a string.

## Documentation

Update `README.md` and `SETUP.md`:

- Document `SPREADSHEET_ID`.
- Explain same-account bound script setup still works with an empty value.
- Explain two-account setup and required sharing permission.
- Show where to copy the ID from a Google Sheet URL.

## Out of Scope

- OAuth delegation across accounts without sharing the sheet.
- Service accounts.
- Multiple destination spreadsheets.
- Changing Jira webhook authentication.
