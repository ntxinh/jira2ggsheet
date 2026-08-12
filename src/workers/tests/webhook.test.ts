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

    await expect(scheduled({ cron: '0 0 * * *' }, testEnv)).resolves.toEqual({ issuesSynced: 1, issuesFailed: 1 })

    const jql = 'project = TEST AND sprint = 42 ORDER BY created ASC'
    expect(searchIssuesMock).toHaveBeenCalledWith(jql, 'acme', 'jira@example.com', 'jira-token')
    expect(upsertIssueMock).toHaveBeenCalledTimes(2)
  })

  it('reports per-issue failures to Sentry', async () => {
    searchIssuesMock.mockResolvedValue([{ key: 'ABC-1', fields: {} }])
    upsertIssueMock.mockRejectedValueOnce(new Error('sheets down'))

    const module = await import('../index')
    const { scheduled } = module.default as unknown as { scheduled: (c: { cron: string }, env: typeof testEnv) => Promise<void> }

    await scheduled({ cron: '0 0 * * *' }, testEnv)

    expect(captureExceptionMock).toHaveBeenCalledTimes(1)
    expect(captureExceptionMock).toHaveBeenCalledWith(expect.any(Error))
  })
})
