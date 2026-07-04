const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { webcrypto } = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const DEV_VARS = path.join(ROOT, '.dev.vars');
const E2E_ENV = path.join(ROOT, '.e2e.env');
const LOCAL_URL = 'http://127.0.0.1:8787';

function parseEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value.replace(/\\n/g, '\n');
  }
  return out;
}

function required(env, names) {
  const missing = names.filter((name) => !env[name]);
  if (missing.length) {
    throw new Error('Missing required env values: ' + missing.join(', '));
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${url} failed (${res.status}): ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

function startWrangler() {
  const child = spawn(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['wrangler', 'dev', '--local', '--port', '8787'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  );

  child.stdout.on('data', (buf) => process.stdout.write('[wrangler] ' + buf));
  child.stderr.on('data', (buf) => process.stderr.write('[wrangler] ' + buf));

  return child;
}

async function waitForWorker(child) {
  const started = Date.now();
  while (Date.now() - started < 30000) {
    if (child.exitCode !== null) {
      throw new Error('wrangler dev exited before becoming ready');
    }
    try {
      const res = await fetch(LOCAL_URL);
      if (res.status === 405 || res.status === 401 || res.status === 200) return;
    } catch {}
    await sleep(500);
  }
  throw new Error('Timed out waiting for wrangler dev');
}

async function stopWrangler(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    sleep(3000).then(() => child.kill('SIGKILL')),
  ]);
}

async function fetchJiraIssue(env) {
  const base = env.JIRA_BASE_URL.replace(/\/+$/, '');
  const auth = Buffer.from(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`).toString('base64');
  return fetchJson(`${base}/rest/api/2/issue/${encodeURIComponent(env.JIRA_ISSUE_KEY)}`, {
    headers: {
      Accept: 'application/json',
      Authorization: `Basic ${auth}`,
    },
  });
}

async function postWebhook(env, issue) {
  const res = await fetch(`${LOCAL_URL}?token=${encodeURIComponent(env.SECRET_TOKEN)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      webhookEvent: 'jira:issue_updated',
      issue,
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`local Worker failed (${res.status}): ${text}`);
  }
}

async function main() {
  const env = {
    ...parseEnvFile(DEV_VARS),
    ...parseEnvFile(E2E_ENV),
    ...process.env,
  };

  required(env, [
    'SECRET_TOKEN',
    'GOOGLE_SERVICE_ACCOUNT_EMAIL',
    'GOOGLE_PRIVATE_KEY',
    'SPREADSHEET_ID',
    'JIRA_BASE_URL',
    'JIRA_EMAIL',
    'JIRA_API_TOKEN',
    'JIRA_ISSUE_KEY',
  ]);

  const child = startWrangler();
  try {
    await waitForWorker(child);
    const issue = await fetchJiraIssue(env);
    await postWebhook(env, issue);
    console.log(`Posted ${issue.key} to local Worker`);
  } finally {
    await stopWrangler(child);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
