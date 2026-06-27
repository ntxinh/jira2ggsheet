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
