# Per-Sprint Sheets

**Date:** 2026-06-23
**Status:** Approved

## Goal

Route each Jira issue to its own per-sprint tab instead of a single shared
`Issues` sheet. Tab name format: `{Sprint Id}_{Sprint Name}` (e.g. `42_Sprint 5`).

## Decisions

| Topic | Decision |
|---|---|
| Issue with no sprint | **Skip** — do not write a row until the issue has a sprint. |
| Issue moves sprint (e.g. Sprint 5 → 6) | **Remove from old tab** — scan all sprint tabs, delete stale row, write to new tab. No duplicates. |
| New sprint tab header / formatting | **Copy from a template tab** (`CONFIG.TEMPLATE_SHEET`, default `Template`). |
| Locating a sprint's tab | **Match by id prefix** (`{id}_`). Rename-safe: a Jira rename renames the same tab; one tab per sprint id always. |
| Sprint name source | Jira webhook sprint field carries `name`. |

## Architecture

Approach: **sheet router layer**. Keep `SheetWriter.js` as the only file
touching `SpreadsheetApp`; add routing helpers there. Extend `FieldExtractor.js`
to extract the full sprint object. Matches existing one-purpose-per-file style.

### 1. Sprint extraction (`FieldExtractor.js`)

- `parseSprint_(entry)` — extend to also read `name` (object branch: `entry.name`;
  string branch: `name=...` regex). Returns `{ id, name, state }`.
- `pickSprint(sprintField)` — new. Same selection logic as `pickSprintId`
  (active sprint else last). Returns `{ id, name, state }` or `null` when no
  resolvable sprint.
- `pickSprintId` — kept as a thin wrapper over `pickSprint` so the existing
  `sprintId` column extractor still works.

### 2. Sheet name + router (`SheetWriter.js`)

- `sprintSheetName_({ id, name })` — sanitize name: replace any of `[ ] : \ / ? *`
  with `-`, build `{id}_{name}`, truncate to 100 chars (Google Sheets tab limit).
  Empty name → `{id}_`.
- `getSprintSheet_(sprintInfo)`:
  1. Scan all tabs for one whose name starts with `{id}_` (skip the template tab).
  2. Found → if full name differs (rename), `sheet.setName(newName)`; return it.
  3. Not found → clone template: `template.copyTo(ss).setName(newName)`; return it.
- New config: `TEMPLATE_SHEET: 'Template'`. `SHEET_NAME` retired (kept only as the
  template fallback name if referenced).

### 3. Upsert / delete with cross-tab purge (`SheetWriter.js`)

- `isSprintTab_(sheet)` — name matches `^\d+_`, and is not the template tab.
- `removeKeyFromAllSprintTabs_(issueKey, exceptSheet)` — iterate sprint tabs,
  find+delete the row by key. Used to clear stale rows on sprint move.
- `upsertIssue(issue)`:
  1. `sprint = pickSprint(...)`; if `null` → log + return (skip).
  2. `sheet = getSprintSheet_(sprint)`.
  3. `removeKeyFromAllSprintTabs_(issue.key, sheet)`.
  4. Upsert row in `sheet` (existing find-by-key + column-map write loop).
- `deleteIssue(issue)`: scan all sprint tabs for the key.
  `DELETE_MODE === 'delete'` → `deleteRow`; `mark` → set status column to
  `Deleted` in whichever tab holds the row.

### 4. Data flow

```
webhook issue JSON
  → pickSprint            (null? → skip)
  → sprintSheetName_      ({id}_{name}, sanitized)
  → getSprintSheet_       (find by id prefix | rename | clone template)
  → removeKeyFromAllSprintTabs_  (purge stale rows in other tabs)
  → upsert row in target tab
```

## Error handling

- No resolvable sprint → log + skip (no throw; webhook still returns OK).
- Template tab missing → `getSprintSheet_` throws a clear error
  (`Template tab not found: <name>`); webhook surfaces failure.
- Per-field extraction errors stay isolated (existing `extractField` behavior).

## Edge cases

- Two tabs share an id prefix (shouldn't occur) → first match wins, gets renamed.
- Sprint name empty → tab `{id}_`.
- Name of only-invalid chars → dashes.
- Sprint rename in Jira → same tab renamed, rows preserved.

## Testing

Extend `tests/fakes.js` fake `SpreadsheetApp` for multi-sheet support:
`getSheets()`, `getSheetByName`, `insertSheet`/`copyTo`, `setName`.

New / updated tests:
- `pickSprint`: id+name+state, active-vs-last, empty → `null`.
- `sprintSheetName_`: sanitization + truncation + empty name.
- `getSprintSheet_`: create vs find vs rename.
- `upsertIssue`: skip on no sprint; cross-tab purge on sprint move.
- `deleteIssue`: across tabs, both delete + mark modes.
- Rewrite existing `tests/test_sheet_writer.js` for the router model.

## Out of scope

- Backfilling existing rows in the old `Issues` sheet into per-sprint tabs.
- Auto-creating the template tab (user creates it once, with header + formatting).
- Sorting / reordering tabs.
