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
