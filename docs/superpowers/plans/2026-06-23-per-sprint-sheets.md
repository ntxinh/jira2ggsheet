# Per-Sprint Sheets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route each Jira issue to its own per-sprint tab named `{Sprint Id}_{Sprint Name}` instead of one shared `Issues` sheet.

**Architecture:** Keep `src/SheetWriter.js` as the only file touching `SpreadsheetApp`; add a sheet-router layer there (`sprintSheetName_`, `getSprintSheet_`, `isSprintTab_`, `removeKeyFromAllSprintTabs_`). Extend `src/FieldExtractor.js` to return the full sprint object (`{id, name, state}`). New tabs are cloned from a template tab.

**Tech Stack:** Google Apps Script (plain ES5-style `.js`), zero-dependency Node test harness (`tests/run.js`), `assert`.

## Global Constraints

- Source files are plain Apps Script in `src/*.js`, loaded in order `Config.js, FieldExtractor.js, SheetWriter.js, WebApp.js` into one shared global scope (`tests/harness.js`). Functions are global; no `module.exports` in `src/`.
- Helper functions private to a file end with `_` (Apps Script convention, e.g. `getSheet_`, `parseSprint_`).
- No external dependencies in `src/` or `tests/`.
- Run the full suite with `node tests/run.js` (Node 14+). Exit code non-zero on any failure.
- Google Sheets tab names: max 100 chars; may not contain `[ ] : \ / ? *`.
- Decisions (from spec): no-sprint issue → **skip**; sprint move → **purge stale row from other tabs**; new tab → **clone template tab**; tab lookup → **match by `{id}_` prefix, rename-safe**.

---

### Task 1: Sprint object extraction

Extend `FieldExtractor.js` so a full sprint object (`{id, name, state}`) can be resolved, while keeping `pickSprintId` working for the `sprintId` column extractor.

**Files:**
- Modify: `src/FieldExtractor.js` (`parseSprint_` lines 26-39, `pickSprintId` lines 14-24)
- Test: `tests/test_field_extractor.js`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `parseSprint_(entry)` → `{ id, name, state }` or `null` (now includes `name`).
  - `pickSprint(sprintField)` → `{ id, name, state }` or `null`.
  - `pickSprintId(sprintField)` → sprint id, or `''` when none (unchanged contract).

- [ ] **Step 1: Write the failing tests**

Add these to the exported object in `tests/test_field_extractor.js`:

```js
  'pickSprint returns the full active sprint object'() {
    const sprints = [
      { id: 9, state: 'closed', name: 'S9' },
      { id: 10, state: 'active', name: 'Sprint 10' },
      { id: 11, state: 'future', name: 'S11' },
    ];
    assert.deepStrictEqual(app.pickSprint(sprints), { id: 10, name: 'Sprint 10', state: 'active' });
  },
  'pickSprint falls back to the last sprint when none active'() {
    const sprints = [{ id: 9, state: 'closed', name: 'S9' }, { id: 11, state: 'future', name: 'S11' }];
    assert.deepStrictEqual(app.pickSprint(sprints), { id: 11, name: 'S11', state: 'future' });
  },
  'pickSprint returns null for empty, null, and missing field'() {
    assert.strictEqual(app.pickSprint([]), null);
    assert.strictEqual(app.pickSprint(null), null);
    assert.strictEqual(app.pickSprint(undefined), null);
  },
  'pickSprint parses name from legacy string-encoded sprints'() {
    const legacy = ['com.atlassian.greenhopper.service.sprint.Sprint@2a[id=10,state=ACTIVE,name=Sprint 10]'];
    assert.deepStrictEqual(app.pickSprint(legacy), { id: 10, name: 'Sprint 10', state: 'active' });
  },
  'pickSprint defaults name to empty string when absent'() {
    assert.deepStrictEqual(app.pickSprint([{ id: 5, state: 'active' }]), { id: 5, name: '', state: 'active' });
  },
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node tests/run.js`
Expected: FAIL — `app.pickSprint is not a function` on the new tests; existing tests still pass.

- [ ] **Step 3: Implement the extraction changes**

In `src/FieldExtractor.js`, replace `parseSprint_` (lines 26-39) with:

```js
function parseSprint_(entry) {
  if (entry == null) return null;
  if (typeof entry === 'object') {
    if (entry.id == null) return null;
    return {
      id: entry.id,
      name: entry.name == null ? '' : String(entry.name),
      state: String(entry.state || '').toLowerCase(),
    };
  }
  if (typeof entry === 'string') {
    const idMatch = entry.match(/\bid=(\d+)/);
    if (!idMatch) return null;
    const stateMatch = entry.match(/\bstate=(\w+)/);
    const nameMatch = entry.match(/\bname=([^,\]]+)/);
    return {
      id: Number(idMatch[1]),
      name: nameMatch ? nameMatch[1] : '',
      state: stateMatch ? stateMatch[1].toLowerCase() : '',
    };
  }
  return null;
}
```

Replace `pickSprintId` (lines 14-24) with `pickSprint` plus a thin `pickSprintId` wrapper:

```js
function pickSprint(sprintField) {
  if (!Array.isArray(sprintField) || sprintField.length === 0) return null;
  const sprints = sprintField.map(parseSprint_).filter(function (s) {
    return s !== null;
  });
  if (sprints.length === 0) return null;
  const active = sprints.find(function (s) {
    return s.state === 'active';
  });
  return active || sprints[sprints.length - 1];
}

function pickSprintId(sprintField) {
  const sprint = pickSprint(sprintField);
  return sprint ? sprint.id : '';
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node tests/run.js`
Expected: PASS — all `pickSprint` and existing `pickSprintId` tests green.

- [ ] **Step 5: Commit**

```bash
git add src/FieldExtractor.js tests/test_field_extractor.js
git commit -m "feat: extract full sprint object (id, name, state)"
```

---

### Task 2: Sprint sheet-name helper + config

Add the pure helper that turns a sprint into a sanitized tab name, and add the template-tab config key.

**Files:**
- Modify: `src/Config.js:2` (replace `SHEET_NAME` with `TEMPLATE_SHEET`)
- Modify: `src/SheetWriter.js` (add `sprintSheetName_` near the top)
- Test: `tests/test_sheet_writer.js` (add cases; full rewrite of this file happens in Task 4 — for now append)

**Interfaces:**
- Consumes: `CONFIG` global.
- Produces: `sprintSheetName_({ id, name })` → string `"{id}_{sanitizedName}"`, invalid chars `[ ] : \ / ? *` replaced with `-`, truncated to 100 chars.

- [ ] **Step 1: Write the failing tests**

Create a new file `tests/test_sheet_name.js` (kept separate from the sheet-writer rewrite):

```js
const assert = require('assert');
const { loadAppsScript } = require('./harness');

const app = loadAppsScript({});

module.exports = {
  'sprintSheetName_ joins id and name with underscore'() {
    assert.strictEqual(app.sprintSheetName_({ id: 42, name: 'Sprint 5' }), '42_Sprint 5');
  },
  'sprintSheetName_ replaces characters illegal in a tab name'() {
    assert.strictEqual(app.sprintSheetName_({ id: 7, name: 'A/B:C[D]E\\F?G*H' }), '7_A-B-C-D-E-F-G-H');
  },
  'sprintSheetName_ handles an empty name'() {
    assert.strictEqual(app.sprintSheetName_({ id: 3, name: '' }), '3_');
  },
  'sprintSheetName_ truncates to 100 characters'() {
    const longName = new Array(200).join('x'); // 199 chars
    const result = app.sprintSheetName_({ id: 1, name: longName });
    assert.strictEqual(result.length, 100);
    assert.strictEqual(result.slice(0, 2), '1_');
  },
};
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node tests/run.js`
Expected: FAIL — `app.sprintSheetName_ is not a function`.

- [ ] **Step 3: Implement the helper and config key**

In `src/Config.js`, replace line 2 (`SHEET_NAME: 'Issues',`) with:

```js
  TEMPLATE_SHEET: 'Template',
```

In `src/SheetWriter.js`, add at the top of the file (above `getSheet_`):

```js
function sprintSheetName_(sprint) {
  const safeName = String(sprint.name == null ? '' : sprint.name).replace(/[\[\]:\\/?*]/g, '-');
  return (sprint.id + '_' + safeName).slice(0, 100);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node tests/run.js`
Expected: PASS — the four `sprintSheetName_` tests green. (Existing `test_sheet_writer.js` tests now FAIL because `SHEET_NAME` is gone — that is expected and fixed in Task 4. If running task-by-task with a clean gate, note this known breakage.)

- [ ] **Step 5: Commit**

```bash
git add src/Config.js src/SheetWriter.js tests/test_sheet_name.js
git commit -m "feat: add sprintSheetName_ helper and TEMPLATE_SHEET config"
```

---

### Task 3: Multi-sheet test fake + sheet router

Upgrade the test fakes to support multiple named sheets and `copyTo`, then add `getSprintSheet_` (find-by-prefix / rename / clone-template).

**Files:**
- Modify: `tests/fakes.js` (full rewrite)
- Modify: `src/SheetWriter.js` (add `getSprintSheet_`)
- Test: `tests/test_sheet_router.js` (new)

**Interfaces:**
- Consumes: `sprintSheetName_` (Task 2), `CONFIG.TEMPLATE_SHEET`.
- Produces:
  - Fake (`tests/fakes.js`): `FakeSheet(rows, name)` with `getName()`, `setName(name)` (returns `this`), `copyTo(ss)` (pushes a copy into `ss._sheets`, returns it), plus existing `getLastRow/getRange/deleteRow`. `fakeSpreadsheetApp(sheets)` takes an **array** of `FakeSheet` and returns `{ getActiveSpreadsheet() }` whose spreadsheet has `getSheets()`, `getSheetByName(name)`, and `_sheets`.
  - `getSprintSheet_({ id, name, state })` → the `FakeSheet`/Apps-Script sheet for that sprint, creating it from the template when absent, renaming it when the name changed.

- [ ] **Step 1: Rewrite the fake**

Replace the entire contents of `tests/fakes.js` with:

```js
class FakeSheet {
  constructor(rows, name) {
    this.rows = (rows || []).map((r) => r.slice());
    this.name = name || '';
  }

  getName() {
    return this.name;
  }

  setName(name) {
    this.name = name;
    return this;
  }

  copyTo(ss) {
    const copy = new FakeSheet(this.rows, 'Copy of ' + this.name);
    ss._sheets.push(copy);
    return copy;
  }

  getLastRow() {
    for (let i = this.rows.length; i > 0; i--) {
      if (this.rows[i - 1].some((v) => v !== '' && v != null)) return i;
    }
    return 0;
  }

  getRange(row, col, numRows, numCols) {
    numRows = numRows || 1;
    numCols = numCols || 1;
    const self = this;
    return {
      getValues() {
        const out = [];
        for (let r = 0; r < numRows; r++) {
          const line = [];
          for (let c = 0; c < numCols; c++) {
            const v = (self.rows[row - 1 + r] || [])[col - 1 + c];
            line.push(v === undefined ? '' : v);
          }
          out.push(line);
        }
        return out;
      },
      setValue(value) {
        while (self.rows.length < row) self.rows.push([]);
        const line = self.rows[row - 1];
        while (line.length < col) line.push('');
        line[col - 1] = value;
      },
    };
  }

  deleteRow(row) {
    this.rows.splice(row - 1, 1);
  }
}

function fakeSpreadsheetApp(sheets) {
  const ss = {
    _sheets: sheets.slice(),
    getSheets() {
      return this._sheets;
    },
    getSheetByName(name) {
      return this._sheets.find((s) => s.getName() === name) || null;
    },
  };
  return {
    getActiveSpreadsheet() {
      return ss;
    },
  };
}

module.exports = { FakeSheet, fakeSpreadsheetApp };
```

- [ ] **Step 2: Write the failing router tests**

Create `tests/test_sheet_router.js`:

```js
const assert = require('assert');
const { loadAppsScript } = require('./harness');
const { FakeSheet, fakeSpreadsheetApp } = require('./fakes');

const HEADER = ['Sprint', 'Manual', 'Key', 'Type', 'Priority', 'Title', 'Status'];

function makeApp(sheetSpecs) {
  const sheets = sheetSpecs.map((s) => new FakeSheet(s.rows, s.name));
  const app = loadAppsScript({ SpreadsheetApp: fakeSpreadsheetApp(sheets) });
  return { app, ss: app.SpreadsheetApp.getActiveSpreadsheet() };
}

module.exports = {
  'getSprintSheet_ clones the template for a brand-new sprint'() {
    const { app, ss } = makeApp([{ name: 'Template', rows: [HEADER] }]);
    const sheet = app.getSprintSheet_({ id: 42, name: 'Sprint 5', state: 'active' });
    assert.strictEqual(sheet.getName(), '42_Sprint 5');
    assert.strictEqual(ss.getSheets().length, 2); // template + new tab
    assert.deepStrictEqual(sheet.rows[0], HEADER); // header copied from template
  },
  'getSprintSheet_ returns the existing tab without cloning'() {
    const { app, ss } = makeApp([
      { name: 'Template', rows: [HEADER] },
      { name: '42_Sprint 5', rows: [HEADER] },
    ]);
    const sheet = app.getSprintSheet_({ id: 42, name: 'Sprint 5', state: 'active' });
    assert.strictEqual(sheet.getName(), '42_Sprint 5');
    assert.strictEqual(ss.getSheets().length, 2); // no new tab
  },
  'getSprintSheet_ renames the tab when the sprint was renamed'() {
    const { app, ss } = makeApp([
      { name: 'Template', rows: [HEADER] },
      { name: '42_Old Name', rows: [HEADER] },
    ]);
    const sheet = app.getSprintSheet_({ id: 42, name: 'New Name', state: 'active' });
    assert.strictEqual(sheet.getName(), '42_New Name');
    assert.strictEqual(ss.getSheets().length, 2); // renamed in place, not cloned
  },
  'getSprintSheet_ does not confuse id prefixes (1_ vs 10_)'() {
    const { app } = makeApp([
      { name: 'Template', rows: [HEADER] },
      { name: '10_Ten', rows: [HEADER] },
    ]);
    const sheet = app.getSprintSheet_({ id: 1, name: 'One', state: 'active' });
    assert.strictEqual(sheet.getName(), '1_One'); // cloned fresh, did not match 10_Ten
  },
  'getSprintSheet_ throws a clear error when the template is missing'() {
    const { app } = makeApp([{ name: 'Issues', rows: [HEADER] }]);
    assert.throws(() => app.getSprintSheet_({ id: 1, name: 'One', state: 'active' }), /Template tab not found/);
  },
};
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node tests/run.js`
Expected: FAIL — `app.getSprintSheet_ is not a function`.

- [ ] **Step 4: Implement the router**

In `src/SheetWriter.js`, add (below `sprintSheetName_`):

```js
function getSprintSheet_(sprint) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const target = sprintSheetName_(sprint);
  const prefix = sprint.id + '_';
  const sheets = ss.getSheets();
  for (let i = 0; i < sheets.length; i++) {
    const name = sheets[i].getName();
    if (name === CONFIG.TEMPLATE_SHEET) continue;
    if (name.indexOf(prefix) === 0) {
      if (name !== target) sheets[i].setName(target);
      return sheets[i];
    }
  }
  const template = ss.getSheetByName(CONFIG.TEMPLATE_SHEET);
  if (!template) throw new Error('Template tab not found: ' + CONFIG.TEMPLATE_SHEET);
  return template.copyTo(ss).setName(target);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node tests/run.js`
Expected: PASS — all five `test_sheet_router.js` cases green.

- [ ] **Step 6: Commit**

```bash
git add tests/fakes.js src/SheetWriter.js tests/test_sheet_router.js
git commit -m "feat: add per-sprint sheet router with multi-sheet test fake"
```

---

### Task 4: Route upsert to the sprint tab + purge stale rows

Rewrite `upsertIssue` to skip no-sprint issues, write to the sprint tab, and remove the key from any other sprint tab (handles sprint moves). Replace the obsolete single-sheet tests.

**Files:**
- Modify: `src/SheetWriter.js` (`getSheet_` removed; `upsertIssue` rewritten; add `isSprintTab_`, `removeKeyFromAllSprintTabs_`)
- Test: `tests/test_sheet_writer.js` (full rewrite)

**Interfaces:**
- Consumes: `pickSprint` (Task 1), `getSprintSheet_` (Task 3), `findRowByKey_`, `extractField`, `columnLetterToIndex`, `CONFIG`.
- Produces:
  - `isSprintTab_(sheet)` → `true` when the tab name matches `^\d+_` and is not the template.
  - `removeKeyFromAllSprintTabs_(issueKey, exceptSheet)` → deletes the issue's row from every sprint tab except `exceptSheet`.
  - `upsertIssue(issue)` → routes to the sprint tab; no-op (logs) when the issue has no sprint.

- [ ] **Step 1: Rewrite the sheet-writer tests**

Replace the entire contents of `tests/test_sheet_writer.js` with:

```js
const assert = require('assert');
const { loadAppsScript } = require('./harness');
const { FakeSheet, fakeSpreadsheetApp } = require('./fakes');

// Columns A..U (21 columns). Mapped: A,C,D,E,F,G,L,P,U.
const HEADER = [
  'Sprint', 'Manual', 'Key', 'Type', 'Priority', 'Title', 'Status',
  '', '', '', '', 'Created', '', '', '', 'Points', '', '', '', '', 'Assignee',
];

function makeApp(sheetSpecs) {
  const sheets = sheetSpecs.map((s) => new FakeSheet(s.rows, s.name));
  const app = loadAppsScript({ SpreadsheetApp: fakeSpreadsheetApp(sheets) });
  const ss = app.SpreadsheetApp.getActiveSpreadsheet();
  return { app, ss };
}

function tabNamed(ss, name) {
  return ss.getSheets().find((s) => s.getName() === name) || null;
}

function sampleIssue(app, key, sprint) {
  const fields = {
    project: { key: 'ABC' },
    issuetype: { name: 'Story' },
    priority: { name: 'High' },
    status: { name: 'In Progress' },
    assignee: { displayName: 'Jane Doe' },
    created: '2026-06-03T10:30:00.000+0700',
    summary: 'plain title',
  };
  fields[app.CONFIG.CUSTOM_FIELDS.storyPoints] = 5;
  fields[app.CONFIG.CUSTOM_FIELDS.sprint] = sprint || [{ id: 10, state: 'active', name: 'Sprint 10' }];
  return { key: key || 'ABC-123', fields: fields };
}

module.exports = {
  'upsertIssue clones the sprint tab and writes all mapped cells'() {
    const { app, ss } = makeApp([{ name: 'Template', rows: [HEADER] }]);
    app.upsertIssue(sampleIssue(app));
    const sheet = tabNamed(ss, '10_Sprint 10');
    assert.ok(sheet, 'sprint tab created');
    const row = sheet.rows[1];
    assert.strictEqual(row[0], 10); // A sprint
    assert.strictEqual(row[2], 'ABC-123'); // C key
    assert.strictEqual(row[3], 'Story'); // D type
    assert.strictEqual(row[4], 'High'); // E priority
    assert.strictEqual(row[5], 'plain title'); // F title (summary)
    assert.strictEqual(row[6], 'In Progress'); // G status
    assert.strictEqual(row[11], '2026-06-03 10:30'); // L created
    assert.strictEqual(row[15], 5); // P points
    assert.strictEqual(row[20], 'Jane Doe'); // U assignee
  },
  'upsertIssue updates the existing row and preserves unmapped cells'() {
    const existing = ['9', 'manual note', 'ABC-123', 'Story', 'Low', 'old', 'To Do',
      '', '', '', '', 'x', '', '', '', 1, '', '', '', '', 'Old Guy'];
    const { app, ss } = makeApp([
      { name: 'Template', rows: [HEADER] },
      { name: '10_Sprint 10', rows: [HEADER, existing] },
    ]);
    app.upsertIssue(sampleIssue(app));
    const sheet = tabNamed(ss, '10_Sprint 10');
    assert.strictEqual(sheet.rows.length, 2); // no new row
    assert.strictEqual(sheet.rows[1][6], 'In Progress'); // status updated
    assert.strictEqual(sheet.rows[1][1], 'manual note'); // column B untouched
  },
  'upsertIssue skips an issue with no sprint'() {
    const { app, ss } = makeApp([{ name: 'Template', rows: [HEADER] }]);
    app.upsertIssue(sampleIssue(app, 'ABC-123', []));
    assert.strictEqual(ss.getSheets().length, 1); // nothing created
  },
  'upsertIssue moves an issue out of its old sprint tab'() {
    const existing = ['9', '', 'ABC-123', 'Story', 'Low', 'old', 'To Do',
      '', '', '', '', '', '', '', '', 1, '', '', '', '', ''];
    const { app, ss } = makeApp([
      { name: 'Template', rows: [HEADER] },
      { name: '9_Old Sprint', rows: [HEADER, existing] },
    ]);
    // Issue now belongs to sprint 10.
    app.upsertIssue(sampleIssue(app));
    const oldTab = tabNamed(ss, '9_Old Sprint');
    const newTab = tabNamed(ss, '10_Sprint 10');
    assert.strictEqual(oldTab.rows.length, 1); // stale row purged, header only
    assert.ok(newTab, 'new sprint tab created');
    assert.strictEqual(newTab.rows[1][2], 'ABC-123'); // written to new tab
  },
  'upsertIssue throws a clear error when the template is missing'() {
    const { app } = makeApp([{ name: 'Issues', rows: [HEADER] }]);
    assert.throws(() => app.upsertIssue(sampleIssue(app)), /Template tab not found/);
  },

  'deleteIssue removes the row in delete mode'() {
    const existing = ['9', '', 'ABC-123', 'Story', 'Low', '', 'To Do',
      '', '', '', '', '', '', '', '', 1, '', '', '', '', ''];
    const { app, ss } = makeApp([
      { name: 'Template', rows: [HEADER] },
      { name: '10_Sprint 10', rows: [HEADER, existing] },
    ]);
    app.CONFIG.DELETE_MODE = 'delete';
    app.deleteIssue({ key: 'ABC-123' });
    assert.strictEqual(tabNamed(ss, '10_Sprint 10').rows.length, 1); // only header left
  },
  'deleteIssue marks the status column in mark mode'() {
    const existing = ['9', '', 'ABC-123', 'Story', 'Low', '', 'To Do',
      '', '', '', '', '', '', '', '', 1, '', '', '', '', ''];
    const { app, ss } = makeApp([
      { name: 'Template', rows: [HEADER] },
      { name: '10_Sprint 10', rows: [HEADER, existing] },
    ]);
    app.CONFIG.DELETE_MODE = 'mark';
    app.deleteIssue({ key: 'ABC-123' });
    const sheet = tabNamed(ss, '10_Sprint 10');
    assert.strictEqual(sheet.rows.length, 2); // row kept
    assert.strictEqual(sheet.rows[1][6], 'Deleted'); // G = status column
  },
  'deleteIssue finds the row across multiple sprint tabs'() {
    const here = ['11', '', 'ABC-123', 'Story', 'Low', '', 'To Do',
      '', '', '', '', '', '', '', '', 1, '', '', '', '', ''];
    const { app, ss } = makeApp([
      { name: 'Template', rows: [HEADER] },
      { name: '10_Sprint 10', rows: [HEADER] },
      { name: '11_Sprint 11', rows: [HEADER, here] },
    ]);
    app.CONFIG.DELETE_MODE = 'delete';
    app.deleteIssue({ key: 'ABC-123' });
    assert.strictEqual(tabNamed(ss, '11_Sprint 11').rows.length, 1); // removed from the right tab
  },
  'deleteIssue is a no-op for unknown keys'() {
    const { app, ss } = makeApp([
      { name: 'Template', rows: [HEADER] },
      { name: '10_Sprint 10', rows: [HEADER] },
    ]);
    app.deleteIssue({ key: 'ABC-404' }); // must not throw
    assert.strictEqual(tabNamed(ss, '10_Sprint 10').rows.length, 1);
  },
};
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node tests/run.js`
Expected: FAIL — upsert tests fail (`upsertIssue` still uses the removed `SHEET_NAME`/`getSheet_` path and does not route by sprint). `deleteIssue` cross-tab test also fails.

- [ ] **Step 3: Implement the routing + purge in `upsertIssue`**

In `src/SheetWriter.js`: delete the `getSheet_` function (old lines 1-5). Add the two helpers and rewrite `upsertIssue`:

```js
function isSprintTab_(sheet) {
  if (sheet.getName() === CONFIG.TEMPLATE_SHEET) return false;
  return /^\d+_/.test(sheet.getName());
}

function removeKeyFromAllSprintTabs_(issueKey, exceptSheet) {
  const sheets = SpreadsheetApp.getActiveSpreadsheet().getSheets();
  for (let i = 0; i < sheets.length; i++) {
    const sheet = sheets[i];
    if (!isSprintTab_(sheet)) continue;
    if (exceptSheet && sheet.getName() === exceptSheet.getName()) continue;
    const row = findRowByKey_(sheet, issueKey);
    if (row) sheet.deleteRow(row);
  }
}

function upsertIssue(issue) {
  const sprint = pickSprint(issue.fields[CONFIG.CUSTOM_FIELDS.sprint]);
  if (!sprint) {
    console.log('Skipped ' + issue.key + ': no sprint');
    return;
  }
  const sheet = getSprintSheet_(sprint);
  removeKeyFromAllSprintTabs_(issue.key, sheet);
  let row = findRowByKey_(sheet, issue.key);
  if (!row) row = Math.max(sheet.getLastRow(), CONFIG.HEADER_ROWS) + 1;
  for (const letter in CONFIG.COLUMN_MAP) {
    const value = extractField(CONFIG.COLUMN_MAP[letter], issue, CONFIG);
    sheet.getRange(row, columnLetterToIndex(letter)).setValue(value);
  }
}
```

> Note: `deleteIssue` and `statusColumnIndex_` still reference the removed `getSheet_` indirectly via the old body — they are rewritten in Task 5. The `deleteIssue` cross-tab test stays red until then; the other upsert tests should pass now.

- [ ] **Step 4: Run tests to verify upsert passes**

Run: `node tests/run.js`
Expected: PASS for all `upsertIssue` cases. The `deleteIssue finds the row across multiple sprint tabs` case may still FAIL (fixed in Task 5).

- [ ] **Step 5: Commit**

```bash
git add src/SheetWriter.js tests/test_sheet_writer.js
git commit -m "feat: route upsert to per-sprint tab and purge stale rows"
```

---

### Task 5: Delete across all sprint tabs

Rewrite `deleteIssue` to scan every sprint tab for the key (an issue's row can be in any tab).

**Files:**
- Modify: `src/SheetWriter.js` (`deleteIssue` rewritten; `statusColumnIndex_` unchanged)
- Test: covered by `tests/test_sheet_writer.js` (the delete cases added in Task 4)

**Interfaces:**
- Consumes: `isSprintTab_` (Task 4), `findRowByKey_`, `statusColumnIndex_`, `CONFIG`.
- Produces: `deleteIssue(issue)` → deletes/marks the issue's row in whichever sprint tab holds it.

- [ ] **Step 1: Confirm the delete tests fail**

Run: `node tests/run.js`
Expected: `deleteIssue finds the row across multiple sprint tabs` (and possibly the other delete cases) FAIL because the old `deleteIssue` uses the removed `getSheet_`.

- [ ] **Step 2: Rewrite `deleteIssue`**

In `src/SheetWriter.js`, replace the `deleteIssue` function with:

```js
function deleteIssue(issue) {
  const sheets = SpreadsheetApp.getActiveSpreadsheet().getSheets();
  for (let i = 0; i < sheets.length; i++) {
    const sheet = sheets[i];
    if (!isSprintTab_(sheet)) continue;
    const row = findRowByKey_(sheet, issue.key);
    if (!row) continue;
    if (CONFIG.DELETE_MODE === 'delete') {
      sheet.deleteRow(row);
    } else {
      sheet.getRange(row, statusColumnIndex_()).setValue('Deleted');
    }
  }
}
```

Leave `statusColumnIndex_` as is.

- [ ] **Step 3: Run tests to verify they pass**

Run: `node tests/run.js`
Expected: PASS — all `deleteIssue` cases green, full suite green.

- [ ] **Step 4: Commit**

```bash
git add src/SheetWriter.js
git commit -m "feat: delete issue across all sprint tabs"
```

---

### Task 6: Update docs (README, SETUP, in-editor tests)

Reflect the per-sprint model and template-tab requirement in user-facing docs and the Apps Script editor test runner.

**Files:**
- Modify: `README.md` (layout/how-it-works mentions)
- Modify: `SETUP.md` (template tab setup step)
- Modify: `src/Test.js` (if it references `SHEET_NAME`/`Issues` — verify and update)

**Interfaces:** none (docs/runner only).

- [ ] **Step 1: Verify what references the old model**

Run: `grep -rn "SHEET_NAME\|Issues\|getSheet_" src README.md SETUP.md`
Expected: hits in `README.md`, `SETUP.md`, and possibly `src/Test.js`. Note each.

- [ ] **Step 2: Update `README.md`**

In the "How it works" paragraph, change the description of upsert to note routing per sprint. Replace the sentence:

> which upserts a row in the sheet keyed by issue key.

with:

> which upserts a row into the issue's per-sprint tab (`{Sprint Id}_{Sprint Name}`), cloned from a `Template` tab. Issues with no sprint are skipped.

In the `src/Config.js` table row, replace `secret token, delete mode` description to mention `TEMPLATE_SHEET` instead of `SHEET_NAME` if listed.

- [ ] **Step 3: Update `SETUP.md`**

Add a setup step (after the spreadsheet is created): create a tab named `Template` containing the header row and any column formatting; per-sprint tabs are cloned from it automatically. Remove/observe any instruction to create a single `Issues` tab.

- [ ] **Step 4: Update `src/Test.js` if needed**

If `grep` in Step 1 showed `src/Test.js` references a single `Issues` sheet or `SHEET_NAME`, update its sample run to create/use a `Template` tab and assert a per-sprint tab is produced, mirroring `tests/test_sheet_writer.js`. If it does not reference them, leave it unchanged.

- [ ] **Step 5: Run the suite (sanity) and commit**

Run: `node tests/run.js`
Expected: PASS (docs changes do not affect tests; this confirms nothing regressed).

```bash
git add README.md SETUP.md src/Test.js
git commit -m "docs: per-sprint tabs and Template setup"
```

---

## Self-Review

**Spec coverage:**
- No-sprint → skip → Task 4 (`upsertIssue` early return) + test. ✓
- Sprint move → purge old tab → Task 4 (`removeKeyFromAllSprintTabs_`) + test. ✓
- New tab from template → Task 3 (`getSprintSheet_` clone) + test. ✓
- Tab lookup by id prefix, rename-safe → Task 3 (prefix match + `setName`) + tests (rename, `1_` vs `10_`). ✓
- Sprint name extraction → Task 1 (`pickSprint`, `parseSprint_` name) + tests. ✓
- Sheet-name sanitization + 100-char truncation → Task 2 (`sprintSheetName_`) + tests. ✓
- Delete across tabs (both modes) → Task 5 + tests. ✓
- Test fake multi-sheet support → Task 3. ✓
- Docs (README/SETUP/Test.js) → Task 6. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code; commands have expected output. ✓

**Type consistency:** `pickSprint` returns `{id, name, state}` consumed by `getSprintSheet_`/`sprintSheetName_` (uses `.id`, `.name`); `isSprintTab_`/`removeKeyFromAllSprintTabs_`/`getSprintSheet_` names match across Tasks 3-5; fake `setName` returns `this` so `copyTo(ss).setName(target)` chains. ✓
