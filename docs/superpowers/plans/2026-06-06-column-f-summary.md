# Column F: Description → Summary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Column F of the Issues sheet shows the Jira ticket title (`summary` field) instead of the description; the description extractor and its ADF helpers are removed.

**Architecture:** Google Apps Script webhook receiver (`src/*.js`) tested locally via a Node vm harness (`tests/harness.js` evaluates the src files in one shared scope, like Apps Script's global scope). `CONFIG.COLUMN_MAP` maps sheet columns to extractor names; `EXTRACTORS` in `src/FieldExtractor.js` maps names to functions. The change swaps the column F extractor and deletes dead ADF-parsing code.

**Tech Stack:** Google Apps Script (V8), Node.js built-in `assert` + custom test runner (`node tests/run.js`).

**Spec:** `docs/superpowers/specs/2026-06-06-column-f-summary-design.md`

---

### Task 1: Swap column F to `summary`, remove description/ADF code

**Files:**
- Modify: `tests/test_field_extractor.js`
- Modify: `tests/test_sheet_writer.js`
- Modify: `src/Config.js:14`
- Modify: `src/FieldExtractor.js`

Both node test files must change together with the source: after `COLUMN_MAP` points F at `summary`, the old sheet-writer fixtures (which only set `description`) would write `''` to column F and fail.

- [ ] **Step 1: Update `tests/test_field_extractor.js` — failing tests for `summary`**

In `sampleIssue()`, replace the ADF `description` block (lines 14–21):

```js
    summary: 'Hello World',
```

Delete the three `adfToPlainText` test cases (`'adfToPlainText handles null and plain strings'`, `'adfToPlainText flattens ADF paragraphs with newlines'`, `'adfToPlainText handles hardBreak and nested lists'`).

In `'extractField extracts every mapped field from a full issue'`, replace the `description` assertion:

```js
    assert.strictEqual(app.extractField('summary', issue, app.CONFIG), 'Hello World');
```

In `'extractField returns empty string for missing optional fields'`, replace `issue.fields.description = null;` with `issue.fields.summary = null;` and replace the `description` assertion:

```js
    assert.strictEqual(app.extractField('summary', issue, app.CONFIG), '');
```

- [ ] **Step 2: Update `tests/test_sheet_writer.js` fixtures**

In the `HEADER` constant, change `'Description'` to `'Title'`.

In `sampleIssue()`, replace `description: 'plain description',` with:

```js
    summary: 'plain title',
```

In `'upsertIssue appends a new row with all mapped cells'`, replace the column F assertion:

```js
    assert.strictEqual(row[5], 'plain title'); // F title (summary)
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node tests/run.js`
Expected: FAIL — `summary` extractor unknown, `extractField('summary', ...)` returns `''` instead of `'Hello World'`; sheet-writer column F assertion gets `''` instead of `'plain title'`.

- [ ] **Step 4: Implement source changes**

`src/Config.js` line 14, inside `COLUMN_MAP`:

```js
    F: 'summary',
```

`src/FieldExtractor.js`:

Delete `BLOCK_NODE_TYPES_`, `adfToPlainText`, and `walkAdfNode_` (lines 14–29 — no remaining callers).

In `EXTRACTORS`, replace the `description` entry:

```js
  summary: function (issue) {
    return issue.fields.summary;
  },
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node tests/run.js`
Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/Config.js src/FieldExtractor.js tests/test_field_extractor.js tests/test_sheet_writer.js
git commit -m "feat: column F shows ticket title (summary) instead of description"
```

### Task 2: Update editor tests and README

**Files:**
- Modify: `src/Test.js`
- Modify: `README.md:18`

`src/Test.js` runs only inside the Apps Script editor (the node harness does not load it), so it gets no node-test step — verification is the editor smoke test after deploy.

- [ ] **Step 1: Update `src/Test.js`**

In `sampleEditorIssue_()`, replace the ADF `description` block (lines 49–56):

```js
    summary: 'Hello World',
```

In `testExtractors_()`, replace the `description` assertion (line 22):

```js
  assertEqual_(extractField('summary', issue, CONFIG), 'Hello World', 'summary');
```

- [ ] **Step 2: Update `README.md` line 18**

```markdown
| `src/FieldExtractor.js` | Webhook JSON → cell values (sprint arrays, dates) |
```

- [ ] **Step 3: Run node tests to confirm nothing broke**

Run: `node tests/run.js`
Expected: all tests PASS (Test.js is not loaded, but confirms the repo is green before commit).

- [ ] **Step 4: Commit**

```bash
git add src/Test.js README.md
git commit -m "test: update editor tests and README for summary extractor"
```

### Manual follow-up (not in code)

- After deploying to Apps Script, rename the column F header cell in the real spreadsheet from "Description" to "Title".
- Optional editor smoke test: run `testAll()` in the Apps Script editor.
