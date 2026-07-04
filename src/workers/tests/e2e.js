const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { webcrypto } = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const WRANGLER_CONFIG = path.join(ROOT, 'wrangler.jsonc');
const DEV_VARS = path.join(ROOT, '.dev.vars');
const E2E_ENV = path.join(ROOT, '.e2e.env');

function stripJsonComments(input) {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    const next = input[i + 1];
    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
    } else if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === '/' && next === '/') {
      while (i < input.length && input[i] !== '\n') i += 1;
      out += '\n';
    } else if (ch === '/' && next === '*') {
      i += 2;
      while (i < input.length && !(input[i] === '*' && input[i + 1] === '/')) i += 1;
      i += 1;
    } else {
      out += ch;
    }
  }
  return out;
}

function parseWranglerVars() {
  if (!fs.existsSync(WRANGLER_CONFIG)) return {};
  return JSON.parse(stripJsonComments(fs.readFileSync(WRANGLER_CONFIG, 'utf8'))).vars || {};
}

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

function base64UrlEncode(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function pemToArrayBuffer(pem) {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s/g, '');
  const buf = Buffer.from(b64, 'base64');
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

async function getGoogleToken(env) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64UrlEncode(
    JSON.stringify({
      iss: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
      aud: 'https://oauth2.googleapis.com/token',
      exp: now + 3600,
      iat: now,
    }),
  );
  const unsigned = `${header}.${payload}`;
  const key = await webcrypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(env.GOOGLE_PRIVATE_KEY),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await webcrypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    Buffer.from(unsigned),
  );
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${base64UrlEncode(signature)}`,
    }),
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(`Google OAuth failed (${res.status}): ${JSON.stringify(json)}`);
  }
  return json.access_token;
}

function sheetsGet(token, url) {
  return fetchJson(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

function issueVerification(issue, vars) {
  const columns = JSON.parse(vars.COLUMN_MAP_JSON || '{}');
  const summaryColumn = Object.keys(columns).find((column) => columns[column] === 'summary');
  if (summaryColumn) {
    return { column: summaryColumn, expected: String(issue.fields.summary ?? '') };
  }
  const statusColumn = Object.keys(columns).find((column) => columns[column] === 'status');
  if (statusColumn) {
    return { column: statusColumn, expected: issue.fields.status?.name ?? '' };
  }
  console.warn('No summary/status column mapped; falling back to key-only Sheets verification');
  return null;
}

async function findIssueInSheet(env, vars, token, issue, verification) {
  const issueKey = issue.key;
  const id = encodeURIComponent(env.SPREADSHEET_ID);
  const metadata = await sheetsGet(token, `https://sheets.googleapis.com/v4/spreadsheets/${id}`);
  const titles = (metadata.sheets || [])
    .map((sheet) => sheet.properties && sheet.properties.title)
    .filter((title) => title && title !== vars.TEMPLATE_SHEET && /^\d+_/.test(title));

  for (const title of titles) {
    const range = encodeURIComponent(`${title}!${vars.KEY_COLUMN}:${vars.KEY_COLUMN}`);
    const keyData = await sheetsGet(
      token,
      `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${range}`,
    );
    const rowIndexes = (keyData.values || [])
      .map((row, index) => (row[0] === issueKey ? index : -1))
      .filter((index) => index !== -1);
    if (!rowIndexes.length) continue;
    if (!verification) {
      return title;
    }
    const verifyRange = encodeURIComponent(`${title}!${verification.column}:${verification.column}`);
    const verifyData = await sheetsGet(
      token,
      `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${verifyRange}`,
    );
    if (
      rowIndexes.some(
        (rowIndex) => String((verifyData.values || [])[rowIndex]?.[0] ?? '') === verification.expected,
      )
    ) {
      return title;
    }
  }
  return null;
}

async function waitForIssueInSheet(env, vars, issue) {
  let token;
  const verification = issueVerification(issue, vars);
  let lastError;
  for (let i = 0; i < 12; i += 1) {
    try {
      token ||= await getGoogleToken(env);
      const title = await findIssueInSheet(env, vars, token, issue, verification);
      if (title) return title;
    } catch (err) {
      lastError = err;
    }
    await sleep(2500);
  }
  if (lastError) throw lastError;
  throw new Error(`Issue key ${issue.key} not found in sprint sheets`);
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
    ...parseWranglerVars(),
    ...parseEnvFile(DEV_VARS),
    ...parseEnvFile(E2E_ENV),
    ...process.env,
  };

  required(env, [
    'SECRET_TOKEN',
    'GOOGLE_SERVICE_ACCOUNT_EMAIL',
    'GOOGLE_PRIVATE_KEY',
    'SPREADSHEET_ID',
    'KEY_COLUMN',
    'TEMPLATE_SHEET',
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
    const sheetTitle = await waitForIssueInSheet(env, env, issue);
    console.log(`PASS e2e: ${issue.key} found in ${sheetTitle}`);
  } finally {
    await stopWrangler(child);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
