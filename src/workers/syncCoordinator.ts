import { DurableObject } from 'cloudflare:workers'
import * as Sentry from '@sentry/cloudflare'
import { getConfig, type Config, type Env } from './config'
import { searchIssuesPage } from './jira'
import { syncSprintPage, withStoredToken } from './sheetWriter'

interface SyncState {
  sprintId: string
  nextPageToken?: string
  pagesDone: number
  rowsWritten: number
  startedAt: number
  updatedAt: number
  failures: number
}

export interface SyncStatus {
  running: boolean
  sprintId?: string
  pagesDone?: number
  rowsWritten?: number
  startedAt?: number
  updatedAt?: number
}

export interface KickResult {
  status: 'started' | 'in_progress'
  sprintId: string // the sprint the sync is actually for (may differ from the requested one)
}

const STATE_KEY = 'sync'
// 10ms CPU per invocation on the Free plan is mostly consumed by parsing one 100-issue Jira page
// + one batched sheet write; the RS256 JWT must be signed at most once per hour (withStoredToken).
const FIRST_TICK_MS = 1000
const PAGE_ALARM_MS = 3000 // pacing between pages, well under the Sheets 60 req/min/user quota
const BASE_BACKOFF_MS = 5000
const MAX_BACKOFF_MS = 5 * 60 * 1000
// If no page has completed for this long, the cron kick treats the in-progress marker as dead
// (e.g. the alarm chain crashed between storage.put and setAlarm) and restarts from page 0.
const STALE_MS = 4 * 60 * 1000

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
}

// Extending the runtime DurableObject base class (from the workerd-only module 'cloudflare:workers')
// is REQUIRED for RPC — the platform refuses stubs that don't. vitest resolves that module to a
// stub via resolve.alias in vitest.config.ts, so tests instantiate this class directly.
export class SyncCoordinator extends DurableObject<Env> {
  private readonly config: Config

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.config = getConfig(env)
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === 'GET' && url.pathname === '/status') {
      return json(await this.getStatus())
    }
    if (request.method === 'POST' && url.pathname === '/kick') {
      return json(await this.kick(url.searchParams.get('sprintId') ?? undefined))
    }
    return new Response('Not found', { status: 404 })
  }

  // Cron and GET /sync both land here. Starts a fresh sync when idle; keeps an in-progress one
  // running; restarts one whose marker has gone stale. The actual work happens in alarm ticks.
  async kick(sprintId?: string): Promise<KickResult> {
    const id = sprintId ?? this.env.SPRINT_ID
    const existing = await this.ctx.storage.get<SyncState>(STATE_KEY)
    if (existing && Date.now() - existing.updatedAt < STALE_MS) {
      return { status: 'in_progress', sprintId: existing.sprintId }
    }
    await this.ctx.storage.put<SyncState>(STATE_KEY, {
      sprintId: id,
      pagesDone: 0,
      rowsWritten: 0,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      failures: 0,
    })
    await this.ctx.storage.setAlarm(Date.now() + FIRST_TICK_MS)
    return { status: 'started', sprintId: id }
  }

  async getStatus(): Promise<SyncStatus> {
    const state = await this.ctx.storage.get<SyncState>(STATE_KEY)
    if (!state) return { running: false }
    return {
      running: true,
      sprintId: state.sprintId,
      pagesDone: state.pagesDone,
      rowsWritten: state.rowsWritten,
      startedAt: state.startedAt,
      updatedAt: state.updatedAt,
    }
  }

  // One unit of work per alarm: fetch one Jira page, write it to the sheet in a batch, persist the
  // cursor, then either schedule the next page (+PAGE_ALARM_MS) or clear the state when done.
  async alarm(): Promise<void> {
    const state = await this.ctx.storage.get<SyncState>(STATE_KEY)
    if (!state) return

    try {
      const { nextPageToken, rowsWritten, isLast } = await this.processPage(state)
      if (isLast) {
        await this.ctx.storage.delete(STATE_KEY)
        console.log(
          `Sync complete for sprint ${state.sprintId}: ${state.pagesDone + 1} pages, ${state.rowsWritten + rowsWritten} rows`,
        )
        return
      }
      await this.ctx.storage.put<SyncState>(STATE_KEY, {
        ...state,
        nextPageToken,
        pagesDone: state.pagesDone + 1,
        rowsWritten: state.rowsWritten + rowsWritten,
        updatedAt: Date.now(),
        failures: 0,
      })
      await this.ctx.storage.setAlarm(Date.now() + PAGE_ALARM_MS)
    } catch (err) {
      // Cursor not advanced: the next tick retries the same page (upserts are idempotent).
      console.error(`Sync page failed for sprint ${state.sprintId}: ${err}`)
      try {
        Sentry.captureException(err)
      } catch {
        // Sentry client may not be initialized in the DO isolate; never let telemetry kill a tick.
      }
      const backoff = Math.min(BASE_BACKOFF_MS * 2 ** state.failures, MAX_BACKOFF_MS)
      await this.ctx.storage.put<SyncState>(STATE_KEY, { ...state, failures: state.failures + 1 })
      await this.ctx.storage.setAlarm(Date.now() + backoff)
    }
  }

  private async processPage(
    state: SyncState,
  ): Promise<{ nextPageToken?: string; rowsWritten: number; isLast: boolean }> {
    const jql = `project = ${this.config.PROJECT_KEY} AND sprint = ${state.sprintId} ORDER BY created ASC`
    // Narrow field list: extractors only read these, and *all (comments, attachments, ...) can
    // push a 100-issue page past the Free plan's 10ms CPU budget on JSON.parse alone.
    const fields = [
      'summary', 'status', 'issuetype', 'priority', 'assignee', 'created', 'labels',
      this.config.CUSTOM_FIELDS.sprint, this.config.CUSTOM_FIELDS.storyPoints,
    ].join(',')
    const page = await searchIssuesPage(
      jql,
      this.config.JIRA_SUBDOMAIN,
      this.env.JIRA_EMAIL,
      this.env.JIRA_API_TOKEN,
      state.nextPageToken,
      fields,
    )
    const result = await withStoredToken(
      this.ctx.storage,
      this.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      this.env.GOOGLE_PRIVATE_KEY,
      (token) => syncSprintPage(this.env.SPREADSHEET_ID, page.issues, token, this.config),
    )
    return { nextPageToken: page.nextPageToken, rowsWritten: result.rowsWritten, isLast: page.isLast }
  }
}
