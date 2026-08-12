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