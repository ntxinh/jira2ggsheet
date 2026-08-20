import { describe, it, expect, vi, afterEach } from 'vitest'
import { upsertIssue, syncSprintPage, withStoredToken, renameSprintTabs } from '../sheetWriter'
import { getAccessToken } from '../auth'
import type { Config } from '../config'

vi.mock('../auth', () => ({ getAccessToken: vi.fn() }))

const config: Config = {
  SPREADSHEET_ID: 'ssid',
  TEMPLATE_SHEET: 'Template',
  KEY_COLUMN: 'C',
  HEADER_ROWS: 1,
  DELETE_MODE: 'delete',
  PROJECT_KEY: 'TEST',
  SPRINT_IDS: ['7'],
  JIRA_SUBDOMAIN: 'acme',
  COLUMN_MAP: { B: 'issueKey', C: 'sprintId' },
  JIRA_ASSIGNEE_COLUMN: 'H',
  DEV_ASSIGNEE_COLUMN: 'I',
  PRESERVE_COLUMNS: ['J', 'N'],
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
        valueRanges: u.searchParams.getAll('ranges').map((range) => {
          const [t, cols] = range.split('!')
          const base = t.includes('7_S1') ? [['HDR'], ['TEST-1']] : [['HDR']]
          return { range, values: cols === `${config.KEY_COLUMN}:${config.KEY_COLUMN}` ? base : base.map(() => ['']) }
        }),
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
  vi.clearAllMocks()
})

describe('upsertIssue read amplification', () => {
  it('reads all tab key columns in one batchGet regardless of tab count', async () => {
    const calls = stubSheets()
    const issue = { key: 'TEST-1', fields: { customfield_10016: [{ id: 7, name: 'S1', state: 'active' }] } }

    await upsertIssue(config.SPREADSHEET_ID, issue, 'token', config)

    const reads = calls.filter((c) => !c.method || c.method === 'GET')
    expect(reads).toHaveLength(3) // 1 metadata + 2 batchGet (key columns + preserve I:J)

    const perTabReads = reads.filter((c) => c.url.includes('/values/') && !c.url.includes(':batchGet'))
    expect(perTabReads).toHaveLength(0) // no N-per-tab values.get calls

    const batchGets = calls.filter((c) => c.url.includes(':batchGet'))
    expect(batchGets).toHaveLength(2)
    const keyRead = batchGets.find((c) => new URL(c.url).searchParams.getAll('ranges').every((r) => r.endsWith('!C:C')))
    expect(keyRead).toBeDefined()
    expect(new URL(keyRead!.url).searchParams.getAll('ranges')).toEqual(['8_S2!C:C', '9_S3!C:C', '7_S1!C:C'])
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

describe('syncSprintPage', () => {
  const sheetsMeta = {
    sheets: [
      { properties: { sheetId: 1, title: 'Template' } },
      { properties: { sheetId: 2, title: '7_S1' } },
      { properties: { sheetId: 3, title: '8_S2' } },
      { properties: { sheetId: 4, title: '9_S3' } },
    ],
  }

function stubPageApi(options: { keyValues?: Record<string, string[][]>; preserve?: Record<string, string[][]> } = {}) {
  const calls: Array<{ url: string; method: string | undefined; body?: unknown }> = []
  const keyValues = options.keyValues ?? { '7_S1': [['HDR'], ['TEST-1']], '8_S2': [['HDR']], '9_S3': [['HDR']] }
  const preserveCols = [config.DEV_ASSIGNEE_COLUMN, ...config.PRESERVE_COLUMNS.filter((c) => c !== config.DEV_ASSIGNEE_COLUMN)]
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (url.endsWith(`/spreadsheets/${config.SPREADSHEET_ID}`)) {
      return json(sheetsMeta)
    }
    if (url.includes(':batchGet')) {
      const u = new URL(url)
      return json({
        valueRanges: u.searchParams.getAll('ranges').map((range) => {
          const [title, cols] = range.split('!')
          if (cols === `${config.KEY_COLUMN}:${config.KEY_COLUMN}`) {
            return { range, values: keyValues[title] ?? [['HDR']] }
          }
          const idx = preserveCols.indexOf(cols[0])
          const cells = options.preserve?.[title] ?? (keyValues[title] ?? [['HDR']]).map(() => ['', '', ''])
          return { range, values: cells.map((r) => [r[idx] ?? '']) }
        }),
      })
    }
    return json({ replies: [] })
  })
  return calls
}

  const sprint7 = { id: 7, name: 'S1', state: 'active' }

  it('updates existing rows in place and appends new ones in a single values:batchUpdate', async () => {
    const calls = stubPageApi()
    const issues = [
      { key: 'TEST-1', fields: { customfield_10016: [sprint7] } }, // exists at row 2
      { key: 'TEST-2', fields: { customfield_10016: [sprint7] } }, // new
    ]

    const result = await syncSprintPage(config.SPREADSHEET_ID, issues, 'token', config)

    expect(result.rowsWritten).toBe(2)
    const writes = calls.filter((c) => c.url.includes('values:batchUpdate'))
    expect(writes).toHaveLength(1) // ONE batched write for the whole page
    const data = (writes[0].body as { data: Array<{ range: string }> }).data
    expect(data.map((d) => d.range)).toEqual(['7_S1!B2:N2', '7_S1!B3:N3'])
    const deletes = calls.filter((c) => c.url.includes(':batchUpdate') && !c.url.includes('values:batchUpdate'))
    expect(deletes).toHaveLength(0)
  })

  it('reports only genuinely-new issues in newIssues, existing ones excluded', async () => {
    const calls = stubPageApi()
    const issues = [
      { key: 'TEST-1', fields: { customfield_10016: [sprint7] } }, // exists at row 2
      { key: 'TEST-2', fields: { customfield_10016: [sprint7] } }, // new
      { key: 'TEST-3', fields: { customfield_10016: [sprint7] } }, // new
      { key: 'TEST-1', fields: { customfield_10016: [sprint7] } }, // in-page duplicate of an existing key
    ]

    const result = await syncSprintPage(config.SPREADSHEET_ID, issues, 'token', config)

    expect(result.newIssues.map((i) => i.key)).toEqual(['TEST-2', 'TEST-3'])
  })

  it('deletes stale copies from other sprint tabs in one deduped batchUpdate', async () => {
    const calls = stubPageApi({ keyValues: { '7_S1': [['HDR'], ['TEST-1']], '8_S2': [['HDR'], ['TEST-1']], '9_S3': [['HDR']] } })
    const issues = [{ key: 'TEST-1', fields: { customfield_10016: [sprint7] } }]

    await syncSprintPage(config.SPREADSHEET_ID, issues, 'token', config)

    const deletes = calls.filter((c) => c.url.includes(':batchUpdate') && !c.url.includes('values:batchUpdate'))
    expect(deletes).toHaveLength(1)
    const requests = (deletes[0].body as { requests: Array<{ deleteDimension: { range: { sheetId: number; dimension: string; startIndex: number; endIndex: number } } }> }).requests
    expect(requests).toHaveLength(1)
    expect(requests[0].deleteDimension.range).toEqual({ sheetId: 3, dimension: 'ROWS', startIndex: 1, endIndex: 2 })
  })

  it('deletes multiple stale rows from the same tab high-to-low so indices stay valid', async () => {
    const calls = stubPageApi({ keyValues: { '7_S1': [['HDR']], '8_S2': [['HDR'], ['TEST-1'], ['TEST-2']], '9_S3': [['HDR']] } })
    const issues = [
      { key: 'TEST-1', fields: { customfield_10016: [sprint7] } },
      { key: 'TEST-2', fields: { customfield_10016: [sprint7] } },
    ]

    await syncSprintPage(config.SPREADSHEET_ID, issues, 'token', config)

    const deletes = calls.filter((c) => c.url.includes(':batchUpdate') && !c.url.includes('values:batchUpdate'))
    expect(deletes).toHaveLength(1)
    const requests = (deletes[0].body as { requests: Array<{ deleteDimension: { range: { sheetId: number; startIndex: number } } }> }).requests
    // row 3 (startIndex 2) must be deleted before row 2 (startIndex 1)
    expect(requests.map((r) => r.deleteDimension.range.startIndex)).toEqual([2, 1])
  })

  it('writes issues across multiple sprint tabs in one values:batchUpdate', async () => {
    const calls = stubPageApi({ keyValues: { '7_S1': [['HDR']], '8_S2': [['HDR']], '9_S3': [['HDR']] } })
    const issues = [
      { key: 'TEST-1', fields: { customfield_10016: [sprint7] } },
      { key: 'TEST-2', fields: { customfield_10016: [{ id: 8, name: 'S2', state: 'active' }] } },
    ]

    await syncSprintPage(config.SPREADSHEET_ID, issues, 'token', config)

    const writes = calls.filter((c) => c.url.includes('values:batchUpdate'))
    expect(writes).toHaveLength(1)
    const data = (writes[0].body as { data: Array<{ range: string }> }).data
    expect(data.map((d) => d.range).sort()).toEqual(['7_S1!B2:N2', '8_S2!B2:N2'])
  })

  it('skips issues without a sprint without touching the sheet', async () => {
    const calls = stubPageApi()
    const result = await syncSprintPage(config.SPREADSHEET_ID, [{ key: 'TEST-9', fields: {} }], 'token', config)
    expect(result.rowsWritten).toBe(0)
    expect(calls).toHaveLength(0)
  })

  describe('DEV assignee formula and preserve columns', () => {
    const keyValues = { '7_S1': [['HDR'], ['TEST-1']], '8_S2': [['HDR']], '9_S3': [['HDR']] }

    const writeRow = async (calls: Array<{ url: string; body?: unknown }>, at = 0) => {
      const writes = calls.filter((c) => c.url.includes('values:batchUpdate'))
      return (writes[at].body as { data: Array<{ range: string; values: string[][] }> }).data[0]
    }

    it('fills the DEV-assignee VLOOKUP formula when DEV column is empty and preserves empty J/N', async () => {
      const calls = stubPageApi({ keyValues })
      const issues = [{ key: 'TEST-1', fields: { customfield_10016: [sprint7] } }] // exists at row 2

      await syncSprintPage(config.SPREADSHEET_ID, issues, 'token', config)

      const row = (await writeRow(calls)).values[0]
      expect(row[7]).toBe('=IF(ISBLANK(H2), "", VLOOKUP(H2, Mapping!A:B, 2, FALSE))')
      expect(row[8]).toBe('') // J left empty
      expect(row[12]).toBe('') // N left empty
    })

    it('fills the formula on a new row referencing the new row number', async () => {
      const calls = stubPageApi({ keyValues })
      const issues = [{ key: 'TEST-2', fields: { customfield_10016: [sprint7] } }] // new -> row 3

      await syncSprintPage(config.SPREADSHEET_ID, issues, 'token', config)

      const row = (await writeRow(calls)).values[0]
      expect(row[7]).toBe('=IF(ISBLANK(H3), "", VLOOKUP(H3, Mapping!A:B, 2, FALSE))')
    })

    it('preserves a manually typed DEV assignee and J/N columns verbatim', async () => {
      const calls = stubPageApi({
        keyValues,
        preserve: { '7_S1': [['HDR', 'HDR', 'HDR'], ['Alice', 'manual-note', 'N-note']] },
      })
      const issues = [{ key: 'TEST-1', fields: { customfield_10016: [sprint7] } }]

      await syncSprintPage(config.SPREADSHEET_ID, issues, 'token', config)

      const row = (await writeRow(calls)).values[0]
      expect(row[7]).toBe('Alice')
      expect(row[8]).toBe('manual-note')
      expect(row[12]).toBe('N-note')
    })

    it('rewrites the formula when the DEV cell is still auto-filled, so a Jira re-assignment recalcs DEV assignee', async () => {
      const calls = stubPageApi({
        keyValues,
        preserve: { '7_S1': [['HDR', 'HDR', 'HDR'], ['=IF(ISBLANK(H2), "", VLOOKUP(H2, Mapping!A:B, 2, FALSE))', 'old-j', 'N-note']] },
      })
      const issues = [{ key: 'TEST-1', fields: { customfield_10016: [sprint7] } }]

      await syncSprintPage(config.SPREADSHEET_ID, issues, 'token', config)

      const row = (await writeRow(calls)).values[0]
      expect(row[7]).toBe('=IF(ISBLANK(H2), "", VLOOKUP(H2, Mapping!A:B, 2, FALSE))')
      expect(row[8]).toBe('old-j') // J untouched
      expect(row[12]).toBe('N-note') // N untouched
    })
  })
})

describe('getOrCreateSprintSheet rename', () => {
  it('renames a renamed-sprint tab and writes rows to the new title', async () => {
    const calls: Array<{ url: string; method: string | undefined; body?: unknown }> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      if (url.endsWith(`/spreadsheets/${config.SPREADSHEET_ID}`)) {
        return json({ sheets: [{ properties: { sheetId: 2, title: '7_S1' } }] })
      }
      if (url.includes(':batchGet')) return json({ valueRanges: [{ values: [['HDR']] }] })
      if (url.includes(':batchUpdate')) return json({ replies: [] })
      return json({})
    })

    const issue = { key: 'TEST-1', fields: { customfield_10016: [{ id: 7, name: 'S1-Renamed', state: 'active' }] } }
    await upsertIssue(config.SPREADSHEET_ID, issue, 'token', config)

    const rename = calls.find((c) => c.url.includes(':batchUpdate') && (c.body as { requests?: unknown[] })?.requests?.some(
      (r) => (r as { updateSheetProperties?: unknown }).updateSheetProperties,
    ))
    expect(rename).toBeDefined()
    const requests = (rename!.body as { requests: Array<{ updateSheetProperties: { properties: { sheetId: number; title: string }; fields: string } }> }).requests
    expect(requests).toEqual([{ updateSheetProperties: { properties: { sheetId: 2, title: '7_S1-Renamed' }, fields: 'title' } }])
    // row write targets the NEW title, not the stale one
    expect(calls.some((c) => c.url.includes('values/') && c.url.includes('7_S1-Renamed!'))).toBe(true)
    expect(calls.some((c) => c.url.includes('7_S1!'))).toBe(false)
  })
})

describe('renameSprintTabs', () => {
  it('renames all tabs in one batchUpdate', async () => {
    const calls: Array<{ url: string; body?: unknown }> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      return json({ replies: [] })
    })

    await renameSprintTabs(config.SPREADSHEET_ID, [
      { sheetId: 2, title: '7_NewName' },
      { sheetId: 3, title: '8_NewName' },
    ], 'token')

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toContain(':batchUpdate')
    const requests = (calls[0].body as { requests: Array<{ updateSheetProperties: { properties: { sheetId: number; title: string }; fields: string } }> }).requests
    expect(requests).toEqual([
      { updateSheetProperties: { properties: { sheetId: 2, title: '7_NewName' }, fields: 'title' } },
      { updateSheetProperties: { properties: { sheetId: 3, title: '8_NewName' }, fields: 'title' } },
    ])
  })

  it('does nothing for an empty rename list', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await renameSprintTabs(config.SPREADSHEET_ID, [], 'token')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('withStoredToken', () => {
  const email = 'sa@test.iam.gserviceaccount.com'
  const key = 'PRIVATE KEY'

  function storageWith(cached: { token: string; expiresAt: number } | undefined) {
    const store = cached ? new Map([['oauth_token', cached]]) : new Map<string, unknown>()
    const storage = {
      get: vi.fn(async (k: string) => store.get(k)),
      put: vi.fn(async (k: string, v: unknown) => { store.set(k, v) }),
    } as unknown as DurableObjectStorage
    return { storage, store }
  }

  it('reuses a fresh cached token without signing a new JWT', async () => {
    const { storage } = storageWith({ token: 'cached-token', expiresAt: Date.now() + 600_000 })
    const fn = vi.fn()
    await withStoredToken(storage, email, key, fn)
    expect(fn).toHaveBeenCalledWith('cached-token')
    expect(getAccessToken).not.toHaveBeenCalled()
    expect(storage.put).not.toHaveBeenCalled()
  })

  it('refreshes an expired cached token and stores the new one', async () => {
    const { storage, store } = storageWith({ token: 'old-token', expiresAt: Date.now() - 1000 })
    vi.mocked(getAccessToken).mockResolvedValueOnce('new-token')
    const fn = vi.fn()
    await withStoredToken(storage, email, key, fn)
    expect(fn).toHaveBeenCalledWith('new-token')
    expect(getAccessToken).toHaveBeenCalledWith(email, key)
    const stored = store.get('oauth_token') as { token: string; expiresAt: number }
    expect(stored.token).toBe('new-token')
    expect(stored.expiresAt).toBeGreaterThan(Date.now())
  })

  it('obtains and stores a token when none is cached', async () => {
    const { storage, store } = storageWith(undefined)
    vi.mocked(getAccessToken).mockResolvedValueOnce('fresh-token')
    await withStoredToken(storage, email, key, async () => {})
    expect(store.get('oauth_token')).toEqual(expect.objectContaining({ token: 'fresh-token' }))
  })
})