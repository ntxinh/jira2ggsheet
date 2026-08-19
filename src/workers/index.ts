import { OpenAPIHono, createRoute } from '@hono/zod-openapi'
import { apiReference } from '@scalar/hono-api-reference'
import * as Sentry from '@sentry/cloudflare'
import { getConfig, parseSprintIds, type Env } from './config'
import { upsertIssue, deleteIssue, withToken } from './sheetWriter'
import { postChatNotification } from './chat'
import type { SyncCoordinator } from './syncCoordinator'
import { JiraWebhookPayloadSchema, WebhookQuerySchema, SyncQuerySchema, type JiraWebhookPayload } from './schema'

export { SyncCoordinator } from './syncCoordinator' // exported from the entrypoint so wrangler can bind the DO

// Full-sprint syncs (cron + manual) run on the SyncCoordinator Durable Object: the cron every
// 5 min and GET /sync both wake it, and a self-scheduling alarm chain processes one Jira page
// (100 issues) per tick — one batched sheet write per page, ~3s apart. This keeps each invocation
// within the Free plan's 10ms CPU / 50-subrequest limits (see syncCoordinator.ts). Webhooks below
// stay synchronous per-issue upserts for near-real-time changes.

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

const syncRoute = createRoute({
  method: 'get',
  path: '/sync',
  summary: 'Manually trigger sprint sync',
  description: 'Kicks the SyncCoordinator Durable Object to sync sprint(s). If a sync is already running it is left alone (status "in_progress"). The alarm chain then processes one Jira page per tick, so the request returns immediately — poll GET /sync/status for progress. Pass a single sprintId as a query param, or omit it to sync the configured SPRINT_ID list (comma-separated) one sprint after another.',
  tags: ['Sync'],
  request: {
    query: SyncQuerySchema,
  },
  responses: {
    200: { description: 'Sync started or already in progress' },
    500: { description: 'Failed to wake the sync coordinator' },
  },
})

const syncStatusRoute = createRoute({
  method: 'get',
  path: '/sync/status',
  summary: 'Poll sprint sync progress',
  description: 'Returns whether a full-sprint sync is running and, if so, how many pages and rows have been completed so far.',
  tags: ['Sync'],
  responses: {
    200: { description: 'Sync status' },
    500: { description: 'Failed to read sync status' },
  },
})

// --- Business logic (preserved from legacy handler) ---

function handleWebhook(
  payload: JiraWebhookPayload,
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
        async (token) => {
          const inserted = await upsertIssue(env.SPREADSHEET_ID, issue, token, config)
          // Sheet is the single source of truth: only a genuinely new row (key not already in the
          // sheet) assigned to NOTIFY_ASSIGNEE triggers the targeted notification.
          const assignee = (issue.fields.assignee as { displayName?: string } | undefined)?.displayName
          if (inserted && assignee === env.NOTIFY_ASSIGNEE) {
            await postChatNotification(env, payload)
          }
        },
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
      const safe = work.catch((err) => {
        console.error('Handler failed: ' + err)
        Sentry.captureException(err)
      })
      c.executionCtx?.waitUntil(safe)
    }
  } catch (err) {
    console.log('Webhook handler error: ' + err)
    Sentry.captureException(err)
  }

  return c.text('ok')
})

app.openapi(syncRoute, async (c) => {
  const { sprintId } = c.req.valid('query')
  const sprintIds = sprintId ? [sprintId] : parseSprintIds(c.env.SPRINT_ID)
  const id = sprintIds[0]
  try {
    const result = await coordinator(c.env).kick(sprintId)
    // When a different sprint is already syncing, say so instead of implying the requested one is.
    const runningSprintId = result.status === 'in_progress' && result.sprintId !== id ? result.sprintId : undefined
    return c.json({ sprintId: id, sprintIds, status: result.status, ...(runningSprintId ? { runningSprintId } : {}) })
  } catch (err) {
    console.error('Manual sync failed: ' + err)
    Sentry.captureException(err)
    return c.json({ error: 'sync failed' }, 500)
  }
})

app.openapi(syncStatusRoute, async (c) => {
  try {
    return c.json(await coordinator(c.env).getStatus())
  } catch (err) {
    console.error('Sync status failed: ' + err)
    Sentry.captureException(err)
    return c.json({ error: 'status failed' }, 500)
  }
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

// Single named SyncCoordinator instance: all kicks (cron, manual) land on the same object, which
// is what gives the sync its shared progress state and its "one sync at a time" guarantee.
function coordinator(env: Env): DurableObjectStub<SyncCoordinator> {
  return env.SYNC_COORDINATOR.get(env.SYNC_COORDINATOR.idFromName('global'))
}

export default Sentry.withSentry(
  (env: Env) => ({
    dsn: env.SENTRY_DSN,
    enabled: Boolean(env.SENTRY_DSN),
    tracesSampleRate: 1.0,
    enableLogs: true,
  }),
  {
    fetch: (request, env, ctx?) => app.fetch(request, env, ctx),
    // Watchdog: wakes the DO every 5 min; the alarm chain does the real looping.
    scheduled: async (_controller, env) => {
      await coordinator(env).kick()
    },
  } satisfies ExportedHandler<Env>,
)
