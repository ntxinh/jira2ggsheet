import { describe, it, expect, vi, afterEach } from 'vitest'
import index from '../index'
import { testEnv, makeCoordinatorNamespace } from './mock-env'
import type { KickResult } from '../syncCoordinator'

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
    expect(await res.json()).toEqual({ sprintId: '99', status: 'started' })
    expect(kick).toHaveBeenCalledWith('99')
  })

  it('falls back to env SPRINT_ID when sprintId omitted', async () => {
    const kick = vi.fn(async (): Promise<KickResult> => ({ status: 'started', sprintId: '42' }))
    const env = { ...testEnv, SYNC_COORDINATOR: makeCoordinatorNamespace({ kick }) }

    const res = await index.fetch(new Request(new URL('/sync', 'http://localhost'), { method: 'GET' }), env)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ sprintId: '42', status: 'started' })
    expect(kick).toHaveBeenCalledWith('42')
  })

  it('reports in_progress when a sync is already running', async () => {
    const env = { ...testEnv, SYNC_COORDINATOR: makeCoordinatorNamespace({ kick: vi.fn(async (): Promise<KickResult> => ({ status: 'in_progress', sprintId: '99' })) }) }

    const res = await index.fetch(new Request(new URL('/sync?sprintId=99', 'http://localhost'), { method: 'GET' }), env)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ sprintId: '99', status: 'in_progress' })
  })

  it('reports which sprint is actually running when a different one is requested', async () => {
    const env = { ...testEnv, SYNC_COORDINATOR: makeCoordinatorNamespace({ kick: vi.fn(async (): Promise<KickResult> => ({ status: 'in_progress', sprintId: '42' })) }) }

    const res = await index.fetch(new Request(new URL('/sync?sprintId=99', 'http://localhost'), { method: 'GET' }), env)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ sprintId: '99', status: 'in_progress', runningSprintId: '42' })
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
