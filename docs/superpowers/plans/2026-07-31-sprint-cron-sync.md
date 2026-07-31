# Nightly Sprint Cron Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `scheduled` handler to the existing Cloudflare Worker that runs at midnight UTC and upserts every issue in a configured sprint into its per-sprint tab.

**Architecture:** Cron trigger (`0 0 * * *`) fires `scheduled`, which runs a paginated Jira JQL search (Basic auth, `fields=*all`) and feeds each result into the existing `upsertIssue` Google Sheets path. The default export becomes `{ fetch: app.fetch, scheduled }` so webhooks and cron share one worker.

**Tech Stack:** Cloudflare Workers (`scheduled` + crons), Hono, Jira REST API v3 (`/rest/api/3/search/jql`), Google Sheets API v4 (existing), vitest.

## Global Constraints

- No new npm dependencies.
- Working dir for all commands: `src/workers/`.
- `upsertIssue` signature (existing, unchanged): `(spreadsheetId: string, issue: JiraIssue, token: string, config: Config) => Promise<void>`.
- `withToken` signature (existing, unchanged): `(email: string, privateKey: string, fn: (token: string) => Promise<void>) => Promise<void>`.
- All new env vars go on the `Env` interface in `src/workers/config.ts`; plain vars also on `Config` and in `wrangler.jsonc` `vars`.
- Cron fires at midnight UTC. Do not consult `TIMEZONE`.
- JQL: `project = {PROJECT_KEY} AND sprint = {SPRINT_ID} ORDER BY created ASC`.

---

### Task 1: Config plumbing

**Files:**
- Modify: `src/workers/config.ts:18-34` (Env interface)
- Modify: `src/workers/config.ts:1-16` (Config interface)
- Modify: `src/workers/wrangler.jsonc`
- Modify: `src/workers/.dev.vars.example`
- Modify: `src/workers/tests/mock-env.ts`

**Interfaces:**
- Consumes: existing `Env`/`Config` shapes.
- Produces: `Config.SPRINT_ID: string`, `Env.SPRINT_ID: string`, `Env.JIRA_EMAIL: string`, `Env.JIRA_API_TOKEN: string`.

- [ ] **Step 1: Add fields to `Config` and `Env`**

In `src/workers/config.ts`, add `SPRINT_ID: string;` to the `Config` interface (after `PROJECT_KEY`), and `SPRINT_ID: string; JIRA_EMAIL: string; JIRA_API_TOKEN: string;` to the `Env` interface (after `JIRA_SUBDOMAIN`).

In `getConfig`, add `SPRINT_ID: env.SPRINT_ID,` next to `PROJECT_KEY`.

- [ ] **Step 2: Add cron trigger and vars to `wrangler.jsonc`**

Add to the vars object:

```jsonc
"SPRINT_ID": "42",
```

Add a top-level `triggers` block:

```jsonc
"triggers": {
  "crons": ["0 0 * * *"]
},
```

Use your real sprint id (from the Jira sprint URL `/agile/1.0/sprint/<id>`) instead of `42` — or leave `42` and set it before deploy.

- [ ] **Step 3: Document new vars in `.dev.vars.example`**

Append:

```
JIRA_EMAIL=your-jira-email@example.com
JIRA_API_TOKEN=your-atlassian-api-token
SPRINT_ID=42
```

- [ ] **Step 4: Extend `testEnv`**

In `src/workers/tests/mock-env.ts`, add the three fields (they are now required by the `Env` type):

```ts
JIRA_EMAIL: 'jira@example.com',
JIRA_API_TOKEN: 'jira-token',
SPRINT_ID: '42',
```

- [ ] **Step 5: Verify typecheck and existing tests pass**

Run: `npm run typecheck && npm test`
Expected: typecheck clean, all existing tests green. This confirms the `Env`/`Config` changes are wired everywhere.

- [ ] **Step 6: Commit**

```bash
git add src/workers/config.ts src/workers/wrangler.jsonc src/workers/.dev.vars.example src/workers/tests/mock-env.ts
git commit -m "chore: add sprint cron env config"
```

---

### Task 2: Jira search client

**Files:**
- Create: `src/workers/jira.ts`
- Create: `src/workers/tests/jira.test.ts`

**Interfaces:**
- Consumes: `JiraIssue` from `./fieldExtractor` (already exported).
- Produces: `searchIssues(jql: string, subdomain: string, email: string, apiToken: string): Promise<JiraIssue[]>` — paginated; throws on non-OK response with `Jira search {status}: {body}`.

- [ ] **Step 1: Write the failing test**

Create `src/workers/tests/jira.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { searchIssues } from '../jira'
import type { JiraIssue } from '../fieldExtractor'

const issue = (key: string): JiraIssue => ({ key, fields: { summary: key } })

afterEach(() => { vi.unstubAllGlobals() })

describe('searchIssues', () => {
  it('builds URL and Basic auth header, paginates to total', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> })
      const startAt = Number(new URL(url).searchParams.get('startAt'))
      const total = 150
      const issues = Array.from({ length: 100 }, (_, i) => issue(`ABC-${startAt + i + 1}`))
      return new Response(JSON.stringify({ issues, total }))
    }))

    const result = await searchIssues('project = ABC ORDER BY created ASC', 'acme', 'me@x.com', 'tok')

    expect(calls.length).toBe(2)
    expect(calls[0].url).toContain('https://acme.atlassian.net/rest/api/3/search/jql')
    expect(calls[0].url).toContain('fields=*all')
    expect(calls[0].url).toContain('maxResults=100')
    expect(calls[0].url).toContain('jql=project%20%3D%20ABC%20ORDER%20BY%20created%20ASC')
    expect(calls[0].headers.Authorization).toBe('Basic ' + btoa('me@x.com:tok'))
    expect(calls[1].url).toContain('startAt=100')
    expect(result.length).toBe(200)
    expect(result[0].key).toBe('ABC-1')
    expect(result[199].key).toBe('ABC-200')
  })

  it('throws on non-OK response', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Response('nope', { status: 401 })))
    await expect(searchIssues('x', 'acme', 'a', 'b')).rejects.toThrow('Jira search 401')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/jira.test.ts`
Expected: FAIL — `Cannot find module '../jira'`.

- [ ] **Step 3: Implement `jira.ts`**

Create `src/workers/jira.ts`:

```ts
import type { JiraIssue } from './fieldExtractor'

export async function searchIssues(
  jql: string,
  subdomain: string,
  email: string,
  apiToken: string,
): Promise<JiraIssue[]> {
  const base = `https://${subdomain}.atlassian.net/rest/api/3/search/jql`
  const auth = 'Basic ' + btoa(`${email}:${apiToken}`)
  const issues: JiraIssue[] = []
  let startAt = 0
  for (;;) {
    const url = `${base}?jql=${encodeURIComponent(jql)}&fields=*all&maxResults=100&startAt=${startAt}`
    const res = await fetch(url, { headers: { Authorization: auth } })
    if (!res.ok) throw new Error(`Jira search ${res.status}: ${await res.text()}`)
    const data = (await res.json()) as { issues?: JiraIssue[]; total?: number }
    issues.push(...(data.issues ?? []))
    startAt += 100
    if (startAt >= (data.total ?? startAt)) break
  }
  return issues
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/jira.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/workers/jira.ts src/workers/tests/jira.test.ts
git commit -m "feat: add Jira JQL search client"
```

---

### Task 3: `scheduled` handler

**Files:**
- Modify: `src/workers/index.ts`
- Modify: `src/workers/tests/webhook.test.ts`

**Interfaces:**
- Consumes: `searchIssues` from `./jira`, `getConfig`/`Env` from `./config`, `upsertIssue`/`withToken` from `./sheetWriter`, `JiraIssue` from `./fieldExtractor`.
- Produces: default export `{ fetch: app.fetch, scheduled }` where `scheduled(controller: ScheduledController, env: Env): Promise<void>` (Cloudflare passes `(controller, env, ctx)`; the controller arg is unused).

- [ ] **Step 1: Write the failing test**

Append to `src/workers/tests/webhook.test.ts`:

```ts
import { searchIssues } from '../jira'
import { upsertIssue } from '../sheetWriter'
import { vi, afterEach } from 'vitest'

vi.mock('../jira', () => ({ searchIssues: vi.fn() }))
vi.mock('../sheetWriter', () => ({ upsertIssue: vi.fn().mockResolvedValue(undefined), withToken: vi.fn(), deleteIssue: vi.fn(), getOrCreateSprintSheet: vi.fn() }))

const searchIssuesMock = vi.mocked(searchIssues)
const upsertIssueMock = vi.mocked(upsertIssue)
```

> Note: hoisted `vi.mock` calls are applied for the whole file; the mock `../sheetWriter` module must export every symbol `index.ts` imports (`upsertIssue`, `deleteIssue`, `withToken`) or the import in `index.ts` will fail to resolve at runtime — hence the extra mock keys.

Then add a describe block:

```ts
describe('scheduled — sprint cron sync', () => {
  it('runs JQL search and upserts each issue, tolerating per-issue failure', async () => {
    searchIssuesMock.mockResolvedValue([
      { key: 'ABC-1', fields: {} },
      { key: 'ABC-2', fields: {} },
    ] as never)
    upsertIssueMock.mockRejectedValueOnce(new Error('sheets down'))

    const module = await import('../index')
    const { scheduled } = module.default as { scheduled: (c: { cron: string }, env: typeof testEnv) => Promise<void> }

    await expect(scheduled({ cron: '0 0 * * *' }, testEnv)).resolves.toBeUndefined()

    const jql = 'project = TEST AND sprint = 42 ORDER BY created ASC'
    expect(searchIssuesMock).toHaveBeenCalledWith(jql, 'acme', 'jira@example.com', 'jira-token')
    expect(upsertIssueMock).toHaveBeenCalledTimes(2)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/webhook.test.ts`
Expected: FAIL — the module has no `scheduled` export yet (or the whole file errors because `index.ts` still has no `scheduled`).

- [ ] **Step 3: Update `index.ts`**

Add imports:

```ts
import { searchIssues } from './jira'
```

Add a handler after the route definitions:

```ts
async function syncSprint(_controller: ScheduledController, env: Env): Promise<void> {
  const config = getConfig(env)
  const jql = `project = ${config.PROJECT_KEY} AND sprint = ${config.SPRINT_ID} ORDER BY created ASC`
  const issues = await searchIssues(jql, config.JIRA_SUBDOMAIN, env.JIRA_EMAIL, env.JIRA_API_TOKEN)
  for (const issue of issues) {
    try {
      await withToken(
        env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        env.GOOGLE_PRIVATE_KEY,
        (token) => upsertIssue(env.SPREADSHEET_ID, issue, token, config),
      )
    } catch (err) {
      console.error(`Sprint sync failed for ${issue.key}: ${err}`)
    }
  }
}
```

> `// ponytail: upsertIssue picks the tab by the issue's sprint field (active/last), same rule as the webhook. An issue in two active sprints may land elsewhere — accepted.`

Replace the default export:

```ts
export default {
  fetch: app.fetch,
  scheduled: syncSprint,
}
```

- [ ] **Step 4: Update `webhook.test.ts` to use the new export shape**

The old `app.request(...)` calls no longer work (default export is now an object, not the Hono app). Change the import and every `app.request` call:

```ts
import index from '../index'
```

Replace `app.request(` with `index.fetch(` in all existing tests (the test body strings stay identical; `request`'s third arg `testEnv` maps to `fetch`'s third arg `env`). Also update the `app.on`/`app.get` references: none — the routes are unchanged, only the entry point wrapper changed.

The `scheduled` describe block already imports `../index` dynamically; that still works.

- [ ] **Step 5: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: all tests pass, typecheck clean. The mock for `../sheetWriter` must satisfy `index.ts` imports — if vitest complains about a missing export, add it to the `vi.mock` factory.

- [ ] **Step 6: Commit**

```bash
git add src/workers/index.ts src/workers/tests/webhook.test.ts
git commit -m "feat: nightly sprint cron sync"
```

---

## Self-review notes

- **Spec coverage:** cron trigger (Task 1), JQL search + pagination + Basic auth (Task 2), `scheduled` wiring + per-issue error isolation + reuse of `upsertIssue` (Task 3), config plumbing + `.dev.vars.example` (Task 1). Deployment note (below) is in the spec's out-of-scope/setup territory.
- **Type consistency:** `searchIssues(jql, subdomain, email, apiToken)` is defined in Task 2 and called with `(jql, config.JIRA_SUBDOMAIN, env.JIRA_EMAIL, env.JIRA_API_TOKEN)` in Task 3. `syncSprint` is exported as `scheduled`. `Env` gains exactly `SPRINT_ID`, `JIRA_EMAIL`, `JIRA_API_TOKEN`; `Config` gains `SPRINT_ID` — used in Task 3 via `config.PROJECT_KEY`, `config.SPRINT_ID`, `config.JIRA_SUBDOMAIN`.
- **Verification commands:** `npm run typecheck`, `npm test`, `npx vitest run tests/<file>.test.ts` — all run from `src/workers/`.

## Post-plan deployment (not a task)

```bash
cd src/workers
wrangler secret put JIRA_EMAIL
wrangler secret put JIRA_API_TOKEN
npm run deploy   # deploys cron trigger too
```

Verify the cron registered: `wrangler deploy --dry-run --outdir dist` shows the cron in the config, or check the dashboard → Workers → Triggers. To test the sync immediately, trigger via the dashboard's "Trigger now" button.
