# Jira → Google Sheet Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sync Jira Cloud issue changes (create/update/transition/delete) into a Google Sheet in near real-time via a Jira webhook posting to a Google Apps Script web app.

**Architecture:** Jira webhook → Apps Script `doPost` (token check, project filter, event routing) → field extraction via configurable column→field mapping → upsert row keyed by issue key. All business logic is plain JavaScript with no Apps Script API at the core, so it runs locally under Node for TDD; Apps Script APIs (`SpreadsheetApp`, `ContentService`, `LockService`, `Utilities`) are guarded or faked in tests.

**Tech Stack:** Google Apps Script (V8 runtime), plain JavaScript, Node.js (test runner only, zero dependencies). Spec: `docs/superpowers/specs/2026-06-03-jira2ggsheet-design.md`.

**Conventions:**
- Source files live in `src/*.js`. In the Apps Script editor they are created with the same base names (shown as `.gs`); the content is identical — copy-paste.
- `CONFIG` is declared with `var` (not `const`) so it becomes a property of the global object — the Node vm test harness and Apps Script both rely on global-scope sharing across files, and tests mutate `CONFIG.DELETE_MODE`.
- Tests run with `node tests/run.js` from the repo root. No package.json, no dependencies. Requires Node 14+.

---

## File Structure

```
src/
  Config.js          # var CONFIG = {...} — all user-editable settings
  FieldExtractor.js  # pure functions: column letters, ADF→text, sprint pick, date format, extractField dispatcher
  SheetWriter.js     # upsertIssue / deleteIssue — only file touching SpreadsheetApp
  WebApp.js          # doPost (auth, parse) + handleWebhook (filter, route) + withLock_
  Test.js            # Apps Script editor tests (testAll, integration helpers)
tests/
  harness.js         # loads src files into a shared vm context (Apps Script-like global scope)
  fakes.js           # FakeSheet + fakeSpreadsheetApp
  run.js             # zero-dep test runner
  test_config.js
  test_field_extractor.js
  test_sheet_writer.js
  test_webapp.js
SETUP.md             # deployment + webhook registration guide
README.md
```

---

### Task 1: Scaffold — test harness, runner, Config

**Files:**
- Create: `src/Config.js`
- Create: `tests/harness.js`
- Create: `tests/run.js`
- Test: `tests/test_config.js`

- [ ] **Step 1: Write the test harness**

`tests/harness.js`:

```javascript
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Load order matters: later files call functions defined in earlier ones.
const SRC_FILES = ['Config.js', 'FieldExtractor.js', 'SheetWriter.js', 'WebApp.js'];

/**
 * Evaluates the Apps Script source files in one shared vm context,
 * mimicking Apps Script's single global scope. Pass fakes for Apps
 * Script services (SpreadsheetApp, ContentService, ...) via `globals`.
 * Files that don't exist yet are skipped so tasks can build up incrementally.
 */
function loadAppsScript(globals) {
  const sandbox = Object.assign({ console }, globals);
  vm.createContext(sandbox);
  for (const file of SRC_FILES) {
    const full = path.join(__dirname, '..', 'src', file);
    if (!fs.existsSync(full)) continue;
    vm.runInContext(fs.readFileSync(full, 'utf8'), sandbox, { filename: file });
  }
  return sandbox;
}

module.exports = { loadAppsScript };
```

- [ ] **Step 2: Write the test runner**

`tests/run.js`:

```javascript
const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;
const files = fs
  .readdirSync(__dirname)
  .filter((f) => f.startsWith('test_') && f.endsWith('.js'))
  .sort();

for (const file of files) {
  const tests = require(path.join(__dirname, file));
  for (const name of Object.keys(tests)) {
    try {
      tests[name]();
      passed++;
      console.log('PASS  ' + file + ' :: ' + name);
    } catch (err) {
      failed++;
      console.log('FAIL  ' + file + ' :: ' + name + '\n      ' + err.message);
    }
  }
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
```

- [ ] **Step 3: Write the failing config test**

`tests/test_config.js`:

```javascript
const assert = require('assert');
const { loadAppsScript } = require('./harness');

module.exports = {
  'CONFIG loads with required keys'() {
    const app = loadAppsScript({});
    assert.strictEqual(typeof app.CONFIG.SHEET_NAME, 'string');
    assert.strictEqual(typeof app.CONFIG.SECRET_TOKEN, 'string');
    assert.strictEqual(typeof app.CONFIG.PROJECT_KEY, 'string');
    assert.ok(app.CONFIG.COLUMN_MAP.C, 'issue key column must be mapped');
    assert.ok(['delete', 'mark'].includes(app.CONFIG.DELETE_MODE));
    assert.strictEqual(typeof app.CONFIG.CUSTOM_FIELDS.sprint, 'string');
    assert.strictEqual(typeof app.CONFIG.CUSTOM_FIELDS.storyPoints, 'string');
  },
};
```

- [ ] **Step 4: Run test to verify it fails**

Run: `node tests/run.js`
Expected: FAIL with `Cannot read properties of undefined (reading 'SHEET_NAME')` (CONFIG missing — src/Config.js doesn't exist yet)

- [ ] **Step 5: Write the config**

`src/Config.js`:

```javascript
// All user-editable settings live here.
// `var` (not const) so CONFIG is a global-object property — required by the
// Node test harness, and harmless in Apps Script.
var CONFIG = {
  SHEET_NAME: 'Issues', // tab name in the spreadsheet
  KEY_COLUMN: 'C', // column holding the issue key — used for row lookup
  HEADER_ROWS: 1, // rows to skip at the top
  DELETE_MODE: 'delete', // 'delete' = remove row | 'mark' = write "Deleted" to status column
  PROJECT_KEY: 'ABC', // ignore webhook events from other projects
  SECRET_TOKEN: 'long-random-string', // must match ?token= in the webhook URL

  // column letter -> field extractor name (see FieldExtractor.js EXTRACTORS)
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

  // Jira custom field IDs — differ per site, see SETUP.md "Find custom field IDs"
  CUSTOM_FIELDS: {
    sprint: 'customfield_10020',
    storyPoints: 'customfield_10016',
  },

  DATE_FORMAT: 'yyyy-MM-dd HH:mm', // used by Utilities.formatDate for createdDate
  TIMEZONE: 'Asia/Ho_Chi_Minh',
};
```

- [ ] **Step 6: Run test to verify it passes**

Run: `node tests/run.js`
Expected: `PASS  test_config.js :: CONFIG loads with required keys` and `1 passed, 0 failed`

- [ ] **Step 7: Commit**

```bash
git add src/Config.js tests/harness.js tests/run.js tests/test_config.js
git commit -m "feat: scaffold config and zero-dep node test harness"
```

---

### Task 2: FieldExtractor — pure helper functions

**Files:**
- Create: `src/FieldExtractor.js`
- Test: `tests/test_field_extractor.js`

Four TDD cycles, one per function, all in the same two files.

- [ ] **Step 1: Write failing tests for `columnLetterToIndex`**

`tests/test_field_extractor.js`:

```javascript
const assert = require('assert');
const { loadAppsScript } = require('./harness');

const app = loadAppsScript({});

module.exports = {
  'columnLetterToIndex converts letters'() {
    assert.strictEqual(app.columnLetterToIndex('A'), 1);
    assert.strictEqual(app.columnLetterToIndex('C'), 3);
    assert.strictEqual(app.columnLetterToIndex('Z'), 26);
    assert.strictEqual(app.columnLetterToIndex('AA'), 27);
    assert.strictEqual(app.columnLetterToIndex('u'), 21); // case-insensitive
  },
  'columnLetterToIndex rejects invalid input'() {
    assert.throws(() => app.columnLetterToIndex('1'));
    assert.throws(() => app.columnLetterToIndex(''));
  },
};
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node tests/run.js`
Expected: FAIL with `app.columnLetterToIndex is not a function`

- [ ] **Step 3: Implement `columnLetterToIndex`**

`src/FieldExtractor.js`:

```javascript
/** 'A' -> 1, 'C' -> 3, 'AA' -> 27. Throws on anything that isn't letters. */
function columnLetterToIndex(letter) {
  const upper = String(letter).toUpperCase();
  let index = 0;
  for (let i = 0; i < upper.length; i++) {
    const code = upper.charCodeAt(i);
    if (code < 65 || code > 90) throw new Error('Invalid column letter: ' + letter);
    index = index * 26 + (code - 64);
  }
  if (index === 0) throw new Error('Invalid column letter: ' + letter);
  return index;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node tests/run.js`
Expected: all PASS (3 passed total)

- [ ] **Step 5: Write failing tests for `adfToPlainText`**

Append to the exported object in `tests/test_field_extractor.js`:

```javascript
  'adfToPlainText handles null and plain strings'() {
    assert.strictEqual(app.adfToPlainText(null), '');
    assert.strictEqual(app.adfToPlainText(undefined), '');
    assert.strictEqual(app.adfToPlainText('already text'), 'already text');
  },
  'adfToPlainText flattens ADF paragraphs with newlines'() {
    const adf = {
      type: 'doc',
      version: 1,
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'World' }] },
      ],
    };
    assert.strictEqual(app.adfToPlainText(adf), 'Hello\nWorld');
  },
  'adfToPlainText handles hardBreak and nested lists'() {
    const adf = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'line1' },
            { type: 'hardBreak' },
            { type: 'text', text: 'line2' },
          ],
        },
        {
          type: 'bulletList',
          content: [
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'item1' }] }] },
          ],
        },
      ],
    };
    assert.strictEqual(app.adfToPlainText(adf), 'line1\nline2\nitem1');
  },
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `node tests/run.js`
Expected: FAIL with `app.adfToPlainText is not a function`

- [ ] **Step 7: Implement `adfToPlainText`**

Append to `src/FieldExtractor.js`:

```javascript
var BLOCK_NODE_TYPES_ = ['paragraph', 'heading', 'listItem', 'codeBlock', 'blockquote'];

/**
 * Jira Cloud sends descriptions as ADF (Atlassian Document Format).
 * Walks the node tree and joins text content, one line per block node.
 * Plain strings (legacy format) pass through unchanged.
 */
function adfToPlainText(description) {
  if (description == null) return '';
  if (typeof description === 'string') return description;
  return walkAdfNode_(description).replace(/\n+$/, '').replace(/\n{2,}/g, '\n');
}

function walkAdfNode_(node) {
  if (node == null) return '';
  if (node.type === 'text') return node.text || '';
  if (node.type === 'hardBreak') return '\n';
  let out = (node.content || []).map(walkAdfNode_).join('');
  if (BLOCK_NODE_TYPES_.indexOf(node.type) !== -1) out += '\n';
  return out;
}
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `node tests/run.js`
Expected: all PASS (6 passed total)

- [ ] **Step 9: Write failing tests for `pickSprintId`**

Append to the exported object in `tests/test_field_extractor.js`:

```javascript
  'pickSprintId picks the active sprint'() {
    const sprints = [
      { id: 9, state: 'closed' },
      { id: 10, state: 'active' },
      { id: 11, state: 'future' },
    ];
    assert.strictEqual(app.pickSprintId(sprints), 10);
  },
  'pickSprintId falls back to the last sprint when none active'() {
    assert.strictEqual(app.pickSprintId([{ id: 9, state: 'closed' }, { id: 11, state: 'future' }]), 11);
  },
  'pickSprintId handles empty, null, and missing field'() {
    assert.strictEqual(app.pickSprintId([]), '');
    assert.strictEqual(app.pickSprintId(null), '');
    assert.strictEqual(app.pickSprintId(undefined), '');
  },
  'pickSprintId parses legacy string-encoded sprints'() {
    const legacy = [
      'com.atlassian.greenhopper.service.sprint.Sprint@1f[id=9,state=CLOSED,name=S9]',
      'com.atlassian.greenhopper.service.sprint.Sprint@2a[id=10,state=ACTIVE,name=S10]',
    ];
    assert.strictEqual(app.pickSprintId(legacy), 10);
  },
```

- [ ] **Step 10: Run tests to verify they fail**

Run: `node tests/run.js`
Expected: FAIL with `app.pickSprintId is not a function`

- [ ] **Step 11: Implement `pickSprintId`**

Append to `src/FieldExtractor.js`:

```javascript
/**
 * The Jira sprint custom field is an array (an issue can carry sprint history).
 * Per spec: pick the active sprint; if none is active, pick the last entry.
 * Handles both object entries (current Cloud) and legacy "...[id=10,state=ACTIVE,...]" strings.
 */
function pickSprintId(sprintField) {
  if (!Array.isArray(sprintField) || sprintField.length === 0) return '';
  const sprints = sprintField.map(parseSprint_).filter(function (s) {
    return s !== null;
  });
  if (sprints.length === 0) return '';
  const active = sprints.find(function (s) {
    return s.state === 'active';
  });
  return (active || sprints[sprints.length - 1]).id;
}

function parseSprint_(entry) {
  if (entry == null) return null;
  if (typeof entry === 'object') {
    if (entry.id == null) return null;
    return { id: entry.id, state: String(entry.state || '').toLowerCase() };
  }
  if (typeof entry === 'string') {
    const idMatch = entry.match(/\bid=(\d+)/);
    if (!idMatch) return null;
    const stateMatch = entry.match(/\bstate=(\w+)/);
    return { id: Number(idMatch[1]), state: stateMatch ? stateMatch[1].toLowerCase() : '' };
  }
  return null;
}
```

- [ ] **Step 12: Run tests to verify they pass**

Run: `node tests/run.js`
Expected: all PASS (10 passed total)

- [ ] **Step 13: Write failing tests for `formatJiraDate`**

Append to the exported object in `tests/test_field_extractor.js`:

```javascript
  'formatJiraDate formats in the configured timezone'() {
    const cfg = { TIMEZONE: 'Asia/Ho_Chi_Minh', DATE_FORMAT: 'yyyy-MM-dd HH:mm' };
    assert.strictEqual(app.formatJiraDate('2026-06-03T10:30:00.000+0700', cfg), '2026-06-03 10:30');
    // UTC instant converted to UTC+7
    assert.strictEqual(app.formatJiraDate('2026-06-03T03:30:00.000Z', cfg), '2026-06-03 10:30');
  },
  'formatJiraDate handles empty and invalid input'() {
    const cfg = { TIMEZONE: 'Asia/Ho_Chi_Minh', DATE_FORMAT: 'yyyy-MM-dd HH:mm' };
    assert.strictEqual(app.formatJiraDate('', cfg), '');
    assert.strictEqual(app.formatJiraDate(null, cfg), '');
    assert.strictEqual(app.formatJiraDate('not-a-date', cfg), '');
  },
```

- [ ] **Step 14: Run tests to verify they fail**

Run: `node tests/run.js`
Expected: FAIL with `app.formatJiraDate is not a function`

- [ ] **Step 15: Implement `formatJiraDate`**

Append to `src/FieldExtractor.js`:

```javascript
/**
 * In Apps Script, uses Utilities.formatDate with the configured pattern.
 * Under Node (tests), Utilities doesn't exist — falls back to a fixed
 * "yyyy-MM-dd HH:mm" rendering via Intl, which matches the default config.
 */
function formatJiraDate(isoString, config) {
  if (!isoString) return '';
  const date = new Date(isoString);
  if (isNaN(date.getTime())) return '';
  if (typeof Utilities !== 'undefined') {
    return Utilities.formatDate(date, config.TIMEZONE, config.DATE_FORMAT);
  }
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: config.TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = function (type) {
    return parts.find(function (p) {
      return p.type === type;
    }).value;
  };
  return get('year') + '-' + get('month') + '-' + get('day') + ' ' + get('hour') + ':' + get('minute');
}
```

- [ ] **Step 16: Run tests to verify they pass**

Run: `node tests/run.js`
Expected: all PASS (12 passed total)

- [ ] **Step 17: Commit**

```bash
git add src/FieldExtractor.js tests/test_field_extractor.js
git commit -m "feat: add pure field-extraction helpers (columns, ADF, sprint, dates)"
```

---

### Task 3: FieldExtractor — `extractField` dispatcher

**Files:**
- Modify: `src/FieldExtractor.js` (append)
- Test: `tests/test_field_extractor.js` (append)

- [ ] **Step 1: Write failing tests for `extractField`**

Append to the exported object in `tests/test_field_extractor.js`:

```javascript
  'extractField extracts every mapped field from a full issue'() {
    const issue = sampleIssue();
    assert.strictEqual(app.extractField('issueKey', issue, app.CONFIG), 'ABC-123');
    assert.strictEqual(app.extractField('issueType', issue, app.CONFIG), 'Story');
    assert.strictEqual(app.extractField('priority', issue, app.CONFIG), 'High');
    assert.strictEqual(app.extractField('status', issue, app.CONFIG), 'In Progress');
    assert.strictEqual(app.extractField('assignee', issue, app.CONFIG), 'Jane Doe');
    assert.strictEqual(app.extractField('createdDate', issue, app.CONFIG), '2026-06-03 10:30');
    assert.strictEqual(app.extractField('storyPoints', issue, app.CONFIG), 5);
    assert.strictEqual(app.extractField('sprintId', issue, app.CONFIG), 10);
    assert.strictEqual(app.extractField('description', issue, app.CONFIG), 'Hello\nWorld');
  },
  'extractField returns empty string for missing optional fields'() {
    const issue = sampleIssue();
    issue.fields.assignee = null;
    issue.fields.priority = null;
    issue.fields[app.CONFIG.CUSTOM_FIELDS.storyPoints] = null;
    issue.fields[app.CONFIG.CUSTOM_FIELDS.sprint] = null;
    issue.fields.description = null;
    assert.strictEqual(app.extractField('assignee', issue, app.CONFIG), '');
    assert.strictEqual(app.extractField('priority', issue, app.CONFIG), '');
    assert.strictEqual(app.extractField('storyPoints', issue, app.CONFIG), '');
    assert.strictEqual(app.extractField('sprintId', issue, app.CONFIG), '');
    assert.strictEqual(app.extractField('description', issue, app.CONFIG), '');
  },
  'extractField returns empty string for unknown extractor name'() {
    assert.strictEqual(app.extractField('nope', sampleIssue(), app.CONFIG), '');
  },
  'extractField returns empty string when an extractor throws'() {
    // fields: null makes every fields.* access throw
    assert.strictEqual(app.extractField('issueType', { key: 'X-1', fields: null }, app.CONFIG), '');
  },
```

And add this helper at the top of `tests/test_field_extractor.js`, after `const app = loadAppsScript({});`:

```javascript
function sampleIssue() {
  const fields = {
    project: { key: 'ABC' },
    issuetype: { name: 'Story' },
    priority: { name: 'High' },
    status: { name: 'In Progress' },
    assignee: { displayName: 'Jane Doe' },
    created: '2026-06-03T10:30:00.000+0700',
    description: {
      type: 'doc',
      version: 1,
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'World' }] },
      ],
    },
  };
  fields[app.CONFIG.CUSTOM_FIELDS.storyPoints] = 5;
  fields[app.CONFIG.CUSTOM_FIELDS.sprint] = [{ id: 10, state: 'active', name: 'Sprint 10' }];
  return { key: 'ABC-123', fields: fields };
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node tests/run.js`
Expected: FAIL with `app.extractField is not a function`

- [ ] **Step 3: Implement `EXTRACTORS` and `extractField`**

Append to `src/FieldExtractor.js`:

```javascript
// One extractor per logical field. COLUMN_MAP values must name one of these.
// To add a new column: add an entry here (if needed) + one line in COLUMN_MAP.
var EXTRACTORS = {
  issueKey: function (issue) {
    return issue.key;
  },
  issueType: function (issue) {
    return issue.fields.issuetype && issue.fields.issuetype.name;
  },
  priority: function (issue) {
    return issue.fields.priority && issue.fields.priority.name;
  },
  description: function (issue) {
    return adfToPlainText(issue.fields.description);
  },
  status: function (issue) {
    return issue.fields.status && issue.fields.status.name;
  },
  createdDate: function (issue, config) {
    return formatJiraDate(issue.fields.created, config);
  },
  storyPoints: function (issue, config) {
    return issue.fields[config.CUSTOM_FIELDS.storyPoints];
  },
  assignee: function (issue) {
    return issue.fields.assignee && issue.fields.assignee.displayName;
  },
  sprintId: function (issue, config) {
    return pickSprintId(issue.fields[config.CUSTOM_FIELDS.sprint]);
  },
};

/**
 * Runs the named extractor against the webhook issue JSON.
 * Never throws: unknown names and extractor errors log and yield '' so one
 * bad field can't block the rest of the row (spec: error handling).
 */
function extractField(name, issue, config) {
  const fn = EXTRACTORS[name];
  if (!fn) {
    console.log('Unknown extractor in COLUMN_MAP: ' + name);
    return '';
  }
  try {
    const value = fn(issue, config);
    return value == null ? '' : value;
  } catch (err) {
    console.log('Extractor "' + name + '" failed: ' + err);
    return '';
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node tests/run.js`
Expected: all PASS (16 passed total)

- [ ] **Step 5: Commit**

```bash
git add src/FieldExtractor.js tests/test_field_extractor.js
git commit -m "feat: add extractField dispatcher with per-field error isolation"
```

---

### Task 4: SheetWriter — upsert and delete

**Files:**
- Create: `src/SheetWriter.js`
- Create: `tests/fakes.js`
- Test: `tests/test_sheet_writer.js`

- [ ] **Step 1: Write the fakes**

`tests/fakes.js`:

```javascript
/**
 * Minimal in-memory stand-in for an Apps Script Sheet. Backs cells with a
 * 2D array (1-based rows/cols at the API surface, like the real thing).
 * Only implements what SheetWriter.js uses.
 */
class FakeSheet {
  constructor(rows) {
    this.rows = rows.map((r) => r.slice());
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

function fakeSpreadsheetApp(sheetsByName) {
  return {
    getActiveSpreadsheet() {
      return {
        getSheetByName(name) {
          return sheetsByName[name] || null;
        },
      };
    },
  };
}

module.exports = { FakeSheet, fakeSpreadsheetApp };
```

- [ ] **Step 2: Write failing tests for upsert**

`tests/test_sheet_writer.js`:

```javascript
const assert = require('assert');
const { loadAppsScript } = require('./harness');
const { FakeSheet, fakeSpreadsheetApp } = require('./fakes');

// Columns A..U (21 columns). Mapped: A,C,D,E,F,G,L,P,U.
const HEADER = [
  'Sprint', 'Manual', 'Key', 'Type', 'Priority', 'Description', 'Status',
  '', '', '', '', 'Created', '', '', '', 'Points', '', '', '', '', 'Assignee',
];

function makeApp(rows) {
  const sheet = new FakeSheet(rows);
  const app = loadAppsScript({ SpreadsheetApp: fakeSpreadsheetApp({ Issues: sheet }) });
  return { app, sheet };
}

function sampleIssue(app, key) {
  const fields = {
    project: { key: 'ABC' },
    issuetype: { name: 'Story' },
    priority: { name: 'High' },
    status: { name: 'In Progress' },
    assignee: { displayName: 'Jane Doe' },
    created: '2026-06-03T10:30:00.000+0700',
    description: 'plain description',
  };
  fields[app.CONFIG.CUSTOM_FIELDS.storyPoints] = 5;
  fields[app.CONFIG.CUSTOM_FIELDS.sprint] = [{ id: 10, state: 'active' }];
  return { key: key || 'ABC-123', fields: fields };
}

module.exports = {
  'upsertIssue appends a new row with all mapped cells'() {
    const { app, sheet } = makeApp([HEADER]);
    app.upsertIssue(sampleIssue(app));
    assert.strictEqual(sheet.rows.length, 2);
    const row = sheet.rows[1];
    assert.strictEqual(row[0], 10); // A sprint
    assert.strictEqual(row[2], 'ABC-123'); // C key
    assert.strictEqual(row[3], 'Story'); // D type
    assert.strictEqual(row[4], 'High'); // E priority
    assert.strictEqual(row[5], 'plain description'); // F description
    assert.strictEqual(row[6], 'In Progress'); // G status
    assert.strictEqual(row[11], '2026-06-03 10:30'); // L created
    assert.strictEqual(row[15], 5); // P points
    assert.strictEqual(row[20], 'Jane Doe'); // U assignee
  },
  'upsertIssue updates the existing row and preserves unmapped cells'() {
    const existing = ['9', 'manual note', 'ABC-123', 'Story', 'Low', 'old', 'To Do',
      '', '', '', '', 'x', '', '', '', 1, '', '', '', '', 'Old Guy'];
    const { app, sheet } = makeApp([HEADER, existing]);
    app.upsertIssue(sampleIssue(app));
    assert.strictEqual(sheet.rows.length, 2); // no new row
    assert.strictEqual(sheet.rows[1][6], 'In Progress'); // status updated
    assert.strictEqual(sheet.rows[1][4], 'High'); // priority updated
    assert.strictEqual(sheet.rows[1][1], 'manual note'); // column B untouched
  },
  'upsertIssue appends after the last data row'() {
    const other = ['9', '', 'ABC-999', 'Bug', 'Low', '', 'Done',
      '', '', '', '', '', '', '', '', 1, '', '', '', '', ''];
    const { app, sheet } = makeApp([HEADER, other]);
    app.upsertIssue(sampleIssue(app));
    assert.strictEqual(sheet.rows.length, 3);
    assert.strictEqual(sheet.rows[2][2], 'ABC-123');
  },
  'upsertIssue throws a clear error when the tab is missing'() {
    const app = loadAppsScript({ SpreadsheetApp: fakeSpreadsheetApp({}) });
    assert.throws(() => app.upsertIssue(sampleIssue(app)), /Sheet tab not found/);
  },
};
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node tests/run.js`
Expected: FAIL with `app.upsertIssue is not a function`

- [ ] **Step 4: Implement `SheetWriter.js` (upsert only)**

`src/SheetWriter.js`:

```javascript
/** The only file that touches SpreadsheetApp. */

function getSheet_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) throw new Error('Sheet tab not found: ' + CONFIG.SHEET_NAME);
  return sheet;
}

/** Returns the 1-based row index holding issueKey, or null. */
function findRowByKey_(sheet, issueKey) {
  const keyCol = columnLetterToIndex(CONFIG.KEY_COLUMN);
  const lastRow = sheet.getLastRow();
  if (lastRow <= CONFIG.HEADER_ROWS) return null;
  const numRows = lastRow - CONFIG.HEADER_ROWS;
  const values = sheet.getRange(CONFIG.HEADER_ROWS + 1, keyCol, numRows, 1).getValues();
  for (let i = 0; i < values.length; i++) {
    if (values[i][0] === issueKey) return CONFIG.HEADER_ROWS + 1 + i;
  }
  return null;
}

/**
 * Update the row matching the issue key, or append a new one.
 * Writes only the cells in COLUMN_MAP — everything else is preserved.
 */
function upsertIssue(issue) {
  const sheet = getSheet_();
  let row = findRowByKey_(sheet, issue.key);
  if (!row) row = Math.max(sheet.getLastRow(), CONFIG.HEADER_ROWS) + 1;
  for (const letter in CONFIG.COLUMN_MAP) {
    const value = extractField(CONFIG.COLUMN_MAP[letter], issue, CONFIG);
    sheet.getRange(row, columnLetterToIndex(letter)).setValue(value);
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node tests/run.js`
Expected: all PASS (20 passed total)

- [ ] **Step 6: Write failing tests for delete**

Append to the exported object in `tests/test_sheet_writer.js`:

```javascript
  'deleteIssue removes the row in delete mode'() {
    const existing = ['9', '', 'ABC-123', 'Story', 'Low', '', 'To Do',
      '', '', '', '', '', '', '', '', 1, '', '', '', '', ''];
    const { app, sheet } = makeApp([HEADER, existing]);
    app.CONFIG.DELETE_MODE = 'delete';
    app.deleteIssue({ key: 'ABC-123' });
    assert.strictEqual(sheet.rows.length, 1); // only header left
  },
  'deleteIssue marks the status column in mark mode'() {
    const existing = ['9', '', 'ABC-123', 'Story', 'Low', '', 'To Do',
      '', '', '', '', '', '', '', '', 1, '', '', '', '', ''];
    const { app, sheet } = makeApp([HEADER, existing]);
    app.CONFIG.DELETE_MODE = 'mark';
    app.deleteIssue({ key: 'ABC-123' });
    assert.strictEqual(sheet.rows.length, 2); // row kept
    assert.strictEqual(sheet.rows[1][6], 'Deleted'); // G = status column
  },
  'deleteIssue is a no-op for unknown keys'() {
    const { app, sheet } = makeApp([HEADER]);
    app.deleteIssue({ key: 'ABC-404' }); // must not throw
    assert.strictEqual(sheet.rows.length, 1);
  },
```

- [ ] **Step 7: Run tests to verify they fail**

Run: `node tests/run.js`
Expected: FAIL with `app.deleteIssue is not a function`

- [ ] **Step 8: Implement delete**

Append to `src/SheetWriter.js`:

```javascript
/** Per CONFIG.DELETE_MODE: remove the row, or write "Deleted" to the status column. */
function deleteIssue(issue) {
  const sheet = getSheet_();
  const row = findRowByKey_(sheet, issue.key);
  if (!row) return;
  if (CONFIG.DELETE_MODE === 'delete') {
    sheet.deleteRow(row);
  } else {
    sheet.getRange(row, statusColumnIndex_()).setValue('Deleted');
  }
}

function statusColumnIndex_() {
  for (const letter in CONFIG.COLUMN_MAP) {
    if (CONFIG.COLUMN_MAP[letter] === 'status') return columnLetterToIndex(letter);
  }
  throw new Error('DELETE_MODE "mark" requires a status column in COLUMN_MAP');
}
```

- [ ] **Step 9: Run tests to verify they pass**

Run: `node tests/run.js`
Expected: all PASS (23 passed total)

- [ ] **Step 10: Commit**

```bash
git add src/SheetWriter.js tests/fakes.js tests/test_sheet_writer.js
git commit -m "feat: add sheet upsert and configurable delete handling"
```

---

### Task 5: WebApp — doPost, routing, lock

**Files:**
- Create: `src/WebApp.js`
- Test: `tests/test_webapp.js`

- [ ] **Step 1: Write failing tests for `handleWebhook` routing**

`tests/test_webapp.js`:

```javascript
const assert = require('assert');
const { loadAppsScript } = require('./harness');

function makeApp() {
  const app = loadAppsScript({
    ContentService: { createTextOutput: (text) => ({ body: text }) },
  });
  const calls = [];
  // Spy on the SheetWriter entry points — routing tests don't need a sheet.
  app.upsertIssue = (issue) => calls.push(['upsert', issue.key]);
  app.deleteIssue = (issue) => calls.push(['delete', issue.key]);
  return { app, calls };
}

function payload(event, projectKey) {
  return {
    webhookEvent: event,
    issue: { key: 'ABC-123', fields: { project: { key: projectKey || 'ABC' } } },
  };
}

module.exports = {
  'handleWebhook routes created and updated to upsert'() {
    const { app, calls } = makeApp();
    assert.strictEqual(app.handleWebhook(payload('jira:issue_created')), 'upserted');
    assert.strictEqual(app.handleWebhook(payload('jira:issue_updated')), 'upserted');
    assert.deepStrictEqual(calls, [['upsert', 'ABC-123'], ['upsert', 'ABC-123']]);
  },
  'handleWebhook routes deleted to deleteIssue'() {
    const { app, calls } = makeApp();
    assert.strictEqual(app.handleWebhook(payload('jira:issue_deleted')), 'deleted');
    assert.deepStrictEqual(calls, [['delete', 'ABC-123']]);
  },
  'handleWebhook ignores other projects'() {
    const { app, calls } = makeApp();
    assert.strictEqual(app.handleWebhook(payload('jira:issue_created', 'XYZ')), 'ignored');
    assert.deepStrictEqual(calls, []);
  },
  'handleWebhook ignores payloads without an issue'() {
    const { app, calls } = makeApp();
    assert.strictEqual(app.handleWebhook({ webhookEvent: 'comment_created' }), 'ignored');
    assert.deepStrictEqual(calls, []);
  },
  'handleWebhook ignores unknown events'() {
    const { app, calls } = makeApp();
    assert.strictEqual(app.handleWebhook(payload('jira:worklog_updated')), 'ignored');
    assert.deepStrictEqual(calls, []);
  },
};
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node tests/run.js`
Expected: FAIL with `app.handleWebhook is not a function`

- [ ] **Step 3: Implement `handleWebhook` and `withLock_`**

`src/WebApp.js`:

```javascript
/**
 * Routes a parsed webhook payload. Returns a short status string
 * (useful for tests and logs). Throws only on sheet-level errors —
 * doPost catches those.
 */
function handleWebhook(payload) {
  if (!payload || !payload.issue || !payload.issue.fields) {
    console.log('Ignored: payload has no issue');
    return 'ignored';
  }
  const issue = payload.issue;
  const project = issue.fields.project;
  if (!project || project.key !== CONFIG.PROJECT_KEY) {
    console.log('Ignored: project ' + (project && project.key) + ' != ' + CONFIG.PROJECT_KEY);
    return 'ignored';
  }
  switch (payload.webhookEvent) {
    case 'jira:issue_created':
    case 'jira:issue_updated':
      withLock_(function () {
        upsertIssue(issue);
      });
      return 'upserted';
    case 'jira:issue_deleted':
      withLock_(function () {
        deleteIssue(issue);
      });
      return 'deleted';
    default:
      console.log('Ignored: event ' + payload.webhookEvent);
      return 'ignored';
  }
}

/**
 * Serializes sheet writes — near-simultaneous webhooks (bulk edits) would
 * otherwise race findRowByKey_ and append duplicate rows.
 * LockService doesn't exist under Node; tests run the function directly.
 */
function withLock_(fn) {
  if (typeof LockService === 'undefined') return fn();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    console.log('Lock timeout — event dropped');
    return;
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node tests/run.js`
Expected: all PASS (28 passed total)

- [ ] **Step 5: Write failing tests for `doPost`**

Append to the exported object in `tests/test_webapp.js`:

```javascript
  'doPost rejects a bad token without touching the sheet'() {
    const { app, calls } = makeApp();
    const res = app.doPost({ parameter: { token: 'wrong' }, postData: { contents: '{}' } });
    assert.strictEqual(res.body, 'unauthorized');
    assert.deepStrictEqual(calls, []);
  },
  'doPost rejects a missing token'() {
    const { app, calls } = makeApp();
    const res = app.doPost({ parameter: {}, postData: { contents: '{}' } });
    assert.strictEqual(res.body, 'unauthorized');
    assert.deepStrictEqual(calls, []);
  },
  'doPost processes a valid request'() {
    const { app, calls } = makeApp();
    const res = app.doPost({
      parameter: { token: app.CONFIG.SECRET_TOKEN },
      postData: { contents: JSON.stringify(payload('jira:issue_created')) },
    });
    assert.strictEqual(res.body, 'ok');
    assert.deepStrictEqual(calls, [['upsert', 'ABC-123']]);
  },
  'doPost returns ok on malformed JSON (no Jira retry storm)'() {
    const { app, calls } = makeApp();
    const res = app.doPost({
      parameter: { token: app.CONFIG.SECRET_TOKEN },
      postData: { contents: 'not json{{' },
    });
    assert.strictEqual(res.body, 'ok');
    assert.deepStrictEqual(calls, []);
  },
  'doPost returns ok even when the handler throws'() {
    const { app } = makeApp();
    app.upsertIssue = () => {
      throw new Error('sheet exploded');
    };
    const res = app.doPost({
      parameter: { token: app.CONFIG.SECRET_TOKEN },
      postData: { contents: JSON.stringify(payload('jira:issue_created')) },
    });
    assert.strictEqual(res.body, 'ok');
  },
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `node tests/run.js`
Expected: FAIL with `app.doPost is not a function`

- [ ] **Step 7: Implement `doPost`**

Append to `src/WebApp.js`:

```javascript
/**
 * Web app entry point. Jira can't send custom auth headers, so the shared
 * secret travels as ?token= in the webhook URL.
 * Always answers 200 ("ok") after auth — Jira retries failed deliveries,
 * and we don't want a retry storm caused by our own bug.
 */
function doPost(e) {
  if (!e || !e.parameter || e.parameter.token !== CONFIG.SECRET_TOKEN) {
    console.log('Webhook rejected: bad or missing token');
    return ContentService.createTextOutput('unauthorized');
  }
  let payload;
  try {
    payload = JSON.parse(e.postData.contents);
  } catch (err) {
    const snippet = String(e.postData && e.postData.contents).slice(0, 200);
    console.log('Webhook ignored: malformed JSON: ' + snippet);
    return ContentService.createTextOutput('ok');
  }
  try {
    handleWebhook(payload);
  } catch (err) {
    console.log('Webhook handler error: ' + err + (err && err.stack ? '\n' + err.stack : ''));
  }
  return ContentService.createTextOutput('ok');
}
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `node tests/run.js`
Expected: all PASS (33 passed total)

- [ ] **Step 9: Commit**

```bash
git add src/WebApp.js tests/test_webapp.js
git commit -m "feat: add webhook entry point with token auth and event routing"
```

---

### Task 6: Apps Script editor tests (`Test.js`)

**Files:**
- Create: `src/Test.js`

These run inside the Apps Script editor (where Node can't reach): pure extractor assertions plus an opt-in integration test against the real sheet. No Node test for this file — it IS the Apps-Script-side test. Verify it doesn't break the Node suite (harness skips it: not in `SRC_FILES`).

- [ ] **Step 1: Write `src/Test.js`**

```javascript
/**
 * Editor-run tests. Open the Apps Script editor, pick a function, press Run.
 * - testAll(): pure assertions, safe, touches nothing.
 * - testIntegrationUpsert(): writes a fake issue row to the REAL sheet.
 * - testIntegrationCleanup(): removes that row again.
 */

function testAll() {
  testExtractors_();
  console.log('All editor tests passed');
}

function testExtractors_() {
  const issue = sampleEditorIssue_();
  assertEqual_(extractField('issueKey', issue, CONFIG), 'TEST-99999', 'issueKey');
  assertEqual_(extractField('issueType', issue, CONFIG), 'Story', 'issueType');
  assertEqual_(extractField('priority', issue, CONFIG), 'High', 'priority');
  assertEqual_(extractField('status', issue, CONFIG), 'In Progress', 'status');
  assertEqual_(extractField('assignee', issue, CONFIG), 'Jane Doe', 'assignee');
  assertEqual_(extractField('storyPoints', issue, CONFIG), 5, 'storyPoints');
  assertEqual_(extractField('sprintId', issue, CONFIG), 10, 'sprintId');
  assertEqual_(extractField('description', issue, CONFIG), 'Hello\nWorld', 'description');
  if (extractField('createdDate', issue, CONFIG) === '') {
    throw new Error('createdDate: expected a formatted date, got empty string');
  }
}

function testIntegrationUpsert() {
  upsertIssue(sampleEditorIssue_());
  console.log('Upserted TEST-99999 — check the "' + CONFIG.SHEET_NAME + '" tab, then run testIntegrationCleanup');
}

function testIntegrationCleanup() {
  const previousMode = CONFIG.DELETE_MODE;
  CONFIG.DELETE_MODE = 'delete';
  deleteIssue({ key: 'TEST-99999' });
  CONFIG.DELETE_MODE = previousMode;
  console.log('Removed TEST-99999');
}

function sampleEditorIssue_() {
  const fields = {
    project: { key: CONFIG.PROJECT_KEY },
    issuetype: { name: 'Story' },
    priority: { name: 'High' },
    status: { name: 'In Progress' },
    assignee: { displayName: 'Jane Doe' },
    created: '2026-06-03T10:30:00.000+0700',
    description: {
      type: 'doc',
      version: 1,
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'World' }] },
      ],
    },
  };
  fields[CONFIG.CUSTOM_FIELDS.storyPoints] = 5;
  fields[CONFIG.CUSTOM_FIELDS.sprint] = [{ id: 10, state: 'active', name: 'Sprint 10' }];
  return { key: 'TEST-99999', fields: fields };
}

function assertEqual_(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(label + ': expected "' + expected + '" but got "' + actual + '"');
  }
}
```

- [ ] **Step 2: Run the Node suite to confirm nothing broke**

Run: `node tests/run.js`
Expected: all PASS (33 passed, 0 failed)

- [ ] **Step 3: Commit**

```bash
git add src/Test.js
git commit -m "feat: add apps-script editor tests and integration helpers"
```

---

### Task 7: SETUP.md — deployment and webhook guide

**Files:**
- Create: `SETUP.md`

- [ ] **Step 1: Write `SETUP.md`**

```markdown
# Setup Guide

## 1. Create the sheet and Apps Script project

1. Open (or create) the target Google Sheet. Make sure the tab is named `Issues`
   (or change `SHEET_NAME` in the config to match).
2. Menu: **Extensions → Apps Script**. This creates a script bound to the sheet.
3. In the editor, create one script file per file in `src/` (**+ → Script**) and
   paste the contents: `Config`, `FieldExtractor`, `SheetWriter`, `WebApp`, `Test`.
   (Local files are `.js`; the editor shows them as `.gs` — content is identical.)

## 2. Find your custom field IDs

Sprint and Story Points are custom fields whose IDs differ per Jira site.

1. Open in a browser (logged into Jira), replacing the issue key with any real issue:
   `https://YOURORG.atlassian.net/rest/api/2/issue/ABC-1?expand=names`
2. Search the JSON for `"Sprint"` and `"Story point"` inside the `names` block.
   The keys look like `customfield_10020`.
3. Put them in `Config`:

   ```javascript
   CUSTOM_FIELDS: {
     sprint: 'customfield_10020',
     storyPoints: 'customfield_10016',
   },
   ```

## 3. Edit the config

In the `Config` file set:

- `PROJECT_KEY` — your Jira project key (e.g. `ABC`)
- `SHEET_NAME` — the tab name
- `SECRET_TOKEN` — a long random string. Generate one, e.g. in a terminal:
  `openssl rand -hex 32`
- `DELETE_MODE` — `'delete'` (remove the row when the issue is deleted) or
  `'mark'` (keep the row, write `Deleted` into the status column)
- `COLUMN_MAP` — adjust if your columns move. Letter → field name.
- `TIMEZONE` / `DATE_FORMAT` — for the Created Date column.

## 4. Run the editor tests

In the Apps Script editor select `testAll` in the function dropdown and **Run**.
First run asks for permissions — grant them. Expected log: `All editor tests passed`.

Optional: run `testIntegrationUpsert` to write a TEST-99999 row to the real
sheet, check it, then run `testIntegrationCleanup` to remove it.

## 5. Deploy the web app

1. **Deploy → New deployment → Select type: Web app**
2. Description: anything. **Execute as: Me**. **Who has access: Anyone**.
   ("Anyone" is required — Jira is not logged into your Google account.
   The secret token in the URL is what keeps strangers out.)
3. **Deploy**, then copy the **Web app URL** (ends in `/exec`).

> After every code change: **Deploy → Manage deployments → ✏️ Edit →
> Version: New version → Deploy**. This keeps the same URL. Creating a brand
> new deployment changes the URL and breaks the webhook.

## 6. Register the Jira webhook

1. Go to `https://YOURORG.atlassian.net/plugins/servlet/webhooks`
   (Jira admin: **Settings → System → WebHooks**).
2. **Create a WebHook**:
   - **Name:** `Sync to Google Sheet`
   - **URL:** the web app URL plus your token:
     `https://script.google.com/macros/s/DEPLOYMENT_ID/exec?token=YOUR_SECRET_TOKEN`
   - **Issue related events → JQL:** `project = ABC`
   - **Events:** check **Issue: created, updated, deleted**
3. **Create**.

## 7. Test end to end

1. Create an issue in the Jira project → a row should appear in the sheet
   within a few seconds.
2. Change its assignee or story points → the row updates.
3. Transition it (To Do → In Progress) → the status cell updates.
4. Check logs: Apps Script editor → **Executions** (left sidebar). Every
   webhook delivery shows up there with its console output.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| No row appears, no execution logged | Webhook not firing: check the JQL filter and events in Jira's webhook page; Jira shows recent delivery attempts there. Also re-check the URL. |
| Execution logged, says "bad or missing token" | `?token=` in the webhook URL doesn't match `SECRET_TOKEN` in Config. |
| Execution logged, says "Ignored: project ..." | `PROJECT_KEY` doesn't match the issue's project. |
| Sprint or Story point column empty | Wrong custom field ID — redo step 2. |
| Row appears but Created Date looks wrong | Adjust `TIMEZONE` / `DATE_FORMAT` in Config. |
| Jira webhook page shows the delivery as failed/redirected | Apps Script answers with a 302 redirect; Jira follows it and treats delivery as OK. Failures with 4xx/5xx mean the URL is wrong. |
| Changed the code but behavior didn't change | You must publish a **new version** of the existing deployment (step 5 note). |
```

- [ ] **Step 2: Commit**

```bash
git add SETUP.md
git commit -m "docs: add deployment and webhook setup guide"
```

---

### Task 8: README

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write `README.md`**

```markdown
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
```

- [ ] **Step 2: Run the full suite one last time**

Run: `node tests/run.js`
Expected: 33 passed, 0 failed

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: add readme"
```
