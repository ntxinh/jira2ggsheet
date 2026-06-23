const assert = require('assert');
const { loadAppsScript } = require('./harness');

const app = loadAppsScript({});

function sampleIssue() {
  const fields = {
    project: { key: 'ABC' },
    issuetype: { name: 'Story' },
    priority: { name: 'High' },
    status: { name: 'In Progress' },
    assignee: { displayName: 'Jane Doe' },
    created: '2026-06-03T10:30:00.000+0700',
    summary: 'Hello World',
  };
  fields[app.CONFIG.CUSTOM_FIELDS.storyPoints] = 5;
  fields[app.CONFIG.CUSTOM_FIELDS.sprint] = [{ id: 10, state: 'active', name: 'Sprint 10' }];
  return { key: 'ABC-123', fields: fields };
}

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
    assert.strictEqual(app.extractField('summary', issue, app.CONFIG), 'Hello World');
  },
  'extractField returns empty string for missing optional fields'() {
    const issue = sampleIssue();
    issue.fields.assignee = null;
    issue.fields.priority = null;
    issue.fields[app.CONFIG.CUSTOM_FIELDS.storyPoints] = null;
    issue.fields[app.CONFIG.CUSTOM_FIELDS.sprint] = null;
    issue.fields.summary = null;
    assert.strictEqual(app.extractField('assignee', issue, app.CONFIG), '');
    assert.strictEqual(app.extractField('priority', issue, app.CONFIG), '');
    assert.strictEqual(app.extractField('storyPoints', issue, app.CONFIG), '');
    assert.strictEqual(app.extractField('sprintId', issue, app.CONFIG), '');
    assert.strictEqual(app.extractField('summary', issue, app.CONFIG), '');
  },
  'extractField returns empty string for unknown extractor name'() {
    assert.strictEqual(app.extractField('nope', sampleIssue(), app.CONFIG), '');
  },
  'extractField returns empty string when an extractor throws'() {
    // fields: null makes every fields.* access throw
    assert.strictEqual(app.extractField('issueType', { key: 'X-1', fields: null }, app.CONFIG), '');
  },
  'pickSprint returns the full active sprint object'() {
    const sprints = [
      { id: 9, state: 'closed', name: 'S9' },
      { id: 10, state: 'active', name: 'Sprint 10' },
      { id: 11, state: 'future', name: 'S11' },
    ];
    assert.deepEqual(app.pickSprint(sprints), { id: 10, name: 'Sprint 10', state: 'active' });
  },
  'pickSprint falls back to the last sprint when none active'() {
    const sprints = [{ id: 9, state: 'closed', name: 'S9' }, { id: 11, state: 'future', name: 'S11' }];
    assert.deepEqual(app.pickSprint(sprints), { id: 11, name: 'S11', state: 'future' });
  },
  'pickSprint returns null for empty, null, and missing field'() {
    assert.strictEqual(app.pickSprint([]), null);
    assert.strictEqual(app.pickSprint(null), null);
    assert.strictEqual(app.pickSprint(undefined), null);
  },
  'pickSprint parses name from legacy string-encoded sprints'() {
    const legacy = ['com.atlassian.greenhopper.service.sprint.Sprint@2a[id=10,state=ACTIVE,name=Sprint 10]'];
    assert.deepEqual(app.pickSprint(legacy), { id: 10, name: 'Sprint 10', state: 'active' });
  },
  'pickSprint defaults name to empty string when absent'() {
    assert.deepEqual(app.pickSprint([{ id: 5, state: 'active' }]), { id: 5, name: '', state: 'active' });
  },
};
