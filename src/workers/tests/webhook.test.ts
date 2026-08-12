import { describe, it, expect, vi, afterEach } from 'vitest'
import index from '../index'
import { testEnv } from './mock-env'
import { searchIssues } from '../jira'
import { upsertIssue } from '../sheetWriter'

vi.mock('../jira', () => ({ searchIssues: vi.fn() }))
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

import { captureException } from '@sentry/cloudflare'

const captureExceptionMock = vi.mocked(captureException)

const searchIssuesMock = vi.mocked(searchIssues)
const upsertIssueMock = vi.mocked(upsertIssue)

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
  it('runs JQL search and upserts each issue, tolerating per-issue failure', async () => {
    searchIssuesMock.mockResolvedValue([
      { key: 'ABC-1', fields: {} },
      { key: 'ABC-2', fields: {} },
    ])
    upsertIssueMock.mockRejectedValueOnce(new Error('sheets down'))

    const module = await import('../index')
    const { scheduled } = module.default as unknown as { scheduled: (c: { cron: string }, env: typeof testEnv) => Promise<void> }

    await expect(scheduled({ cron: '*/15 * * * *' }, testEnv)).resolves.toEqual({ issuesSynced: 1, issuesFailed: 1, totalIssues: 2, chunkSize: 50, chunkIndex: 0 })

    const jql = 'project = TEST AND sprint = 42 ORDER BY created ASC'
    expect(searchIssuesMock).toHaveBeenCalledWith(jql, 'acme', 'jira@example.com', 'jira-token')
    expect(upsertIssueMock).toHaveBeenCalledTimes(2)
  })

  it('reports per-issue failures to Sentry', async () => {
    searchIssuesMock.mockResolvedValue([{ key: 'ABC-1', fields: {} }])
    upsertIssueMock.mockRejectedValueOnce(new Error('sheets down'))

    const module = await import('../index')
    const { scheduled } = module.default as unknown as { scheduled: (c: { cron: string }, env: typeof testEnv) => Promise<void> }

    await scheduled({ cron: '*/15 * * * *' }, testEnv)

    expect(captureExceptionMock).toHaveBeenCalledTimes(1)
    expect(captureExceptionMock).toHaveBeenCalledWith(expect.any(Error))
  })

  it('processes one rotating chunk per 15-minute tick so large sprints stay under quota', async () => {
    const issues = Array.from({ length: 120 }, (_, i) => ({ key: `ABC-${i + 1}`, fields: {} }))
    searchIssuesMock.mockResolvedValue(issues)

    const module = await import('../index')
    const { scheduled } = module.default as unknown as { scheduled: (c: { cron: string }, env: typeof testEnv) => Promise<void> }

    vi.useFakeTimers()
    vi.setSystemTime(new Date(0)) // tick slot 0 of ceil(120/50)=3 chunks
    await scheduled({ cron: '*/15 * * * *' }, testEnv)
    expect(upsertIssueMock).toHaveBeenCalledTimes(50)
    expect(vi.mocked(upsertIssueMock).mock.calls[0][1].key).toBe('ABC-1')
    expect(vi.mocked(upsertIssueMock).mock.calls[49][1].key).toBe('ABC-50')

    upsertIssueMock.mockClear()
    vi.setSystemTime(new Date(900_000)) // +15 min, slot 1
    await scheduled({ cron: '*/15 * * * *' }, testEnv)
    expect(upsertIssueMock).toHaveBeenCalledTimes(50)
    expect(vi.mocked(upsertIssueMock).mock.calls[0][1].key).toBe('ABC-51')
  })

  it('paces upserts so the per-minute Sheets quota is respected', async () => {
    searchIssuesMock.mockResolvedValue([
      { key: 'ABC-1', fields: {} },
      { key: 'ABC-2', fields: {} },
    ])

    const module = await import('../index')
    const { scheduled } = module.default as unknown as { scheduled: (c: { cron: string }, env: typeof testEnv) => Promise<void> }

    vi.useFakeTimers()
    vi.setSystemTime(new Date(0))
    const env = { ...testEnv, SYNC_DELAY_MS: '4000' }
    const p = scheduled({ cron: '*/15 * * * *' }, env)

    await vi.advanceTimersByTimeAsync(100)
    expect(upsertIssueMock).toHaveBeenCalledTimes(1) // first issue upserted immediately
    await vi.advanceTimersByTimeAsync(4000) // pacing delay elapses
    expect(upsertIssueMock).toHaveBeenCalledTimes(2) // second issue only after the delay
    await vi.advanceTimersByTimeAsync(4000) // trailing delay after the last issue
    await p
    expect(upsertIssueMock).toHaveBeenCalledTimes(2)
  })
})

describe('GET /sync — manual sprint sync', () => {
  it('syncs the sprintId from the query param and returns counts', async () => {
    searchIssuesMock.mockResolvedValue([
      { key: 'ABC-1', fields: {} },
      { key: 'ABC-2', fields: {} },
    ])

    const res = await index.fetch(new Request(new URL('/sync?sprintId=99', 'http://localhost'), { method: 'GET' }), testEnv)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ sprintId: '99', issuesSynced: 2, issuesFailed: 0, totalIssues: 2, chunkSize: 50, chunkIndex: 0 })
    expect(searchIssuesMock).toHaveBeenCalledWith('project = TEST AND sprint = 99 ORDER BY created ASC', 'acme', 'jira@example.com', 'jira-token')
  })

  it('falls back to env SPRINT_ID when sprintId omitted', async () => {
    searchIssuesMock.mockResolvedValue([])

    const res = await index.fetch(new Request(new URL('/sync', 'http://localhost'), { method: 'GET' }), testEnv)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ sprintId: '42', issuesSynced: 0, issuesFailed: 0, totalIssues: 0, chunkSize: 50, chunkIndex: 0 })
    expect(searchIssuesMock).toHaveBeenCalledWith('project = TEST AND sprint = 42 ORDER BY created ASC', 'acme', 'jira@example.com', 'jira-token')
  })

  it('counts failed upserts', async () => {
    searchIssuesMock.mockResolvedValue([{ key: 'ABC-1', fields: {} }])
    upsertIssueMock.mockRejectedValueOnce(new Error('sheets down'))

    const res = await index.fetch(new Request(new URL('/sync?sprintId=7', 'http://localhost'), { method: 'GET' }), testEnv)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ sprintId: '7', issuesSynced: 0, issuesFailed: 1, totalIssues: 1, chunkSize: 50, chunkIndex: 0 })
  })

  it('returns 500 when the Jira search fails', async () => {
    searchIssuesMock.mockRejectedValueOnce(new Error('jira down'))

    const res = await index.fetch(new Request(new URL('/sync?sprintId=7', 'http://localhost'), { method: 'GET' }), testEnv)
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'sync failed' })
  })

  it('returns 400 for a non-numeric sprintId', async () => {
    const res = await index.fetch(new Request(new URL('/sync?sprintId=1%20OR%20sprint%20=%202', 'http://localhost'), { method: 'GET' }), testEnv)
    expect(res.status).toBe(400)
  })
})
