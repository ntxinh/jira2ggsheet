import { describe, it, expect, vi, afterEach } from 'vitest'
import { searchIssuesPage, fetchSprintName } from '../jira'
import type { JiraIssue } from '../fieldExtractor'

const PAGE_SIZE = 100

const issue = (key: string): JiraIssue => ({ key, fields: { summary: key } })

afterEach(() => { vi.unstubAllGlobals() })

describe('searchIssuesPage', () => {
  it('builds URL and Basic auth header for the first page', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> })
      return new Response(JSON.stringify({
        issues: [issue('ABC-1')],
        isLast: true,
      }))
    }))

    const page = await searchIssuesPage('project = ABC ORDER BY created ASC', 'acme', 'me@x.com', 'tok')

    expect(calls.length).toBe(1)
    expect(calls[0].url).toContain('https://acme.atlassian.net/rest/api/3/search/jql')
    expect(calls[0].url).not.toContain('startAt=')
    expect(calls[0].url).toContain('fields=*all')
    expect(calls[0].url).toContain('maxResults=100')
    expect(calls[0].url).not.toContain('nextPageToken=')
    expect(calls[0].url).toContain('jql=project%20%3D%20ABC%20ORDER%20BY%20created%20ASC')
    expect(calls[0].headers.Authorization).toBe('Basic ' + btoa('me@x.com:tok'))
    expect(page.issues).toEqual([{ key: 'ABC-1', fields: { summary: 'ABC-1' } }])
    expect(page.isLast).toBe(true)
    expect(page.nextPageToken).toBeUndefined()
  })

  it('passes a narrow field list through to the API', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url)
      return new Response(JSON.stringify({ issues: [], isLast: true }))
    }))

    await searchIssuesPage('jql-here', 'acme', 'me@x.com', 'tok', undefined, 'summary,status,issuetype')

    expect(calls[0]).toContain('fields=summary%2Cstatus%2Cissuetype')
  })

  it('passes nextPageToken on subsequent pages and honors isLast', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url)
      const token = new URL(url).searchParams.get('nextPageToken')
      if (token === 'page-1') {
        return new Response(JSON.stringify({ issues: [issue('ABC-101')], isLast: true }))
      }
      return new Response(JSON.stringify({ issues: [issue('ABC-1')], nextPageToken: 'page-1', isLast: false }))
    }))

    const first = await searchIssuesPage('jql-here', 'acme', 'me@x.com', 'tok')
    expect(first.nextPageToken).toBe('page-1')
    expect(first.isLast).toBe(false)

    const second = await searchIssuesPage('jql-here', 'acme', 'me@x.com', 'tok', 'page-1')
    expect(second.issues[0].key).toBe('ABC-101')
    expect(second.isLast).toBe(true)
    expect(calls[1]).toContain('nextPageToken=page-1')
  })

  it('treats a missing nextPageToken as the last page even without isLast', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Response(JSON.stringify({ issues: [issue('ABC-1')] }))))
    const page = await searchIssuesPage('jql-here', 'acme', 'me@x.com', 'tok')
    expect(page.isLast).toBe(true)
  })

  it('throws on non-OK response', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Response('nope', { status: 401 })))
    await expect(searchIssuesPage('x', 'acme', 'a', 'b')).rejects.toThrow('Jira search 401')
  })
})

describe('fetchSprintName', () => {
  it('fetches the sprint name from the Agile API with Basic auth', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> })
      return new Response(JSON.stringify({ id: 123, name: 'Sprint 12', state: 'active' }))
    }))

    const name = await fetchSprintName('123', 'acme', 'me@x.com', 'tok')

    expect(calls.length).toBe(1)
    expect(calls[0].url).toBe('https://acme.atlassian.net/rest/agile/1.0/sprint/123')
    expect(calls[0].headers.Authorization).toBe('Basic ' + btoa('me@x.com:tok'))
    expect(name).toBe('Sprint 12')
  })

  it('throws on non-OK response (e.g. sprint deleted → 404)', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Response('gone', { status: 404 })))
    await expect(fetchSprintName('123', 'acme', 'a', 'b')).rejects.toThrow('Jira sprint 404')
  })
})
