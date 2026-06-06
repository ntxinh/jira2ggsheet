# Column F: Description → Ticket Title (Summary)

**Date:** 2026-06-06
**Status:** Approved

## Goal

Column F of the Issues sheet currently shows the Jira issue description
(ADF flattened to plain text). Change it to show the issue title — the Jira
`summary` field. The description extractor and its ADF helpers become dead
code and are removed.

## Background

- `src/Config.js` maps `F: 'description'` in `COLUMN_MAP`.
- `src/FieldExtractor.js` implements the `description` extractor via
  `adfToPlainText` / `walkAdfNode_` / `BLOCK_NODE_TYPES_`, which exist only
  to parse Atlassian Document Format descriptions.
- Jira webhook payloads always include `fields.summary` as a plain string,
  so no parsing is needed for the title.

## Changes

### 1. `src/Config.js`

- `COLUMN_MAP` entry `F: 'description'` → `F: 'summary'`.

### 2. `src/FieldExtractor.js`

- Add extractor:

  ```js
  summary: function (issue) {
    return issue.fields.summary;
  },
  ```

- Remove the `description` extractor.
- Remove `adfToPlainText`, `walkAdfNode_`, and `BLOCK_NODE_TYPES_`
  (no remaining callers).

### 3. `src/Test.js` (editor tests)

- `sampleEditorIssue_()`: replace the ADF `description` block with
  `summary: 'Hello World'`.
- `testExtractors_()`: replace the `description` assertion with
  `assertEqual_(extractField('summary', issue, CONFIG), 'Hello World', 'summary')`.

### 4. `tests/test_field_extractor.js`

- Remove the three `adfToPlainText` tests and the `description` extraction
  tests (including the `fields.description = null` case).
- Add `summary` tests:
  - extracts `fields.summary` string,
  - missing/null summary → `''` (via existing `extractField` null handling).
- Update the sample issue fixture: ADF `description` → `summary` string.

### 5. `tests/test_sheet_writer.js`

- Header fixture: `'Description'` → `'Title'`.
- Issue fixture: `description: 'plain description'` → `summary: 'plain title'`
  (key rename to match the new extractor).
- Row assertion comment/value for column F updated accordingly.

## Error Handling

No new paths. The existing `extractField` wrapper already converts
null/undefined to `''` and catches extractor exceptions, which covers a
missing `summary`.

## Out of Scope / Manual Step

- The header cell of column F in the real spreadsheet is maintained by hand.
  After deploying, rename it from "Description" to "Title" manually.
- The original design doc (`2026-06-03-jira2ggsheet-design.md`) is left
  unchanged as a historical record.

## Testing

- Node tests: `node tests/run.js` — all pass after the change.
- Editor smoke test: run `testAll()` in the Apps Script editor.
