import { describe, it, expect, vi, afterEach } from 'vitest'
import { upsertIssue } from '../sheetWriter'
import type { Config } from '../config'

const config: Config = {
  SPREADSHEET_ID: 'ssid',
  TEMPLATE_SHEET: 'Template',
  KEY_COLUMN: 'C',
  HEADER_ROWS: 1,
  DELETE_MODE: 'delete',
  PROJECT_KEY: 'TEST',
  SPRINT_ID: '7',
  JIRA_SUBDOMAIN: 'acme',
  COLUMN_MAP: { B: 'issueKey', C: 'sprintId' },
  CUSTOM_FIELDS: { sprint: 'customfield_10016', storyPoints: 'customfield_10018' },
  DATE_FORMAT: 'yyyy-MM-dd',
  TIMEZONE: 'UTC',
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

function stubSheets(): Array<{ url: string; method: string | undefined }> {
  const calls: Array<{ url: string; method: string | undefined }> = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, method: init?.method })
    if (url.endsWith(`/spreadsheets/${config.SPREADSHEET_ID}`)) {
      return json({
        sheets: [
          { properties: { sheetId: 1, title: 'Template' } },
          { properties: { sheetId: 2, title: '7_S1' } },
          { properties: { sheetId: 3, title: '8_S2' } },
          { properties: { sheetId: 4, title: '9_S3' } },
        ],
      })
    }
    if (url.includes(':batchGet')) {
      const u = new URL(url)
      return json({
        valueRanges: u.searchParams.getAll('ranges').map((range) => ({
          range,
          values: range.includes('7_S1') ? [['HDR'], ['TEST-1']] : [['HDR']],
        })),
      })
    }
    if (url.includes(':batchUpdate')) return json({ replies: [] })
    if (url.includes('/values/')) return json({})
    return json({})
  })
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('upsertIssue read amplification', () => {
  it('reads all tab key columns in one batchGet regardless of tab count', async () => {
    const calls = stubSheets()
    const issue = { key: 'TEST-1', fields: { customfield_10016: [{ id: 7, name: 'S1', state: 'active' }] } }

    await upsertIssue(config.SPREADSHEET_ID, issue, 'token', config)

    const reads = calls.filter((c) => !c.method || c.method === 'GET')
    expect(reads).toHaveLength(2) // 1 metadata + 1 batchGet

    const perTabReads = reads.filter((c) => c.url.includes('/values/') && !c.url.includes(':batchGet'))
    expect(perTabReads).toHaveLength(0) // no N-per-tab values.get calls

    const batchGet = calls.find((c) => c.url.includes(':batchGet'))
    expect(batchGet).toBeDefined()
    const ranges = new URL(batchGet!.url).searchParams.getAll('ranges')
    expect(ranges).toEqual(['8_S2!C:C', '9_S3!C:C', '7_S1!C:C'])
  })
})

describe('apiFetch 429 handling', () => {
  const issue = { key: 'TEST-1', fields: { customfield_10016: [{ id: 7, name: 'S1', state: 'active' }] } }

  it('retries a 429 quota error with backoff and succeeds', async () => {
    vi.useFakeTimers()
    let metaCalls = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith(`/spreadsheets/${config.SPREADSHEET_ID}`)) {
        metaCalls++
        if (metaCalls === 1) return new Response('quota exceeded', { status: 429 })
        return json({
          sheets: [
            { properties: { sheetId: 1, title: 'Template' } },
            { properties: { sheetId: 2, title: '7_S1' } },
          ],
        })
      }
      if (url.includes(':batchGet')) {
        const u = new URL(url)
        return json({
          valueRanges: u.searchParams.getAll('ranges').map((range) => ({ range, values: [['HDR']] })),
        })
      }
      if (url.includes(':batchUpdate')) return json({ replies: [] })
      if (url.includes('/values/')) return json({})
      return json({})
    })

    const p = upsertIssue(config.SPREADSHEET_ID, issue, 'token', config)
    await vi.advanceTimersByTimeAsync(1200) // 1s backoff (+10% jitter) elapses, retry succeeds
    await p
    expect(metaCalls).toBe(2)
  })

  it('gives up with an error after repeated 429s', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(() => new Response('quota exceeded', { status: 429 }))
    vi.stubGlobal('fetch', fetchMock)

    const p = upsertIssue(config.SPREADSHEET_ID, issue, 'token', config)
    const assertion = expect(p).rejects.toThrow('Sheets API 429') // attach handler before the rejection fires
    await vi.advanceTimersByTimeAsync(7800) // 3 backoff steps (1s/2s/4s +10% jitter), 4th attempt fails
    await assertion
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })
})