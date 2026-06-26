const assert = require('assert');
const { loadAppsScript } = require('./harness');

module.exports = {
  'CONFIG loads with required keys'() {
    const app = loadAppsScript({});
    assert.strictEqual(typeof app.CONFIG.TEMPLATE_SHEET, 'string');
    assert.strictEqual(typeof app.CONFIG.SPREADSHEET_ID, 'string');
    assert.strictEqual(typeof app.CONFIG.SECRET_TOKEN, 'string');
    assert.strictEqual(typeof app.CONFIG.PROJECT_KEY, 'string');
    assert.ok(app.CONFIG.COLUMN_MAP.C, 'issue key column must be mapped');
    assert.ok(['delete', 'mark'].includes(app.CONFIG.DELETE_MODE));
    assert.strictEqual(typeof app.CONFIG.CUSTOM_FIELDS.sprint, 'string');
    assert.strictEqual(typeof app.CONFIG.CUSTOM_FIELDS.storyPoints, 'string');
  },
};
