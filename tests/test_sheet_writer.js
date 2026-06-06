const assert = require('assert');
const { loadAppsScript } = require('./harness');
const { FakeSheet, fakeSpreadsheetApp } = require('./fakes');

// Columns A..U (21 columns). Mapped: A,C,D,E,F,G,L,P,U.
const HEADER = [
  'Sprint', 'Manual', 'Key', 'Type', 'Priority', 'Title', 'Status',
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
    summary: 'plain title',
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
    assert.strictEqual(row[5], 'plain title'); // F title (summary)
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
};
