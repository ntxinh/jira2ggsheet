# Cross-Account Sheet Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Apps Script write to a Google Sheet owned by another Gmail account when that sheet is shared with the script owner.

**Architecture:** Add optional `CONFIG.SPREADSHEET_ID`. `SheetWriter.js` resolves the target spreadsheet through one helper, using `SpreadsheetApp.openById` when configured and `SpreadsheetApp.getActiveSpreadsheet()` as the backward-compatible fallback. Existing webhook routing and per-sprint sheet behavior stay unchanged.

**Tech Stack:** Google Apps Script JavaScript, Node.js zero-dependency tests, local fake `SpreadsheetApp`.

---

## File Structure

- Modify `src/Config.js`: add `SPREADSHEET_ID: ''`.
- Modify `src/SheetWriter.js`: add `getTargetSpreadsheet_()` and route all spreadsheet access through it.
- Modify `tests/fakes.js`: add fake `openById(id)` support while preserving `getActiveSpreadsheet()`.
- Modify `tests/test_config.js`: assert `SPREADSHEET_ID` exists and is a string.
- Modify `tests/test_sheet_writer.js`: add tests for fallback active spreadsheet, explicit target spreadsheet, and delete through explicit target.
- Modify `README.md`: document the new config field.
- Modify `SETUP.md`: document same-account and two-account setup flows.

---

### Task 1: Extend SpreadsheetApp Fake

**Files:**
- Modify: `tests/fakes.js`
- Test: `tests/test_sheet_writer.js`

- [ ] **Step 1: Replace `fakeSpreadsheetApp` with active + by-id support**

In `tests/fakes.js`, replace the current `fakeSpreadsheetApp` function with:

```javascript
function makeSpreadsheet_(sheets) {
  return {
    _sheets: sheets.slice(),
    getSheets() {
      return this._sheets;
    },
    getSheetByName(name) {
      return this._sheets.find((s) => s.getName() === name) || null;
    },
  };
}

function fakeSpreadsheetApp(sheets, options) {
  options = options || {};
  const active = makeSpreadsheet_(sheets);
  const byId = {};
  const sourceById = options.spreadsheetsById || {};
  for (const id of Object.keys(sourceById)) {
    byId[id] = makeSpreadsheet_(sourceById[id]);
  }

  return {
    openedIds: [],
    _spreadsheetsById: byId,
    getActiveSpreadsheet() {
      return active;
    },
    openById(id) {
      this.openedIds.push(id);
      if (!byId[id]) throw new Error('Spreadsheet not found: ' + id);
      return byId[id];
    },
  };
}
```

- [ ] **Step 2: Run existing tests**

Run:

```bash
rtk node tests/run.js
```

Expected: all existing tests pass.

- [ ] **Step 3: Commit test fake update**

```bash
rtk git add tests/fakes.js
rtk git commit -m "test: support spreadsheet lookup by id"
```

---

### Task 2: Add Failing Tests For Spreadsheet Selection

**Files:**
- Modify: `tests/test_config.js`
- Modify: `tests/test_sheet_writer.js`

- [ ] **Step 1: Add config assertion**

In `tests/test_config.js`, inside `'CONFIG loads with required keys'`, add:

```javascript
assert.strictEqual(typeof app.CONFIG.SPREADSHEET_ID, 'string');
```

- [ ] **Step 2: Add reusable sheet-spec mapper**

In `tests/test_sheet_writer.js`, replace `makeApp` with:

```javascript
function makeSheets(sheetSpecs) {
  return sheetSpecs.map((s) => new FakeSheet(s.rows, s.name));
}

function makeApp(sheetSpecs, options) {
  const spreadsheetApp = fakeSpreadsheetApp(makeSheets(sheetSpecs), options);
  const app = loadAppsScript({ SpreadsheetApp: spreadsheetApp });
  const ss = app.SpreadsheetApp.getActiveSpreadsheet();
  return { app, ss };
}
```

- [ ] **Step 3: Add explicit spreadsheet ID upsert test**

In `tests/test_sheet_writer.js`, add this test before the delete tests:

```javascript
'upsertIssue writes to CONFIG.SPREADSHEET_ID when configured'() {
  const targetSheets = makeSheets([{ name: 'Template', rows: [HEADER] }]);
  const { app, ss } = makeApp(
    [{ name: 'Template', rows: [HEADER] }],
    { spreadsheetsById: { sheet123: targetSheets } }
  );
  app.CONFIG.SPREADSHEET_ID = 'sheet123';
  app.upsertIssue(sampleIssue(app));
  assert.strictEqual(tabNamed(ss, '10_Sprint 10'), null); // active spreadsheet untouched
  const targetSs = app.SpreadsheetApp._spreadsheetsById.sheet123;
  const sheet = tabNamed(targetSs, '10_Sprint 10');
  assert.ok(sheet, 'sprint tab created in configured spreadsheet');
  assert.strictEqual(sheet.rows[1][2], 'ABC-123');
  assert.deepStrictEqual(app.SpreadsheetApp.openedIds, ['sheet123']);
},
```

- [ ] **Step 4: Add explicit spreadsheet ID delete test**

In `tests/test_sheet_writer.js`, add this test after `'deleteIssue removes the row in delete mode'`:

```javascript
'deleteIssue uses CONFIG.SPREADSHEET_ID when configured'() {
  const existing = ['9', '', 'ABC-123', 'Story', 'Low', '', 'To Do',
    '', '', '', '', '', '', '', '', 1, '', '', '', '', ''];
  const targetSheets = makeSheets([
    { name: 'Template', rows: [HEADER] },
    { name: '10_Sprint 10', rows: [HEADER, existing] },
  ]);
  const { app, ss } = makeApp(
    [{ name: 'Template', rows: [HEADER] }],
    { spreadsheetsById: { sheet123: targetSheets } }
  );
  app.CONFIG.SPREADSHEET_ID = 'sheet123';
  app.CONFIG.DELETE_MODE = 'delete';
  app.deleteIssue({ key: 'ABC-123' });
  assert.strictEqual(tabNamed(ss, '10_Sprint 10'), null); // active spreadsheet untouched
  const targetSs = app.SpreadsheetApp._spreadsheetsById.sheet123;
  assert.strictEqual(tabNamed(targetSs, '10_Sprint 10').rows.length, 1);
  assert.deepStrictEqual(app.SpreadsheetApp.openedIds, ['sheet123']);
},
```

- [ ] **Step 5: Run tests and verify failure**

Run:

```bash
rtk node tests/run.js
```

Expected failures:

```text
typeof app.CONFIG.SPREADSHEET_ID
```

and/or:

```text
Spreadsheet not found
```

or active spreadsheet receives the write instead of configured spreadsheet. Any of these confirm production code does not support the new behavior yet.

---

### Task 3: Implement Spreadsheet Target Selection

**Files:**
- Modify: `src/Config.js`
- Modify: `src/SheetWriter.js`
- Test: `tests/test_config.js`
- Test: `tests/test_sheet_writer.js`

- [ ] **Step 1: Add config key**

In `src/Config.js`, add `SPREADSHEET_ID` after `TEMPLATE_SHEET`:

```javascript
var CONFIG = {
  TEMPLATE_SHEET: 'Template',
  SPREADSHEET_ID: '',
  KEY_COLUMN: 'C',
```

- [ ] **Step 2: Add spreadsheet resolver helper**

At the top of `src/SheetWriter.js`, before `sprintSheetName_`, add:

```javascript
function getTargetSpreadsheet_() {
  if (CONFIG.SPREADSHEET_ID) return SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  return SpreadsheetApp.getActiveSpreadsheet();
}
```

- [ ] **Step 3: Route sprint sheet lookup through helper**

In `getSprintSheet_`, change:

```javascript
const ss = SpreadsheetApp.getActiveSpreadsheet();
```

to:

```javascript
const ss = getTargetSpreadsheet_();
```

- [ ] **Step 4: Route stale-row cleanup through helper**

In `removeKeyFromAllSprintTabs_`, change:

```javascript
const sheets = SpreadsheetApp.getActiveSpreadsheet().getSheets();
```

to:

```javascript
const sheets = getTargetSpreadsheet_().getSheets();
```

- [ ] **Step 5: Route delete through helper**

In `deleteIssue`, change:

```javascript
const sheets = SpreadsheetApp.getActiveSpreadsheet().getSheets();
```

to:

```javascript
const sheets = getTargetSpreadsheet_().getSheets();
```

- [ ] **Step 6: Run full test suite**

Run:

```bash
rtk node tests/run.js
```

Expected: all tests pass.

- [ ] **Step 7: Commit implementation**

```bash
rtk git add src/Config.js src/SheetWriter.js tests/test_config.js tests/test_sheet_writer.js
rtk git commit -m "feat: support explicit spreadsheet id"
```

---

### Task 4: Update User Documentation

**Files:**
- Modify: `README.md`
- Modify: `SETUP.md`

- [ ] **Step 1: Update README config table**

In `README.md`, update the `src/Config.js` row to include `SPREADSHEET_ID`:

```markdown
| `src/Config.js` | All settings: spreadsheet ID (optional), column map, custom field IDs, secret token, delete mode, template tab name (`TEMPLATE_SHEET`) |
```

- [ ] **Step 2: Add setup guidance for optional spreadsheet ID**

In `SETUP.md`, under "3. Edit the config", add this bullet after `TEMPLATE_SHEET`:

```markdown
- `SPREADSHEET_ID` — optional. Leave empty for a script bound to the target
  sheet. Set it when the Apps Script project is owned by a different Gmail than
  the sheet owner, or when the script is standalone. Copy the ID from the sheet
  URL: the part between `/d/` and `/edit`.
```

- [ ] **Step 3: Add two-account setup note**

In `SETUP.md`, after the "Deploy the web app" steps and before the Jira webhook section, add:

```markdown
### Two Gmail accounts

If the Google Sheet owner and Apps Script owner are different accounts:

1. The sheet owner must share the target sheet with the Apps Script owner as
   **Editor**.
2. The Apps Script owner sets `SPREADSHEET_ID` in `Config`.
3. The Apps Script owner deploys the web app with **Execute as: Me**.

Without editor access, `SpreadsheetApp.openById` cannot write to the sheet.
```

- [ ] **Step 4: Run tests**

Run:

```bash
rtk node tests/run.js
```

Expected: all tests pass.

- [ ] **Step 5: Commit docs**

```bash
rtk git add README.md SETUP.md
rtk git commit -m "docs: explain cross-account sheet setup"
```

---

### Task 5: Final Verification

**Files:**
- Verify: all changed files

- [ ] **Step 1: Run full test suite**

```bash
rtk node tests/run.js
```

Expected: all tests pass.

- [ ] **Step 2: Inspect final diff**

```bash
rtk git status --short
rtk git log --oneline -5
```

Expected: working tree clean, recent commits include:

```text
docs: explain cross-account sheet setup
feat: support explicit spreadsheet id
test: support spreadsheet lookup by id
docs: spec cross-account sheet access
```

## Self-Review

- Spec coverage: plan covers `SPREADSHEET_ID`, `openById` fallback behavior, two-account setup docs, fake service support, config test, upsert test, delete test.
- Placeholder scan: no placeholder tokens or unspecified implementation steps.
- Type consistency: config key is `SPREADSHEET_ID`; helper is `getTargetSpreadsheet_`; fake uses `spreadsheetsById`, `_spreadsheetsById`, and `openedIds` consistently.
