import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import index from '../index'
import { testEnv, makeCoordinatorNamespace } from './mock-env'
import type { KickResult } from '../syncCoordinator'
import { captureException } from '@sentry/cloudflare'
import { isWithinTicketWindow } from '../chat'
import { upsertIssue } from '../sheetWriter'

vi.mock('../sheetWriter', () => ({
  upsertIssue: vi.fn().mockResolvedValue(undefined),
  withToken: vi.fn((_email: string, _key: string, fn: (token: string) => Promise<void>) => fn('token')),
  deleteIssue: vi.fn(),
  getOrCreateSprintSheet: vi.fn(),
}))
vi.mock('@sentry/cloudflare', () => ({
  withSentry: (_options: unknown, handler: unknown) => handler,
  captureException: vi.fn(),
}))

afterEach(() => {
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe('POST / — Jira webhook', () => {
  it('returns 401 when token query param is missing', async () => {
    const res = await index.fetch(new Request(new URL('/', 'http://localhost'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ webhookEvent: 'jira:issue_created', issue: { key: 'TEST-1', fields: {} } }),
    }), testEnv)
    expect(res.status).toBe(401)
    expect(await res.text()).toBe('unauthorized')
  })

  it('returns 401 when token is wrong', async () => {
    const res = await index.fetch(new Request(new URL('/?token=wrong', 'http://localhost'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ webhookEvent: 'jira:issue_created', issue: { key: 'TEST-1', fields: {} } }),
    }), testEnv)
    expect(res.status).toBe(401)
  })

  it('returns 400 for malformed JSON body', async () => {
    const res = await index.fetch(new Request(new URL('/?token=test-token', 'http://localhost'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json',
    }), testEnv)
    expect(res.status).toBe(400)
  })

  it('returns 400 for payload missing required fields', async () => {
    const res = await index.fetch(new Request(new URL('/?token=test-token', 'http://localhost'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }), testEnv)
    expect(res.status).toBe(400)
  })

  it('returns 200 for valid webhook with matching project', async () => {
    const res = await index.fetch(new Request(new URL('/?token=test-token', 'http://localhost'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        webhookEvent: 'jira:issue_created',
        issue: { key: 'TEST-1', fields: { project: { key: 'TEST' } } },
      }),
    }), testEnv)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')
  })

  it('returns 200 for valid webhook with non-matching project (ignored, not an error)', async () => {
    const res = await index.fetch(new Request(new URL('/?token=test-token', 'http://localhost'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        webhookEvent: 'jira:issue_created',
        issue: { key: 'OTHER-1', fields: { project: { key: 'OTHER' } } },
      }),
    }), testEnv)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')
  })

  it('returns 200 for unknown event type (ignored, not an error)', async () => {
    const res = await index.fetch(new Request(new URL('/?token=test-token', 'http://localhost'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        webhookEvent: 'jira:unknown_event',
        issue: { key: 'TEST-1', fields: { project: { key: 'TEST' } } },
      }),
    }), testEnv)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')
  })
})

describe('Google Chat notifications', () => {
  const chatUrl = 'https://chat.googleapis.com/v1/spaces/FAKE/messages?key=fake&token=fake'
  const newTicketUrl = 'https://chat.googleapis.com/v1/spaces/FAKE/messages?key=fake&token=new'
  const chatEnv = { ...testEnv, GOOGLE_CHAT_WEBHOOK: chatUrl, NEW_TICKET_GOOGLE_CHAT_WEBHOOK: newTicketUrl }

  const fullPayload = {
    webhookEvent: 'jira:issue_created',
    issue: {
      key: 'TEST-1',
      fields: {
        project: { key: 'TEST' },
        summary: 'Fix login bug',
        issuetype: { name: 'Bug' },
        status: { name: 'In Progress' },
        priority: { name: 'High' },
        assignee: { displayName: 'Binh Ho' },
        customfield_10016: [{ id: 123, name: 'Sprint 1' }],
      },
    },
  }

  function webhookRequest(body: unknown): Parameters<typeof index.fetch>[0] {
    return new Request(new URL('/?token=test-token', 'http://localhost'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }) as Parameters<typeof index.fetch>[0]
  }

  // The route fires notifications via c.executionCtx.waitUntil, so capture the promises and
  // await them to observe the side effect (mirrors the Worker runtime's waitUntil semantics).
  function captureWaitUntil(): { ctx: ExecutionContext; pending: Promise<unknown>[] } {
    const pending: Promise<unknown>[] = []
    const ctx = {
      waitUntil: (p: Promise<unknown>) => { pending.push(p) },
      passThroughOnException: () => {},
    } as unknown as ExecutionContext
    return { ctx, pending }
  }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-10T01:00:00Z')) // Mon 08:00 Vietnam (UTC+7)
    vi.mocked(upsertIssue).mockResolvedValue(true) // the sheet upsert appended a NEW row
  })

  it('posts a notification with issue details when GOOGLE_CHAT_WEBHOOK is set', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'))
    const { ctx, pending } = captureWaitUntil()

    const res = await index.fetch(webhookRequest(fullPayload), chatEnv, ctx)
    await Promise.all(pending)

    expect(res.status).toBe(200)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe(newTicketUrl)
    const body = JSON.parse(init?.body as string)
    expect(body.text).toContain('jira:issue_created — TEST-1')
    expect(body.text).toContain('Fix login bug')
    expect(body.text).toContain('Bug · In Progress · High')
    expect(body.text).toContain('Assignee: Binh Ho')
    expect(body.text).toContain('Sprint: Sprint 1')
    expect(body.text).toContain('https://acme.atlassian.net/browse/TEST-1')
  })

  it('posts issue_created to NEW_TICKET_GOOGLE_CHAT_WEBHOOK instead', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'))
    const { ctx, pending } = captureWaitUntil()

    const res = await index.fetch(webhookRequest(fullPayload), chatEnv, ctx)
    await Promise.all(pending)

    expect(res.status).toBe(200)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(fetchSpy.mock.calls[0][0]).toBe(newTicketUrl)
  })

  it('falls back to GOOGLE_CHAT_WEBHOOK for issue_created when NEW_TICKET_GOOGLE_CHAT_WEBHOOK is unset', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'))
    const { ctx, pending } = captureWaitUntil()
    const env = { ...chatEnv, NEW_TICKET_GOOGLE_CHAT_WEBHOOK: undefined }

    const res = await index.fetch(webhookRequest(fullPayload), env, ctx)
    await Promise.all(pending)

    expect(fetchSpy.mock.calls[0][0]).toBe(chatUrl)
  })

  it('posts issue_created outside the weekday 8-18h window to GOOGLE_CHAT_WEBHOOK', async () => {
    vi.setSystemTime(new Date('2026-08-10T11:00:00Z')) // Mon 18:00 Vietnam
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'))
    const { ctx, pending } = captureWaitUntil()

    const res = await index.fetch(webhookRequest(fullPayload), chatEnv, ctx)
    await Promise.all(pending)

    expect(fetchSpy.mock.calls[0][0]).toBe(chatUrl)
  })

  it('posts issue_created on a weekend to GOOGLE_CHAT_WEBHOOK', async () => {
    vi.setSystemTime(new Date('2026-08-15T01:00:00Z')) // Sat 08:00 Vietnam
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'))
    const { ctx, pending } = captureWaitUntil()

    const res = await index.fetch(webhookRequest(fullPayload), chatEnv, ctx)
    await Promise.all(pending)

    expect(fetchSpy.mock.calls[0][0]).toBe(chatUrl)
  })

  it('does not post for ignored webhooks (non-matching project)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'))
    const { ctx, pending } = captureWaitUntil()

    const res = await index.fetch(webhookRequest({
      webhookEvent: 'jira:issue_created',
      issue: { key: 'OTHER-1', fields: { project: { key: 'OTHER' }, assignee: { displayName: 'Binh Ho' } } },
    }), chatEnv, ctx)
    await Promise.all(pending)

    expect(res.status).toBe(200)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('does not post when the issue already exists in the sheet (upsert found the key)', async () => {
    vi.mocked(upsertIssue).mockResolvedValueOnce(false)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'))
    const { ctx, pending } = captureWaitUntil()

    const res = await index.fetch(webhookRequest(fullPayload), chatEnv, ctx)
    await Promise.all(pending)

    expect(res.status).toBe(200)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('does not post when the new issue is assigned to someone else', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'))
    const { ctx, pending } = captureWaitUntil()

    const res = await index.fetch(webhookRequest({
      ...fullPayload,
      issue: { ...fullPayload.issue, fields: { ...fullPayload.issue.fields, assignee: { displayName: 'John Doe' } } },
    }), chatEnv, ctx)
    await Promise.all(pending)

    expect(res.status).toBe(200)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('does not post when GOOGLE_CHAT_WEBHOOK is unset', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'))
    const { ctx, pending } = captureWaitUntil()

    const res = await index.fetch(webhookRequest(fullPayload), testEnv, ctx)
    await Promise.all(pending)

    expect(res.status).toBe(200)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('still returns ok and reports to Sentry when the Chat POST fails (with fallback attempt)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('chat down'))
    const { ctx, pending } = captureWaitUntil()

    const res = await index.fetch(webhookRequest(fullPayload), chatEnv, ctx)
    await Promise.all(pending)

    expect(res.status).toBe(200)
    // NEW_TICKET then GOOGLE_CHAT fallback, both fail
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(fetchSpy.mock.calls[0][0]).toBe(newTicketUrl)
    expect(fetchSpy.mock.calls[1][0]).toBe(chatUrl)
    expect(captureException).toHaveBeenCalledWith(expect.any(Error))
  })

  it('falls back to GOOGLE_CHAT_WEBHOOK when NEW_TICKET_GOOGLE_CHAT_WEBHOOK returns non-2xx', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('gone', { status: 404 }))
      .mockResolvedValueOnce(new Response('ok'))
    const { ctx, pending } = captureWaitUntil()

    const res = await index.fetch(webhookRequest(fullPayload), chatEnv, ctx)
    await Promise.all(pending)

    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(fetchSpy.mock.calls[0][0]).toBe(newTicketUrl)
    expect(fetchSpy.mock.calls[1][0]).toBe(chatUrl)
    expect(captureException).not.toHaveBeenCalled()
  })

  it('reports a non-2xx Chat response to Sentry instead of swallowing it', async () => {
    // Outside the window -> only GOOGLE_CHAT, no fallback to mask the failure.
    vi.setSystemTime(new Date('2026-08-10T11:00:00Z'))
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('bad', { status: 500 }))
    const { ctx, pending } = captureWaitUntil()

    const res = await index.fetch(webhookRequest(fullPayload), chatEnv, ctx)
    await Promise.all(pending)

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(captureException).toHaveBeenCalledWith(expect.any(Error))
  })
})

describe('isWithinTicketWindow', () => {
  it('is true on a weekday between 08:00 and 18:00 Vietnam time', () => {
    expect(isWithinTicketWindow(new Date('2026-08-10T01:00:00Z'))).toBe(true) // Mon 08:00
    expect(isWithinTicketWindow(new Date('2026-08-14T10:59:00Z'))).toBe(true) // Fri 17:59
  })

  it('is false at or after 18:00 Vietnam time', () => {
    expect(isWithinTicketWindow(new Date('2026-08-10T11:00:00Z'))).toBe(false) // Mon 18:00
    expect(isWithinTicketWindow(new Date('2026-08-10T13:30:00Z'))).toBe(false) // Mon 20:30
  })

  it('is false before 08:00 Vietnam time', () => {
    expect(isWithinTicketWindow(new Date('2026-08-10T00:59:00Z'))).toBe(false) // Mon 07:59
  })

  it('is false on weekends', () => {
    expect(isWithinTicketWindow(new Date('2026-08-15T01:00:00Z'))).toBe(false) // Sat 08:00
    expect(isWithinTicketWindow(new Date('2026-08-16T06:00:00Z'))).toBe(false) // Sun 13:00
  })

  it('is false in the small hours when the UTC date is still the previous (weekend) day', () => {
    expect(isWithinTicketWindow(new Date('2026-08-09T17:00:00Z'))).toBe(false) // Sun 24:00 = Mon 00:00 VN
  })
})

describe('GET / — method not allowed', () => {
  it('returns 405 for GET', async () => {
    const res = await index.fetch(new Request(new URL('/', 'http://localhost'), { method: 'GET' }), testEnv)
    expect(res.status).toBe(405)
  })

  it('returns 405 for PUT', async () => {
    const res = await index.fetch(new Request(new URL('/', 'http://localhost'), { method: 'PUT' }), testEnv)
    expect(res.status).toBe(405)
  })

  it('returns 405 for DELETE', async () => {
    const res = await index.fetch(new Request(new URL('/', 'http://localhost'), { method: 'DELETE' }), testEnv)
    expect(res.status).toBe(405)
  })
})

describe('GET /openapi.json', () => {
  it('returns valid OpenAPI spec', async () => {
    const res = await index.fetch(new Request(new URL('/openapi.json', 'http://localhost'), { method: 'GET' }), testEnv)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    const spec = await res.json() as Record<string, unknown>
    expect(spec.openapi).toBeDefined()
    expect(spec.info).toBeDefined()
    expect(spec.paths).toBeDefined()
    const paths = spec.paths as Record<string, unknown>
    expect(paths['/']).toBeDefined()
    const rootPath = paths['/'] as Record<string, unknown>
    expect(rootPath.post).toBeDefined()
  })
})

describe('GET /docs', () => {
  it('returns Scalar HTML page', async () => {
    const res = await index.fetch(new Request(new URL('/docs', 'http://localhost'), { method: 'GET' }), testEnv)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
  })
})

describe('scheduled — sprint cron sync', () => {
  it('wakes the SyncCoordinator DO on each cron tick', async () => {
    const kick = vi.fn(async (): Promise<KickResult> => ({ status: 'started', sprintId: '42' }))
    const env = { ...testEnv, SYNC_COORDINATOR: makeCoordinatorNamespace({ kick }) }

    const module = await import('../index')
    const { scheduled } = module.default as unknown as { scheduled: (c: { cron: string }, env: typeof testEnv) => Promise<void> }

    await scheduled({ cron: '*/5 * * * *' }, env)

    expect(kick).toHaveBeenCalledTimes(1)
  })
})

describe('GET /sync — manual sprint sync', () => {
  it('kicks the DO with the sprintId from the query param and reports started', async () => {
    const kick = vi.fn(async (): Promise<KickResult> => ({ status: 'started', sprintId: '99' }))
    const env = { ...testEnv, SYNC_COORDINATOR: makeCoordinatorNamespace({ kick }) }

    const res = await index.fetch(new Request(new URL('/sync?sprintId=99', 'http://localhost'), { method: 'GET' }), env)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ sprintId: '99', sprintIds: ['99'], status: 'started' })
    expect(kick).toHaveBeenCalledWith('99')
  })

  it('falls back to env SPRINT_ID when sprintId omitted', async () => {
    const kick = vi.fn(async (): Promise<KickResult> => ({ status: 'started', sprintId: '42' }))
    const env = { ...testEnv, SYNC_COORDINATOR: makeCoordinatorNamespace({ kick }) }

    const res = await index.fetch(new Request(new URL('/sync', 'http://localhost'), { method: 'GET' }), env)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ sprintId: '42', sprintIds: ['42'], status: 'started' })
    expect(kick).toHaveBeenCalledWith(undefined) // kick resolves the env list itself
  })

  it('syncs a comma-separated SPRINT_ID list when sprintId omitted', async () => {
    const kick = vi.fn(async (): Promise<KickResult> => ({ status: 'started', sprintId: '42' }))
    const env = { ...testEnv, SPRINT_ID: '42,43', SYNC_COORDINATOR: makeCoordinatorNamespace({ kick }) }

    const res = await index.fetch(new Request(new URL('/sync', 'http://localhost'), { method: 'GET' }), env)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ sprintId: '42', sprintIds: ['42', '43'], status: 'started' })
    expect(kick).toHaveBeenCalledWith(undefined)
  })

  it('reports in_progress when a sync is already running', async () => {
    const env = { ...testEnv, SYNC_COORDINATOR: makeCoordinatorNamespace({ kick: vi.fn(async (): Promise<KickResult> => ({ status: 'in_progress', sprintId: '99' })) }) }

    const res = await index.fetch(new Request(new URL('/sync?sprintId=99', 'http://localhost'), { method: 'GET' }), env)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ sprintId: '99', sprintIds: ['99'], status: 'in_progress' })
  })

  it('reports which sprint is actually running when a different one is requested', async () => {
    const env = { ...testEnv, SYNC_COORDINATOR: makeCoordinatorNamespace({ kick: vi.fn(async (): Promise<KickResult> => ({ status: 'in_progress', sprintId: '42' })) }) }

    const res = await index.fetch(new Request(new URL('/sync?sprintId=99', 'http://localhost'), { method: 'GET' }), env)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ sprintId: '99', sprintIds: ['99'], status: 'in_progress', runningSprintId: '42' })
  })

  it('returns 400 for a non-numeric sprintId', async () => {
    const res = await index.fetch(new Request(new URL('/sync?sprintId=1%20OR%20sprint%20=%202', 'http://localhost'), { method: 'GET' }), testEnv)
    expect(res.status).toBe(400)
  })

  it('returns 500 when waking the DO fails', async () => {
    const env = { ...testEnv, SYNC_COORDINATOR: makeCoordinatorNamespace({ kick: vi.fn(async (): Promise<KickResult> => { throw new Error('do down') }) }) }

    const res = await index.fetch(new Request(new URL('/sync?sprintId=7', 'http://localhost'), { method: 'GET' }), env)
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'sync failed' })
  })
})

describe('GET /sync/status — sync progress', () => {
  it('reports idle when no sync is running', async () => {
    const res = await index.fetch(new Request(new URL('/sync/status', 'http://localhost'), { method: 'GET' }), testEnv)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ running: false })
  })

  it('reports progress while a sync is running', async () => {
    const getStatus = async () => ({ running: true, sprintId: '42', pagesDone: 2, rowsWritten: 150, startedAt: 1000, updatedAt: 2000 })
    const env = { ...testEnv, SYNC_COORDINATOR: makeCoordinatorNamespace({ getStatus }) }

    const res = await index.fetch(new Request(new URL('/sync/status', 'http://localhost'), { method: 'GET' }), env)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ running: true, sprintId: '42', pagesDone: 2, rowsWritten: 150, startedAt: 1000, updatedAt: 2000 })
  })
})
