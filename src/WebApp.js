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
