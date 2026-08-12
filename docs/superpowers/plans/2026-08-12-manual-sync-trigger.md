# Manual Sprint Sync Trigger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `GET /sync?sprintId=...` endpoint so a user can manually trigger the sprint sync, with `sprintId` optional and falling back to the configured `SPRINT_ID`.

**Architecture:** Refactor `syncSprint` to take a sprintId and return a summary (`{ issuesSynced, issuesFailed }`). The scheduled handler becomes a thin wrapper passing `env.SPRINT_ID`. A new `GET /sync` Hono route (Zod query schema) resolves `sprintId` and runs the sync inline, returning the summary as JSON.

**Tech Stack:** Cloudflare Workers, Hono (`@hono/zod-openapi`), Zod, vitest.

## Global Constraints

- No new npm dependencies.
- Working dir for all commands: `src/workers/`.
- `upsertIssue` signature (existing, unchanged): `(spreadsheetId: string, issue: JiraIssue, token: string, config: Config) => Promise<void>`.
- `withToken` signature (existing, unchanged): `(email: string, privateKey: string, fn: (token: string) => Promise<void>) => Promise<void>`.
- `/sync` is intentionally **unauthenticated** (user's explicit choice).
- Tests and mocks follow the existing pattern in `tests/webhook.test.ts` and `tests/mock-env.ts`.
- Verify commands: `npm test` (vitest) and `npm run typecheck`.

---

### Task 1: Refactor `syncSprint` to take a sprintId and return counts

**Files:**
- Modify: `src/workers/index.ts:121-140` (`syncSprint`) and `:151` (`scheduled` entry)
- Modify: `src/workers/tests/webhook.test.ts:149-178` (scheduled describe block)

**Interfaces:**
- Consumes: existing `searchIssues`, `upsertIssue`, `withToken`, `getConfig`, `Env`.
- Produces: `syncSprint(sprintId: string, env: Env): Promise<{ issuesSynced: number; issuesFailed: number }>`. Scheduled entry keeps the runtime shape `(controller, env) => Promise<void>` (a `Promise<summary>` is assignable to `Promise<void>`).

- [ ] **Step 1: Refactor `syncSprint` and the `scheduled` entry**

In `src/workers/index.ts`, replace the current `syncSprint` function (lines 121-140) with:

```ts
async function syncSprint(sprintId: string, env: Env): Promise<{ issuesSynced: number; issuesFailed: number }> {
  const config = getConfig(env)
  const jql = `project = ${config.PROJECT_KEY} AND sprint = ${sprintId} ORDER BY created ASC`
  const issues = await searchIssues(jql, config.JIRA_SUBDOMAIN, env.JIRA_EMAIL, env.JIRA_API_TOKEN)
  let issuesSynced = 0
  let issuesFailed = 0
  // ponytail: upsertIssue picks the tab by the issue's sprint field (active/last), same rule as the webhook. An issue in two active sprints may land elsewhere — accepted.
  await withToken(
    env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    env.GOOGLE_PRIVATE_KEY,
    async (token) => {
      for (const issue of issues) {
        try {
          await upsertIssue(env.SPREADSHEET_ID, issue, token, config)
          issuesSynced++
        } catch (err) {
          issuesFailed++
          console.error(`Sprint sync failed for ${issue.key}: ${err}`)
          Sentry.captureException(err)
        }
      }
    },
  )
  return { issuesSynced, issuesFailed }
}
```

In the `Sentry.withSentry` export (line 149-153), change `scheduled: syncSprint` to:

```ts
scheduled: (_controller, env) => syncSprint(env.SPRINT_ID, env),
```

- [ ] **Step 2: Update the existing scheduled tests to the new summary shape**

In `tests/webhook.test.ts`, replace line 160:

```ts
await expect(scheduled({ cron: '0 0 * * *' }, testEnv)).resolves.toBeUndefined()
```

with:

```ts
await expect(scheduled({ cron: '0 0 * * *' }, testEnv)).resolves.toEqual({ issuesSynced: 1, issuesFailed: 1 })
```

(`upsertIssueMock` rejects once for `ABC-1` and resolves for `ABC-2`, so 1 synced + 1 failed.)

The second test (`reports per-issue failures to Sentry`) needs no change — `scheduled` still resolves.

- [ ] **Step 3: Run tests and typecheck**

Run: `npm test` and `npm run typecheck`
Expected: all tests pass, no type errors.

- [ ] **Step 4: Commit**

```bash
git add src/workers/index.ts src/workers/tests/webhook.test.ts
git commit -m "refactor: syncSprint takes sprintId, returns sync counts"
```

---

### Task 2: Add `GET /sync` manual trigger route

**Files:**
- Modify: `src/workers/schema.ts` (add `SyncQuerySchema`)
- Modify: `src/workers/index.ts` (route spec, route registration, handler)
- Modify: `src/workers/tests/webhook.test.ts` (new describe block)

**Interfaces:**
- Consumes: `syncSprint(sprintId: string, env: Env): Promise<{ issuesSynced: number; issuesFailed: number }>` from Task 1; `SyncQuerySchema` from schema.ts.
- Produces: HTTP route `GET /sync?sprintId=...` → `200 { issuesSynced, issuesFailed }`; `500 { error }` on Jira search failure. Appears in `/openapi.json` and `/docs`.

- [ ] **Step 1: Add the query schema**

In `src/workers/schema.ts`, after `WebhookQuerySchema` (line 52), add and export:

```ts
const SyncQuerySchema = z.object({
  sprintId: z.string().optional().openapi({ description: 'Sprint ID to sync. Falls back to SPRINT_ID env var when omitted.' }),
})

export { JiraWebhookPayloadSchema, JiraIssueSchema, JiraIssueFieldsSchema, WebhookQuerySchema, SyncQuerySchema }
```

- [ ] **Step 2: Define the route spec**

In `src/workers/index.ts`, after the `webhookRoute` definition (line 31), add:

```ts
const syncRoute = createRoute({
  method: 'get',
  path: '/sync',
  summary: 'Manually trigger sprint sync',
  description: 'Upserts every issue in a sprint into its per-sprint tab. Pass sprintId as a query param, or omit it to use the configured SPRINT_ID.',
  tags: ['Sync'],
  request: {
    query: SyncQuerySchema,
  },
  responses: {
    200: { description: 'Sync complete' },
    500: { description: 'Jira search or sheets failure' },
  },
})
```

- [ ] **Step 3: Import `SyncQuerySchema` and register the handler**

In `src/workers/index.ts`, update the schema import on line 7:

```ts
import { JiraWebhookPayloadSchema, WebhookQuerySchema, SyncQuerySchema } from './schema'
```

After the webhook route handler (after line 99), add:

```ts
app.openapi(syncRoute, async (c) => {
  const { sprintId } = c.req.valid('query')
  const id = sprintId ?? c.env.SPRINT_ID
  try {
    return c.json(await syncSprint(id, c.env))
  } catch (err) {
    console.error('Manual sync failed: ' + err)
    Sentry.captureException(err)
    return c.json({ error: 'sync failed' }, 500)
  }
})
```

- [ ] **Step 4: Write the failing tests**

Append this describe block to `tests/webhook.test.ts`:

```ts
describe('GET /sync — manual sprint sync', () => {
  it('syncs the sprintId from the query param and returns counts', async () => {
    searchIssuesMock.mockResolvedValue([
      { key: 'ABC-1', fields: {} },
      { key: 'ABC-2', fields: {} },
    ])

    const res = await index.fetch(new Request(new URL('/sync?sprintId=99', 'http://localhost'), { method: 'GET' }), testEnv)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ issuesSynced: 2, issuesFailed: 0 })
    expect(searchIssuesMock).toHaveBeenCalledWith('project = TEST AND sprint = 99 ORDER BY created ASC', 'acme', 'jira@example.com', 'jira-token')
  })

  it('falls back to env SPRINT_ID when sprintId omitted', async () => {
    searchIssuesMock.mockResolvedValue([])

    const res = await index.fetch(new Request(new URL('/sync', 'http://localhost'), { method: 'GET' }), testEnv)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ issuesSynced: 0, issuesFailed: 0 })
    expect(searchIssuesMock).toHaveBeenCalledWith('project = TEST AND sprint = 42 ORDER BY created ASC', 'acme', 'jira@example.com', 'jira-token')
  })

  it('counts failed upserts', async () => {
    searchIssuesMock.mockResolvedValue([{ key: 'ABC-1', fields: {} }])
    upsertIssueMock.mockRejectedValueOnce(new Error('sheets down'))

    const res = await index.fetch(new Request(new URL('/sync?sprintId=7', 'http://localhost'), { method: 'GET' }), testEnv)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ issuesSynced: 0, issuesFailed: 1 })
  })

  it('returns 500 when the Jira search fails', async () => {
    searchIssuesMock.mockRejectedValueOnce(new Error('jira down'))

    const res = await index.fetch(new Request(new URL('/sync?sprintId=7', 'http://localhost'), { method: 'GET' }), testEnv)
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'sync failed' })
  })
})
```

- [ ] **Step 5: Run tests to verify they fail**

Run: `npm test -- webhook.test.ts`
Expected: FAIL — `GET /sync` returns 404 (route not registered) / import error.

- [ ] **Step 6: Run tests and typecheck to verify they pass**

Run: `npm test` and `npm run typecheck`
Expected: all tests pass, no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/workers/index.ts src/workers/schema.ts src/workers/tests/webhook.test.ts
git commit -m "feat: add manual GET /sync trigger with optional sprintId"
```
