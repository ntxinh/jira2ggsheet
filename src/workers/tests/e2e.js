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
