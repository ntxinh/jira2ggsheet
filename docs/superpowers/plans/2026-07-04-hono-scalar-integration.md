# Hono + Scalar OpenAPI Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the existing raw Cloudflare Worker `fetch` handler to Hono with `@hono/zod-openapi` for type-safe webhook validation and automatic OpenAPI spec generation, served via Scalar UI.

**Architecture:** Replace the manual `fetch` handler with a Hono `OpenAPIHono` app. Define Zod schemas for the Jira webhook payload that drive both runtime validation and OpenAPI spec generation. Serve the generated spec at `/openapi.json` and Scalar UI at `/docs`. Preserve all existing webhook business logic, token auth, project filtering, `waitUntil` background processing, and error resilience unchanged.

**Tech Stack:** Hono, @hono/zod-openapi, @scalar/hono-api-reference, Zod, Vitest, TypeScript

## Global Constraints

- All existing webhook behavior must be preserved: token validation, project filtering, event routing (`jira:issue_created`/`updated`/`deleted`), `ctx.waitUntil()` background processing, error resilience (always return 200 "ok" on handler errors).
- The OpenAPI spec must be generated automatically from route definitions — no manual spec files.
- Scalar UI at `/docs` must fetch its spec from `/openapi.json`.
- Existing modules (`config.ts`, `auth.ts`, `fieldExtractor.ts`, `sheetWriter.ts`) must not be modified.
- New code must have both unit tests (schema validation) and integration tests (route-level via `app.request()`).

---

### Task 1: Dependencies & Test Configuration

**Files:**
- Modify: `src/workers/package.json`
- Create: `src/workers/vitest.config.ts`
- Modify: `src/workers/tsconfig.json`
- Create: `src/workers/tests/.gitkeep`

**Interfaces:**
- Consumes: N/A (setup task)
- Produces: Working dependency tree with Hono/Zod/Scalar/Vitest resolved; test runner configured and verified

- [ ] **Step 1: Update package.json**

Old content:
```json
{
  "name": "jira2ggsheet",
  "version": "1.0.0",
  "description": "Jira to Google Sheets sync — Cloudflare Worker",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20250401.0",
    "typescript": "^5.5.0",
    "wrangler": "^4.0.0"
  }
}
```

New content:
```json
{
  "name": "jira2ggsheet",
  "version": "1.0.0",
  "description": "Jira to Google Sheets sync — Cloudflare Worker",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@hono/zod-openapi": "^0.18.0",
    "@scalar/hono-api-reference": "^0.5.0",
    "hono": "^4.7.0",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20250401.0",
    "typescript": "^5.5.0",
    "vitest": "^3.0.0",
    "wrangler": "^4.0.0"
  }
}
```

- [ ] **Step 2: Install dependencies**

Run: `npm install` in `src/workers/`

Expected output: No errors. `package-lock.json` updated. `node_modules/` now contains `hono`, `@hono/zod-openapi`, `@scalar/hono-api-reference`, `zod`, `vitest`.

- [ ] **Step 3: Create vitest.config.ts**

Write `src/workers/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
  },
})
```

- [ ] **Step 4: Update tsconfig.json to include test files**

Old include: `"include": ["*.ts"]`
New include: `"include": ["*.ts", "tests/**/*.ts"]`

- [ ] **Step 5: Create tests directory**

Run: `mkdir -p src/workers/tests` and touch `src/workers/tests/.gitkeep`

- [ ] **Step 6: Verify typecheck still passes**

Run: `npx tsc --noEmit`

Expected: No errors. (May need to add `"types": []` overrides for test files if CF Workers types conflict with vitest. If errors occur, add `"vitest/globals"` to tsconfig `types` array, or skip test files with a separate tsconfig for tests — address as needed.)

- [ ] **Step 7: Verify vitest runs (no tests yet)**

Run: `npx vitest run`

Expected: No test files found (or similar), exit code 0.

- [ ] **Step 8: Commit**

```bash
git add src/workers/package.json src/workers/package-lock.json src/workers/tsconfig.json src/workers/vitest.config.ts src/workers/tests/
git commit -m "chore: add hono/zod/scalar/vitest deps and test config"
```

---

### Task 2: Zod Schema Definitions

**Files:**
- Create: `src/workers/schema.ts`
- Create: `src/workers/tests/schema.test.ts`

**Interfaces:**
- Consumes: N/A (standalone schema module)
- Produces: `JiraWebhookPayloadSchema` (Zod object for Jira webhook body), `WebhookQuerySchema` (Zod object for query params), exported types for the inferred payload shape

- [ ] **Step 1: Write schema.ts**

Write `src/workers/schema.ts`:
```ts
import { z } from '@hono/zod-openapi'

const JiraProjectSchema = z.object({
  key: z.string().openapi({ example: 'CPQ1' }),
}).openapi('JiraProject')

const JiraIssueTypeSchema = z.object({
  name: z.string().openapi({ example: 'Bug' }),
}).openapi('JiraIssueType')

const JiraPrioritySchema = z.object({
  name: z.string().openapi({ example: 'High' }),
}).openapi('JiraPriority')

const JiraStatusSchema = z.object({
  name: z.string().openapi({ example: 'In Progress' }),
}).openapi('JiraStatus')

const JiraUserSchema = z.object({
  displayName: z.string().openapi({ example: 'John Doe' }),
}).openapi('JiraUser')

const JiraIssueFieldsSchema = z.object({
  project: JiraProjectSchema.optional(),
  issuetype: JiraIssueTypeSchema.optional(),
  priority: JiraPrioritySchema.optional(),
  summary: z.string().openapi({ example: 'Fix login bug' }).optional(),
  status: JiraStatusSchema.optional(),
  created: z.string().openapi({ example: '2026-07-04T10:00:00.000+0000' }).optional(),
  assignee: JiraUserSchema.optional(),
}).passthrough().openapi('JiraIssueFields')

const JiraIssueSchema = z.object({
  key: z.string().openapi({ example: 'CPQ1-123' }),
  fields: JiraIssueFieldsSchema,
}).openapi('JiraIssue')

const JiraWebhookPayloadSchema = z.object({
  webhookEvent: z.string().openapi({ example: 'jira:issue_created' }),
  issue: JiraIssueSchema,
}).openapi('JiraWebhookPayload')

const WebhookQuerySchema = z.object({
  token: z.string().optional().openapi({ description: 'Authentication token for webhook access' }),
})

export { JiraWebhookPayloadSchema, JiraIssueSchema, JiraIssueFieldsSchema, WebhookQuerySchema }
export type { JiraWebhookPayloadSchema }
```

- [ ] **Step 2: Write the failing tests**

Write `src/workers/tests/schema.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { JiraWebhookPayloadSchema, WebhookQuerySchema } from '../schema'

describe('JiraWebhookPayloadSchema', () => {
  it('accepts a valid minimal payload', () => {
    const payload = {
      webhookEvent: 'jira:issue_created',
      issue: { key: 'CPQ1-123', fields: {} },
    }
    const result = JiraWebhookPayloadSchema.safeParse(payload)
    expect(result.success).toBe(true)
  })

  it('rejects payload without webhookEvent', () => {
    const payload = { issue: { key: 'CPQ1-123', fields: {} } }
    const result = JiraWebhookPayloadSchema.safeParse(payload)
    expect(result.success).toBe(false)
  })

  it('rejects payload without issue', () => {
    const payload = { webhookEvent: 'jira:issue_created' }
    const result = JiraWebhookPayloadSchema.safeParse(payload)
    expect(result.success).toBe(false)
  })

  it('rejects payload where issue has no key', () => {
    const payload = { webhookEvent: 'jira:issue_created', issue: { fields: {} } }
    const result = JiraWebhookPayloadSchema.safeParse(payload)
    expect(result.success).toBe(false)
  })

  it('accepts payload with all optional fields filled', () => {
    const payload = {
      webhookEvent: 'jira:issue_updated',
      issue: {
        key: 'CPQ1-456',
        fields: {
          project: { key: 'CPQ1' },
          issuetype: { name: 'Story' },
          priority: { name: 'Medium' },
          summary: 'Test summary',
          status: { name: 'Done' },
          created: '2026-01-01T00:00:00.000+0000',
          assignee: { displayName: 'Jane Doe' },
        },
      },
    }
    const result = JiraWebhookPayloadSchema.safeParse(payload)
    expect(result.success).toBe(true)
  })

  it('allows unknown custom fields in issue.fields (passthrough)', () => {
    const payload = {
      webhookEvent: 'jira:issue_deleted',
      issue: {
        key: 'CPQ1-789',
        fields: {
          customfield_10016: { id: 1, name: 'Sprint 1' },
          customfield_10021: 5,
        },
      },
    }
    const result = JiraWebhookPayloadSchema.safeParse(payload)
    expect(result.success).toBe(true)
  })
})

describe('WebhookQuerySchema', () => {
  it('accepts a query with token', () => {
    expect(WebhookQuerySchema.safeParse({ token: 'secret123' }).success).toBe(true)
  })

  it('accepts a query without token (optional)', () => {
    expect(WebhookQuerySchema.safeParse({}).success).toBe(true)
  })
})
```

- [ ] **Step 3: Run tests to verify they fail (schema module doesn't exist yet)**

Run: `npx vitest run tests/schema.test.ts`

Expected: FAIL with import errors (cannot find module '../schema').

- [ ] **Step 4: Write minimal implementation**

Step 1 already wrote the schema.ts file. No additional code needed.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/schema.test.ts`

Expected: 8/8 PASS.

- [ ] **Step 6: Verify typecheck**

Run: `npx tsc --noEmit`

Expected: No errors.

- [ ] **Step 7: Commit**

```bash
git add src/workers/schema.ts src/workers/tests/schema.test.ts
git commit -m "feat: add Zod schemas for Jira webhook payload validation"
```

---

### Task 3: Rewrite index.ts as Hono OpenAPI App

**Files:**
- Modify: `src/workers/index.ts`
- Create: `src/workers/tests/webhook.test.ts`
- Create: `src/workers/tests/mock-env.ts` (shared test env fixture)

**Interfaces:**
- Consumes: `JiraWebhookPayloadSchema`, `WebhookQuerySchema` from `schema.ts`; `Env` from `config.ts`; `upsertIssue`, `deleteIssue`, `withToken` from `sheetWriter.ts`
- Produces: Hono app default-exported as CF Worker; routes for POST `/`, GET `/openapi.json`, GET `/docs`; integration tests verifying routing, auth, validation, and spec delivery

- [ ] **Step 1: Create shared test env fixture**

Write `src/workers/tests/mock-env.ts`:
```ts
import type { Env } from '../config'

export const testEnv: Env = {
  SECRET_TOKEN: 'test-token',
  GOOGLE_SERVICE_ACCOUNT_EMAIL: 'test@test.iam.gserviceaccount.com',
  GOOGLE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nMOCK\n-----END PRIVATE KEY-----',
  SPREADSHEET_ID: 'fake-spreadsheet-id',
  PROJECT_KEY: 'TEST',
  TEMPLATE_SHEET: 'Template',
  KEY_COLUMN: 'C',
  HEADER_ROWS: '1',
  DELETE_MODE: 'delete',
  TIMEZONE: 'UTC',
  DATE_FORMAT: 'yyyy-MM-dd',
  CUSTOM_FIELDS_SPRINT: 'customfield_10016',
  CUSTOM_FIELDS_STORY_POINTS: 'customfield_10021',
  COLUMN_MAP_JSON: '{"A":"sprintId","C":"issueKey"}',
}
```

- [ ] **Step 2: Write the failing integration tests**

Write `src/workers/tests/webhook.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import app from '../index'
import { testEnv } from './mock-env'

describe('POST / — Jira webhook', () => {
  it('returns 401 when token query param is missing', async () => {
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ webhookEvent: 'jira:issue_created', issue: { key: 'TEST-1', fields: {} } }),
    }, testEnv)
    expect(res.status).toBe(401)
    expect(await res.text()).toBe('unauthorized')
  })

  it('returns 401 when token is wrong', async () => {
    const res = await app.request('/?token=wrong', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ webhookEvent: 'jira:issue_created', issue: { key: 'TEST-1', fields: {} } }),
    }, testEnv)
    expect(res.status).toBe(401)
  })

  it('returns 400 for malformed JSON body', async () => {
    const res = await app.request('/?token=test-token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json',
    }, testEnv)
    expect(res.status).toBe(400)
  })

  it('returns 400 for payload missing required fields', async () => {
    const res = await app.request('/?token=test-token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }, testEnv)
    expect(res.status).toBe(400)
  })

  it('returns 200 for valid webhook with matching project', async () => {
    const res = await app.request('/?token=test-token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        webhookEvent: 'jira:issue_created',
        issue: { key: 'TEST-1', fields: { project: { key: 'TEST' } } },
      }),
    }, testEnv)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')
  })

  it('returns 200 for valid webhook with non-matching project (ignored, not an error)', async () => {
    const res = await app.request('/?token=test-token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        webhookEvent: 'jira:issue_created',
        issue: { key: 'OTHER-1', fields: { project: { key: 'OTHER' } } },
      }),
    }, testEnv)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')
  })

  it('returns 200 for unknown event type (ignored, not an error)', async () => {
    const res = await app.request('/?token=test-token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        webhookEvent: 'jira:unknown_event',
        issue: { key: 'TEST-1', fields: { project: { key: 'TEST' } } },
      }),
    }, testEnv)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')
  })
})

describe('GET / — method not allowed', () => {
  it('returns 405 for GET', async () => {
    const res = await app.request('/', { method: 'GET' }, testEnv)
    expect(res.status).toBe(405)
  })

  it('returns 405 for PUT', async () => {
    const res = await app.request('/', { method: 'PUT' }, testEnv)
    expect(res.status).toBe(405)
  })

  it('returns 405 for DELETE', async () => {
    const res = await app.request('/', { method: 'DELETE' }, testEnv)
    expect(res.status).toBe(405)
  })
})

describe('GET /openapi.json', () => {
  it('returns valid OpenAPI spec', async () => {
    const res = await app.request('/openapi.json', { method: 'GET' }, testEnv)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    const spec = await res.json()
    expect(spec.openapi).toBeDefined()
    expect(spec.info).toBeDefined()
    expect(spec.paths).toBeDefined()
    expect(spec.paths['/']).toBeDefined()
    expect(spec.paths['/'].post).toBeDefined()
  })
})

describe('GET /docs', () => {
  it('returns Scalar HTML page', async () => {
    const res = await app.request('/docs', { method: 'GET' }, testEnv)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/webhook.test.ts`

Expected: FAIL with import errors (cannot find module '../index' or similar, since index.ts still exports the raw handler).

- [ ] **Step 4: Rewrite index.ts with Hono**

Replace entire `src/workers/index.ts`:
```ts
import { OpenAPIHono, createRoute } from '@hono/zod-openapi'
import { apiReference } from '@scalar/hono-api-reference'
import { getConfig, type Env } from './config'
import { upsertIssue, deleteIssue, withToken } from './sheetWriter'
import { JiraWebhookPayloadSchema, WebhookQuerySchema } from './schema'

const app = new OpenAPIHono<{ Bindings: Env }>()

// --- Route spec ---

const webhookRoute = createRoute({
  method: 'post',
  path: '/',
  summary: 'Receive Jira webhook',
  description: 'Process incoming Jira issue webhook events (created, updated, deleted). Validates token via query parameter.',
  tags: ['Webhook'],
  request: {
    query: WebhookQuerySchema,
    body: {
      content: { 'application/json': { schema: JiraWebhookPayloadSchema } },
    },
  },
  responses: {
    200: { description: 'Webhook acknowledged (ok)' },
    400: { description: 'Invalid payload body' },
    401: { description: 'Missing or invalid token' },
    405: { description: 'Method not allowed' },
  },
})

// --- Business logic (preserved from legacy handler) ---

function handleWebhook(
  payload: { webhookEvent: string; issue: { key: string; fields: Record<string, unknown> } },
  env: Env,
): Promise<void> | null {
  if (!payload || !payload.issue || !payload.issue.fields) {
    console.log('Ignored: payload has no issue')
    return null
  }

  const issue = payload.issue
  const project = issue.fields.project as { key: string } | undefined
  if (!project || project.key !== env.PROJECT_KEY) {
    console.log(`Ignored: project ${project?.key ?? 'undefined'} != ${env.PROJECT_KEY}`)
    return null
  }

  const config = getConfig(env)

  switch (payload.webhookEvent) {
    case 'jira:issue_created':
    case 'jira:issue_updated':
      return withToken(
        env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        env.GOOGLE_PRIVATE_KEY,
        (token) => upsertIssue(env.SPREADSHEET_ID, issue, token, config),
      )
    case 'jira:issue_deleted':
      return withToken(
        env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        env.GOOGLE_PRIVATE_KEY,
        (token) => deleteIssue(env.SPREADSHEET_ID, issue, token, config),
      )
    default:
      console.log('Ignored: event ' + payload.webhookEvent)
      return null
  }
}

// --- Routes ---

app.openapi(webhookRoute, async (c) => {
  const { token } = c.req.valid('query')
  if (!token || token !== c.env.SECRET_TOKEN) {
    console.log('Webhook rejected: bad or missing token')
    return c.text('unauthorized', 401)
  }

  const payload = c.req.valid('json')

  try {
    const work = handleWebhook(payload, c.env)
    if (work) {
      const safe = work.catch((err) => console.error('Handler failed: ' + err))
      c.executionCtx?.waitUntil(safe)
    }
  } catch (err) {
    console.log('Webhook handler error: ' + err)
  }

  return c.text('ok')
})

// Explicit 405 for non-POST requests to /
app.on(['GET', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'], '/', (c) => {
  return c.text('Method not allowed', 405)
})

// OpenAPI spec endpoint
app.get('/openapi.json', (c) => {
  return c.json(app.getOpenAPIDocument({
    openapi: '3.1.0',
    info: {
      title: 'Jira to Google Sheets Webhook',
      version: '1.0.0',
      description: 'Webhook receiver that syncs Jira issues to Google Sheets',
    },
  }))
})

// Scalar API docs UI
app.get('/docs', apiReference({ spec: { url: '/openapi.json' } }))

export default app
```

- [ ] **Step 5: Verify typecheck**

Run: `npx tsc --noEmit`

Expected: No errors. (Note: the `app.getOpenAPIDocument()` call with a config object may have a different API depending on `@hono/zod-openapi` version. If it doesn't accept a config argument, change to `app.getOpenAPIDocument()` and handle info separately.)

- [ ] **Step 6: Run all tests**

Run: `npx vitest run`

Expected: All tests pass (schema.test.ts + webhook.test.ts).

- [ ] **Step 7: Commit**

```bash
git add src/workers/index.ts src/workers/tests/webhook.test.ts src/workers/tests/mock-env.ts
git commit -m "feat: migrate worker to Hono with OpenAPI and Scalar docs"
```
