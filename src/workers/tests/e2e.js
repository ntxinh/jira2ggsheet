const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { webcrypto } = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const DEV_VARS = path.join(ROOT, '.dev.vars');
const E2E_ENV = path.join(ROOT, '.e2e.env');

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

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${url} failed (${res.status}): ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

function exitedMessage(child) {
  return `wrangler dev exited before becoming ready (code ${child.exitCode}, signal ${child.signalCode})`;
}

function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function startWrangler(port) {
  const child = spawn(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['wrangler', 'dev', '--local', '--port', String(port)],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  );

  child.stdout.on('data', (buf) => process.stdout.write('[wrangler] ' + buf));
  child.stderr.on('data', (buf) => process.stderr.write('[wrangler] ' + buf));
  child.on('error', (err) => console.error('Failed to start wrangler dev: ' + err.message));

  return child;
}

async function waitForWorker(child, localUrl) {
  const started = Date.now();
  while (Date.now() - started < 30000) {
    if (hasExited(child)) {
      throw new Error(exitedMessage(child));
    }
    try {
      const res = await fetch(localUrl);
      const text = await res.text();
      if (res.status === 405 && text === 'Method not allowed') {
        if (hasExited(child)) {
          throw new Error(exitedMessage(child));
        }
        return;
      }
    } catch {}
    await sleep(500);
  }
  throw new Error('Timed out waiting for wrangler dev');
}

async function stopWrangler(child) {
  if (!child || hasExited(child)) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  if (await Promise.race([exited.then(() => true), sleep(3000).then(() => false)])) return;
  child.kill('SIGKILL');
  await Promise.race([exited, sleep(3000)]);
}

function cleanupOnSignal(child) {
  let cleaning = false;
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, async () => {
      if (cleaning) return;
      cleaning = true;
      await stopWrangler(child);
      process.exit(signal === 'SIGINT' ? 130 : 143);
    });
  }
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

async function postWebhook(env, issue, localUrl) {
  const res = await fetch(`${localUrl}?token=${encodeURIComponent(env.SECRET_TOKEN)}`, {
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

  const port = await getFreePort();
  const localUrl = `http://127.0.0.1:${port}`;
  const child = startWrangler(port);
  cleanupOnSignal(child);
  try {
    await waitForWorker(child, localUrl);
    const issue = await fetchJiraIssue(env);
    await postWebhook(env, issue, localUrl);
    console.log(`Posted ${issue.key} to local Worker`);
  } finally {
    await stopWrangler(child);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
