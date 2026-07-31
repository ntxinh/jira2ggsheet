import { describe, it, expect, vi, afterEach } from 'vitest'
import { searchIssues } from '../jira'
import type { JiraIssue } from '../fieldExtractor'

const issue = (key: string): JiraIssue => ({ key, fields: { summary: key } })

afterEach(() => { vi.unstubAllGlobals() })

describe('searchIssues', () => {
  it('builds URL and Basic auth header, paginates to total', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> })
      const startAt = Number(new URL(url).searchParams.get('startAt'))
      const total = 150
      const issues = Array.from({ length: 100 }, (_, i) => issue(`ABC-${startAt + i + 1}`))
      return new Response(JSON.stringify({ issues, total }))
    }))

    const result = await searchIssues('project = ABC ORDER BY created ASC', 'acme', 'me@x.com', 'tok')

    expect(calls.length).toBe(2)
    expect(calls[0].url).toContain('https://acme.atlassian.net/rest/api/3/search/jql')
    expect(calls[0].url).toContain('fields=*all')
    expect(calls[0].url).toContain('maxResults=100')
    expect(calls[0].url).toContain('jql=project%20%3D%20ABC%20ORDER%20BY%20created%20ASC')
    expect(calls[0].headers.Authorization).toBe('Basic ' + btoa('me@x.com:tok'))
    expect(calls[1].url).toContain('startAt=100')
    expect(result.length).toBe(200)
    expect(result[0].key).toBe('ABC-1')
    expect(result[199].key).toBe('ABC-200')
  })

  it('throws on non-OK response', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Response('nope', { status: 401 })))
    await expect(searchIssues('x', 'acme', 'a', 'b')).rejects.toThrow('Jira search 401')
  })
})
