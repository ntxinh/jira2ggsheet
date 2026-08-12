import { OpenAPIHono, createRoute } from '@hono/zod-openapi'
import { apiReference } from '@scalar/hono-api-reference'
import * as Sentry from '@sentry/cloudflare'
import { getConfig, type Env } from './config'
import { searchIssues } from './jira'
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

async function syncSprint(_controller: ScheduledController, env: Env): Promise<void> {
  const config = getConfig(env)
  const jql = `project = ${config.PROJECT_KEY} AND sprint = ${config.SPRINT_ID} ORDER BY created ASC`
  const issues = await searchIssues(jql, config.JIRA_SUBDOMAIN, env.JIRA_EMAIL, env.JIRA_API_TOKEN)
  // ponytail: upsertIssue picks the tab by the issue's sprint field (active/last), same rule as the webhook. An issue in two active sprints may land elsewhere — accepted.
  await withToken(
    env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    env.GOOGLE_PRIVATE_KEY,
    async (token) => {
      for (const issue of issues) {
        try {
          await upsertIssue(env.SPREADSHEET_ID, issue, token, config)
        } catch (err) {
          console.error(`Sprint sync failed for ${issue.key}: ${err}`)
          Sentry.captureException(err)
        }
      }
    },
  )
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
    scheduled: syncSprint,
  } satisfies ExportedHandler<Env>,
)
