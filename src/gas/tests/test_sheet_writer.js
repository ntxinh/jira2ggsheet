const assert = require('assert');
const { loadAppsScript } = require('./harness');
const { FakeSheet, fakeSpreadsheetApp } = require('./fakes');

// Columns A..U (21 columns). Mapped: A,C,D,E,F,G,L,P,U.
const HEADER = [
  'Sprint', 'Manual', 'Key', 'Type', 'Priority', 'Title', 'Status',
  '', '', '', '', 'Created', '', '', '', 'Points', '', '', '', '', 'Assignee',
];

function makeSheets(sheetSpecs) {
  return sheetSpecs.map((s) => new FakeSheet(s.rows, s.name));
}

function makeApp(sheetSpecs, options) {
  const spreadsheetApp = fakeSpreadsheetApp(makeSheets(sheetSpecs), options);
  const app = loadAppsScript({ SpreadsheetApp: spreadsheetApp });
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
  'upsertIssue writes to CONFIG.SPREADSHEET_ID when configured'() {
    const targetSheets = makeSheets([{ name: 'Template', rows: [HEADER] }]);
    const activeRow = ['10', 'active sentinel', 'ABC-123', 'Bug', 'Low', 'active title', 'To Do',
      '', '', '', '', 'active date', '', '', '', 1, '', '', '', '', 'Active User'];
    const expectedActiveRow = activeRow.slice();
    const { app, ss } = makeApp(
      [
        { name: 'Template', rows: [HEADER] },
        { name: '10_Sprint 10', rows: [HEADER, activeRow] },
      ],
      { spreadsheetsById: { sheet123: targetSheets } }
    );
    app.CONFIG.SPREADSHEET_ID = 'sheet123';
    app.upsertIssue(sampleIssue(app));
    assert.deepStrictEqual(tabNamed(ss, '10_Sprint 10').rows[1], expectedActiveRow); // active spreadsheet untouched
    const targetSs = app.SpreadsheetApp._spreadsheetsById.sheet123;
    const sheet = tabNamed(targetSs, '10_Sprint 10');
    assert.ok(sheet, 'sprint tab created in configured spreadsheet');
    assert.strictEqual(sheet.rows[1][2], 'ABC-123');
    assert.ok(app.SpreadsheetApp.openedIds.includes('sheet123'));
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
    const targetSheet = tabNamed(targetSs, '10_Sprint 10');
    assert.strictEqual(targetSheet.rows.length, 1);
    assert.deepStrictEqual(targetSheet.rows[0], HEADER);
    assert.strictEqual(targetSheet.rows.some((row) => row[2] === 'ABC-123'), false);
    assert.ok(app.SpreadsheetApp.openedIds.includes('sheet123'));
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
  'deleteIssue marks the row across multiple sprint tabs'() {
    const here = ['11', '', 'ABC-123', 'Story', 'Low', '', 'To Do',
      '', '', '', '', '', '', '', '', 1, '', '', '', '', ''];
    const { app, ss } = makeApp([
      { name: 'Template', rows: [HEADER] },
      { name: '10_Sprint 10', rows: [HEADER] },
      { name: '11_Sprint 11', rows: [HEADER, here] },
    ]);
    app.CONFIG.DELETE_MODE = 'mark';
    app.deleteIssue({ key: 'ABC-123' });
    const sheet = tabNamed(ss, '11_Sprint 11');
    assert.strictEqual(sheet.rows.length, 2); // row kept
    assert.strictEqual(sheet.rows[1][6], 'Deleted'); // G = status column
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
