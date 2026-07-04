# Workers Real Local E2E Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `npm run test:e2e` for `src/workers` that runs `wrangler dev` locally, fetches a real Jira issue, posts it to the local Worker, and verifies the issue key in Google Sheets.

**Architecture:** One dependency-free Node script owns the e2e orchestration. It reads local env files, starts Wrangler, fetches Jira, posts the webhook, then uses Google OAuth and Sheets API for verification.

**Tech Stack:** Node.js built-ins, global `fetch`, `child_process.spawn`, `crypto.webcrypto`, Wrangler, Jira REST API, Google OAuth, Google Sheets API.

---

## File Map

- Create: `src/workers/tests/e2e.js`
  - Plain Node e2e runner. Handles env parsing, Wrangler lifecycle, Jira fetch, local Worker POST, Google OAuth, Sheets verification.
- Modify: `src/workers/package.json`
  - Add `test:e2e` script.
- Modify: `.gitignore`
  - Ignore `.e2e.env`.
- No change: `src/workers/index.ts`, `src/workers/auth.ts`, `src/workers/sheetWriter.ts`
  - E2E should exercise current Worker behavior, not add test hooks.

---

### Task 1: Add E2E Script Entry And Gitignore

**Files:**
- Modify: `src/workers/package.json`
- Modify: `.gitignore`

- [ ] **Step 1: Add npm script**

Edit `src/workers/package.json` so `scripts` becomes:

```json
{
  "dev": "wrangler dev",
  "deploy": "wrangler deploy",
  "typecheck": "tsc --noEmit",
  "test:e2e": "node tests/e2e.js"
}
```

- [ ] **Step 2: Ignore Jira e2e env file**

Edit `.gitignore` to include:

```gitignore
.e2e.env
```

Keep existing entries unchanged.

- [ ] **Step 3: Run script before file exists to confirm wiring**

Run:

```bash
rtk npm run test:e2e
```

from `src/workers`.

Expected:

```text
Cannot find module
```

- [ ] **Step 4: Commit**

```bash
rtk git add .gitignore src/workers/package.json
rtk git commit -m "test: add worker e2e script entry"
```

---

### Task 2: Create E2E Runner Skeleton

**Files:**
- Create: `src/workers/tests/e2e.js`

- [ ] **Step 1: Create skeleton with env loading and required checks**

Create `src/workers/tests/e2e.js`:

```javascript
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

  console.log('Loaded e2e env');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
```

- [ ] **Step 2: Run missing-env check**

Run:

```bash
rtk npm run test:e2e
```

from `src/workers` without `.e2e.env` if local secrets are absent.

Expected:

```text
Missing required env values:
```

If all env files already exist, expected:

```text
Loaded e2e env
```

- [ ] **Step 3: Commit**

```bash
rtk git add src/workers/tests/e2e.js
rtk git commit -m "test: add worker e2e runner skeleton"
```

---

### Task 3: Add Jira Fetch And Wrangler Lifecycle

**Files:**
- Modify: `src/workers/tests/e2e.js`

- [ ] **Step 1: Replace script with Jira fetch and local Worker POST**

Replace `src/workers/tests/e2e.js` with:

```javascript
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
    } catch {
      await sleep(500);
    }
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
```

- [ ] **Step 2: Run local post path**

Run:

```bash
rtk npm run test:e2e
```

from `src/workers`.

Expected if env is valid:

```text
Posted <ISSUE_KEY> to local Worker
```

Expected if Jira credentials are invalid:

```text
/rest/api/2/issue/ failed (401):
```

- [ ] **Step 3: Commit**

```bash
rtk git add src/workers/tests/e2e.js
rtk git commit -m "test: post real Jira issue to local worker"
```

---

### Task 4: Add Google Sheets Verification

**Files:**
- Modify: `src/workers/tests/e2e.js`

- [ ] **Step 1: Replace script with full e2e verification**

Replace `src/workers/tests/e2e.js` with:

```javascript
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { webcrypto } = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const DEV_VARS = path.join(ROOT, '.dev.vars');
const E2E_ENV = path.join(ROOT, '.e2e.env');
const WRANGLER_CONFIG = path.join(ROOT, 'wrangler.jsonc');
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

function parseWranglerVars() {
  const text = fs.readFileSync(WRANGLER_CONFIG, 'utf8');
  const json = text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '');
  return JSON.parse(json).vars || {};
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
    } catch {
      await sleep(500);
    }
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

function base64UrlEncode(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function pemToArrayBuffer(pem) {
  const clean = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s/g, '');
  return Buffer.from(clean, 'base64');
}

async function getGoogleToken(env) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  };

  const enc = (obj) => base64UrlEncode(Buffer.from(JSON.stringify(obj)));
  const input = `${enc(header)}.${enc(claim)}`;
  const key = await webcrypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(env.GOOGLE_PRIVATE_KEY),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await webcrypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    key,
    Buffer.from(input),
  );
  const jwt = `${input}.${base64UrlEncode(Buffer.from(sig))}`;

  const data = await fetchJson('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  return data.access_token;
}

async function sheetsGet(token, url) {
  return fetchJson(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });
}

async function findIssueInSheet(env, vars, issueKey) {
  const token = await getGoogleToken(env);
  const id = env.SPREADSHEET_ID;
  const meta = await sheetsGet(token, `https://sheets.googleapis.com/v4/spreadsheets/${id}`);
  const sheets = (meta.sheets || [])
    .map((sheet) => sheet.properties.title)
    .filter((title) => title !== vars.TEMPLATE_SHEET && /^\d+_/.test(title));

  for (const title of sheets) {
    const range = encodeURIComponent(`${title}!${vars.KEY_COLUMN}:${vars.KEY_COLUMN}`);
    const data = await sheetsGet(
      token,
      `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${range}`,
    );
    const values = (data.values || []).map((row) => row[0] || '');
    if (values.includes(issueKey)) return title;
  }

  return null;
}

async function waitForIssueInSheet(env, vars, issueKey) {
  for (let i = 0; i < 12; i++) {
    const title = await findIssueInSheet(env, vars, issueKey);
    if (title) return title;
    await sleep(2500);
  }
  throw new Error(`Issue key ${issueKey} not found in sprint sheets`);
}

async function main() {
  const vars = parseWranglerVars();
  const env = {
    ...vars,
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
    'KEY_COLUMN',
    'TEMPLATE_SHEET',
  ]);

  const child = startWrangler();
  try {
    await waitForWorker(child);
    const issue = await fetchJiraIssue(env);
    await postWebhook(env, issue);
    const sheetTitle = await waitForIssueInSheet(env, env, issue.key);
    console.log(`PASS e2e: ${issue.key} found in ${sheetTitle}`);
  } finally {
    await stopWrangler(child);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
```

- [ ] **Step 2: Run full e2e test**

Run:

```bash
rtk npm run test:e2e
```

from `src/workers`.

Expected success:

```text
PASS e2e: <ISSUE_KEY> found in <SPRINT_SHEET>
```

Expected failure if real issue has no sprint:

```text
Issue key <ISSUE_KEY> not found in sprint sheets
```

Fix by setting `JIRA_ISSUE_KEY` to an issue assigned to a sprint.

- [ ] **Step 3: Run typecheck**

Run:

```bash
rtk npm run typecheck
```

from `src/workers`.

Expected:

```text
no output and exit 0
```

- [ ] **Step 4: Commit**

```bash
rtk git add src/workers/tests/e2e.js
rtk git commit -m "test: verify worker e2e through google sheets"
```

---

### Task 5: Document Local E2E Usage

**Files:**
- Modify: `README.md`
- Modify: `SETUP.md`

- [ ] **Step 1: Add README command**

In `README.md`, under `Development - Cloudflare Worker`, add:

```markdown
npm run test:e2e                # local Worker + real Jira + real Google Sheets
```

- [ ] **Step 2: Add SETUP e2e section**

In `SETUP.md`, under `Option A: Cloudflare Worker`, add this subsection after `npm install`:

````markdown
### Local real e2e test

Create `src/workers/.dev.vars` with the same secrets used by the Worker:

```dotenv
SECRET_TOKEN=...
GOOGLE_SERVICE_ACCOUNT_EMAIL=...
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
SPREADSHEET_ID=...
```

Create `src/workers/.e2e.env` with Jira read credentials:

```dotenv
JIRA_BASE_URL=https://YOURORG.atlassian.net
JIRA_EMAIL=you@example.com
JIRA_API_TOKEN=...
JIRA_ISSUE_KEY=ABC-123
```

Use an issue assigned to a sprint. The test writes or updates that issue row in the configured spreadsheet.

Run:

```bash
cd src/workers
npm run test:e2e
```
````

- [ ] **Step 3: Run docs grep for secret leakage**

Run:

```bash
rtk rg -n "AIza|BEGIN PRIVATE KEY|JIRA_API_TOKEN=.*[A-Za-z0-9_-]{20}|SECRET_TOKEN=.*[A-Za-z0-9_-]{20}" README.md SETUP.md src/workers/tests/e2e.js
```

Expected:

```text
no output
```

- [ ] **Step 4: Commit**

```bash
rtk git add README.md SETUP.md
rtk git commit -m "docs: add worker local e2e instructions"
```

---

### Task 6: Final Verification

**Files:**
- Read: repository status and recent commits

- [ ] **Step 1: Run final typecheck**

Run:

```bash
rtk npm run typecheck
```

from `src/workers`.

Expected:

```text
no output and exit 0
```

- [ ] **Step 2: Run final e2e if secrets exist**

Run:

```bash
rtk npm run test:e2e
```

from `src/workers`.

Expected success:

```text
PASS e2e: <ISSUE_KEY> found in <SPRINT_SHEET>
```

If local secret files are missing, record this exact blocker in the final response:

```text
Missing required env values:
```

- [ ] **Step 3: Check git status**

Run:

```bash
rtk git status --short
```

Expected:

```text
 M src/workers/wrangler.jsonc
```

Only the pre-existing `src/workers/wrangler.jsonc` change should remain uncommitted unless the user asks to include it.
