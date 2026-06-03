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
