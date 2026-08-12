import { describe, it, expect, vi, afterEach } from 'vitest'
import { searchIssues } from '../jira'
import type { JiraIssue } from '../fieldExtractor'

const PAGE_SIZE = 100

const issue = (key: string): JiraIssue => ({ key, fields: { summary: key } })

afterEach(() => { vi.unstubAllGlobals() })

describe('searchIssues', () => {
  it('builds URL and Basic auth header, paginates via nextPageToken to the last page', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> })
      const token = new URL(url).searchParams.get('nextPageToken')
      let startAt = 0
      if (token) {
        const m = token.match(/^page-(\d+)$/)
        if (m) startAt = Number(m[1]) * PAGE_SIZE
      }
      const total = 150
      const issues = Array.from({ length: Math.min(PAGE_SIZE, total - startAt) }, (_, i) => issue(`ABC-${startAt + i + 1}`))
      const next = startAt + PAGE_SIZE
      return new Response(JSON.stringify({
        issues,
        isLast: next >= total,
        ...(next < total ? { nextPageToken: `page-${next / PAGE_SIZE}` } : {}),
      }))
    }))

    const result = await searchIssues('project = ABC ORDER BY created ASC', 'acme', 'me@x.com', 'tok')

    expect(calls.length).toBe(2)
    expect(calls[0].url).toContain('https://acme.atlassian.net/rest/api/3/search/jql')
    expect(calls[0].url).not.toContain('startAt=')
    expect(calls[0].url).toContain('fields=*all')
    expect(calls[0].url).toContain('maxResults=100')
    expect(calls[0].url).toContain('jql=project%20%3D%20ABC%20ORDER%20BY%20created%20ASC')
    expect(calls[0].headers.Authorization).toBe('Basic ' + btoa('me@x.com:tok'))
    expect(calls[1].url).toContain('nextPageToken=page-1')
    expect(result.length).toBe(150)
    expect(result[0].key).toBe('ABC-1')
    expect(result[149].key).toBe('ABC-150')
  })

  it('throws on non-OK response', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Response('nope', { status: 401 })))
    await expect(searchIssues('x', 'acme', 'a', 'b')).rejects.toThrow('Jira search 401')
  })
})
