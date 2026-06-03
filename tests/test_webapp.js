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
};
