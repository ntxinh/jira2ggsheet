import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SyncCoordinator } from '../syncCoordinator'
import { testEnv } from './mock-env'
import { searchIssuesPage, fetchSprintName } from '../jira'
import { syncSprintPage, getSheets, renameSprintTabs } from '../sheetWriter'
import { postChatNotification } from '../chat'
import { captureException } from '@sentry/cloudflare'

vi.mock('../jira', () => ({ searchIssuesPage: vi.fn(), fetchSprintName: vi.fn() }))
vi.mock('../chat', () => ({ postChatNotification: vi.fn() }))
vi.mock('../sheetWriter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../sheetWriter')>()
  return {
    ...actual,
    syncSprintPage: vi.fn(),
    withStoredToken: vi.fn(async (_s: unknown, _e: string, _k: string, fn: (t: string) => Promise<void>) => fn('token')),
    getSheets: vi.fn(),
    renameSprintTabs: vi.fn(),
  }
})
vi.mock('@sentry/cloudflare', () => ({ captureException: vi.fn() }))

const searchIssuesPageMock = vi.mocked(searchIssuesPage)
const fetchSprintNameMock = vi.mocked(fetchSprintName)
const syncSprintPageMock = vi.mocked(syncSprintPage)
const getSheetsMock = vi.mocked(getSheets)
const renameSprintTabsMock = vi.mocked(renameSprintTabs)
const postChatNotificationMock = vi.mocked(postChatNotification)
const captureExceptionMock = vi.mocked(captureException)

function makeState() {
  const map = new Map<string, unknown>()
  let alarm: number | null = null
  return {
    storage: {
      get: vi.fn(async <T>(k: string): Promise<T | undefined> => (map.has(k) ? (map.get(k) as T) : undefined)),
      put: vi.fn(async (k: string, v: unknown) => { map.set(k, v) }),
      delete: vi.fn(async (k: string) => { map.delete(k) }),
      setAlarm: vi.fn(async (t: number) => { alarm = t }),
    },
    map,
    getAlarm: () => alarm,
  }
}

type FakeState = ReturnType<typeof makeState>

function makeCoordinator(state: FakeState, env = testEnv): SyncCoordinator {
  return new SyncCoordinator(state as unknown as DurableObjectState, env)
}

function runningState(overrides: Record<string, unknown> = {}) {
  return {
    sprintId: '42',
    sprintQueue: [],
    nextPageToken: 'page-2',
    pagesDone: 1,
    rowsWritten: 100,
    startedAt: 1000,
    updatedAt: Date.now(),
    failures: 0,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  syncSprintPageMock.mockResolvedValue({ rowsWritten: 1, newIssues: [] })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('kick', () => {
  it('starts a sync when idle and schedules the first tick', async () => {
    const state = makeState()
    const coordinator = makeCoordinator(state)

    await expect(coordinator.kick()).resolves.toEqual({ status: 'started', sprintId: '42' })

    const stored = state.map.get('sync') as { sprintId: string; pagesDone: number; failures: number }
    expect(stored.sprintId).toBe('42')
    expect(stored.pagesDone).toBe(0)
    expect(stored.failures).toBe(0)
    expect(state.getAlarm()).not.toBeNull()
    expect(state.getAlarm()!).toBeGreaterThan(Date.now())
  })

  it('uses the sprintId argument over the env default', async () => {
    const state = makeState()
    const coordinator = makeCoordinator(state)

    await expect(coordinator.kick('99')).resolves.toEqual({ status: 'started', sprintId: '99' })

    const stored = state.map.get('sync') as { sprintId: string }
    expect(stored.sprintId).toBe('99')
  })

  it('syncs a comma-separated SPRINT_ID list sequentially', async () => {
    const state = makeState()
    const coordinator = makeCoordinator(state, { ...testEnv, SPRINT_ID: '42, 43,44' })

    await expect(coordinator.kick()).resolves.toEqual({ status: 'started', sprintId: '42' })

    const stored = state.map.get('sync') as { sprintId: string; sprintQueue: string[] }
    expect(stored.sprintId).toBe('42')
    expect(stored.sprintQueue).toEqual(['43', '44'])
  })

  it('returns idle (no sync) when SPRINT_ID is empty', async () => {
    const state = makeState()
    const coordinator = makeCoordinator(state, { ...testEnv, SPRINT_ID: ' , ' })

    await expect(coordinator.kick()).resolves.toEqual({ status: 'idle' })

    expect(state.map.has('sync')).toBe(false)
    expect(state.getAlarm()).toBeNull()
  })

  it('leaves a fresh in-progress sync alone', async () => {
    const state = makeState()
    await state.storage.put('sync', runningState())
    const before = state.map.get('sync')

    await expect(makeCoordinator(state).kick('99')).resolves.toEqual({ status: 'in_progress', sprintId: '42' })

    expect(state.map.get('sync')).toBe(before)
  })

  it('restarts a stale in-progress sync from page 0', async () => {
    const state = makeState()
    await state.storage.put('sync', runningState({ updatedAt: Date.now() - 10 * 60 * 1000, nextPageToken: 'page-9' }))

    await expect(makeCoordinator(state).kick()).resolves.toEqual({ status: 'started', sprintId: '42' })

    const stored = state.map.get('sync') as { pagesDone: number; nextPageToken?: string }
    expect(stored.pagesDone).toBe(0)
    expect(stored.nextPageToken).toBeUndefined()
  })
})

describe('kick with sprint-name sweep', () => {
  const tabs = [
    { sheetId: 1, title: 'Template' },
    { sheetId: 2, title: '7_OldName' },
    { sheetId: 3, title: '8_S2' },
    { sheetId: 4, title: 'not-a-sprint-tab' },
  ]

  beforeEach(() => {
    getSheetsMock.mockResolvedValue(tabs)
    renameSprintTabsMock.mockResolvedValue()
  })

  it('renames mismatched sprint tabs before starting the sync', async () => {
    fetchSprintNameMock.mockImplementation(async (id: string) =>
      id === '7' ? 'NewName' : id === '8' ? 'S2' : '')
    const state = makeState()

    await expect(makeCoordinator(state).kick()).resolves.toEqual({ status: 'started', sprintId: '42' })

    // template excluded, non-sprint tab excluded, matching tab skipped
    expect(renameSprintTabsMock).toHaveBeenCalledWith('fake-spreadsheet-id', [
      { sheetId: 2, title: '7_NewName' },
    ], 'token')
    expect(state.map.has('sync')).toBe(true) // page sync still started
  })

  it('skips sprint lookups that fail (404) without failing the sweep or the sync', async () => {
    fetchSprintNameMock.mockRejectedValue(new Error('Jira sprint 404'))
    const state = makeState()

    await expect(makeCoordinator(state).kick()).resolves.toEqual({ status: 'started', sprintId: '42' })

    expect(renameSprintTabsMock).toHaveBeenCalledWith('fake-spreadsheet-id', [], 'token')
    expect(state.map.has('sync')).toBe(true)
  })

  it('a sweep failure never blocks the page sync from starting', async () => {
    getSheetsMock.mockRejectedValue(new Error('sheets down'))
    const state = makeState()

    await expect(makeCoordinator(state).kick()).resolves.toEqual({ status: 'started', sprintId: '42' })
    expect(state.map.has('sync')).toBe(true)
  })

  it('skips the sweep while a fresh sync is in progress', async () => {
    const state = makeState()
    await state.storage.put('sync', runningState())

    await expect(makeCoordinator(state).kick('99')).resolves.toEqual({ status: 'in_progress', sprintId: '42' })

    expect(getSheetsMock).not.toHaveBeenCalled()
    expect(renameSprintTabsMock).not.toHaveBeenCalled()
  })
})

describe('alarm', () => {
  it('does nothing when no sync is in progress', async () => {
    const coordinator = makeCoordinator(makeState())
    await coordinator.alarm()
    expect(searchIssuesPageMock).not.toHaveBeenCalled()
  })

  it('processes one page, advances the cursor, and schedules the next tick', async () => {
    const state = makeState()
    await state.storage.put('sync', runningState())
    searchIssuesPageMock.mockResolvedValueOnce({
      issues: [{ key: 'ABC-1', fields: {} }],
      nextPageToken: 'page-3',
      isLast: false,
    })
    const coordinator = makeCoordinator(state)

    await coordinator.alarm()

    expect(searchIssuesPageMock).toHaveBeenCalledWith(
      'project = TEST AND sprint = 42 ORDER BY created ASC',
      'acme',
      'jira@example.com',
      'jira-token',
      'page-2',
      'summary,status,issuetype,priority,assignee,created,labels,customfield_10016,customfield_10021',
    )
    expect(syncSprintPageMock).toHaveBeenCalledWith(
      'fake-spreadsheet-id',
      [{ key: 'ABC-1', fields: {} }],
      'token',
      expect.objectContaining({ PROJECT_KEY: 'TEST' }),
    )
    const stored = state.map.get('sync') as { nextPageToken: string; pagesDone: number; rowsWritten: number; failures: number }
    expect(stored.nextPageToken).toBe('page-3')
    expect(stored.pagesDone).toBe(2)
    expect(stored.rowsWritten).toBe(101)
    expect(stored.failures).toBe(0)
    const alarm = state.getAlarm()!
    expect(alarm).toBeGreaterThanOrEqual(Date.now() + 3000 - 1000)
    expect(alarm).toBeLessThanOrEqual(Date.now() + 3000 + 1000)
  })

  it('notifies when a page-surfaced new issue is assigned to Binh Ho, silently for others', async () => {
    const binh = { key: 'ABC-2', fields: { assignee: { displayName: 'Binh Ho' } } }
    const other = { key: 'ABC-3', fields: { assignee: { displayName: 'John Doe' } } }
    const state = makeState()
    await state.storage.put('sync', runningState())
    searchIssuesPageMock.mockResolvedValueOnce({ issues: [binh, other], nextPageToken: undefined, isLast: false })
    syncSprintPageMock.mockResolvedValueOnce({ rowsWritten: 2, newIssues: [binh, other] })
    const coordinator = makeCoordinator(state)

    await coordinator.alarm()

    expect(postChatNotificationMock).toHaveBeenCalledTimes(1)
    expect(postChatNotificationMock).toHaveBeenCalledWith(testEnv, {
      webhookEvent: 'jira:issue_created',
      issue: binh,
    })
  })

  it('does not notify when the page only updated existing rows', async () => {
    const state = makeState()
    await state.storage.put('sync', runningState())
    searchIssuesPageMock.mockResolvedValueOnce({ issues: [{ key: 'ABC-1', fields: {} }], nextPageToken: undefined, isLast: false })
    syncSprintPageMock.mockResolvedValueOnce({ rowsWritten: 1, newIssues: [] })
    const coordinator = makeCoordinator(state)

    await coordinator.alarm()

    expect(postChatNotificationMock).not.toHaveBeenCalled()
  })

  it('clears the state when the last page is reached', async () => {
    const state = makeState()
    await state.storage.put('sync', runningState())
    searchIssuesPageMock.mockResolvedValueOnce({ issues: [], nextPageToken: undefined, isLast: true })
    const coordinator = makeCoordinator(state)

    await coordinator.alarm()

    expect(state.map.has('sync')).toBe(false)
    expect(state.getAlarm()).toBeNull() // no next tick scheduled
  })

  it('moves to the next queued sprint when one finishes, keeping the run alive', async () => {
    const state = makeState()
    await state.storage.put('sync', runningState({ sprintId: '42', sprintQueue: ['43'], nextPageToken: 'page-9' }))
    searchIssuesPageMock.mockResolvedValueOnce({ issues: [{ key: 'ABC-1', fields: {} }], nextPageToken: undefined, isLast: true })
    const coordinator = makeCoordinator(state)

    await coordinator.alarm()

    const stored = state.map.get('sync') as {
      sprintId: string
      sprintQueue: string[]
      nextPageToken?: string
      pagesDone: number
      rowsWritten: number
      failures: number
    }
    expect(stored.sprintId).toBe('43')
    expect(stored.sprintQueue).toEqual([])
    expect(stored.nextPageToken).toBeUndefined() // fresh page cursor for the next sprint
    expect(stored.pagesDone).toBe(2) // cumulative across the run
    expect(stored.rowsWritten).toBe(101)
    expect(stored.failures).toBe(0)
    expect(state.getAlarm()).not.toBeNull() // chain continues
  })

  it('keeps the cursor and reschedules with backoff on failure', async () => {
    const state = makeState()
    await state.storage.put('sync', runningState())
    searchIssuesPageMock.mockRejectedValueOnce(new Error('jira down'))
    const coordinator = makeCoordinator(state)

    await coordinator.alarm()

    const stored = state.map.get('sync') as { nextPageToken: string; pagesDone: number; failures: number }
    expect(stored.nextPageToken).toBe('page-2') // cursor not advanced
    expect(stored.pagesDone).toBe(1)
    expect(stored.failures).toBe(1)
    expect(syncSprintPageMock).not.toHaveBeenCalled()
    const alarm = state.getAlarm()!
    expect(alarm).toBeGreaterThanOrEqual(Date.now() + 5000 - 1000)
    expect(alarm).toBeLessThanOrEqual(Date.now() + 5000 + 1000)
    expect(captureExceptionMock).toHaveBeenCalledWith(expect.any(Error))
  })

  it('doubles the backoff per failure up to a 5-minute cap', async () => {
    const state = makeState()
    await state.storage.put('sync', runningState({ failures: 7 }))
    searchIssuesPageMock.mockRejectedValueOnce(new Error('down'))
    const coordinator = makeCoordinator(state)

    await coordinator.alarm()

    // 5s * 2^7 = 640s → capped at 300s
    expect(state.getAlarm()!).toBeGreaterThanOrEqual(Date.now() + 300_000 - 1000)
    expect(state.getAlarm()!).toBeLessThanOrEqual(Date.now() + 300_000 + 1000)
    expect((state.map.get('sync') as { failures: number }).failures).toBe(8)
  })
})

describe('getStatus', () => {
  it('reports idle when no sync is running', async () => {
    await expect(makeCoordinator(makeState()).getStatus()).resolves.toEqual({ running: false })
  })

  it('reports progress while running', async () => {
    const state = makeState()
    await state.storage.put('sync', runningState({ pagesDone: 3, rowsWritten: 250 }))
    const status = await makeCoordinator(state).getStatus()
    expect(status).toMatchObject({ running: true, sprintId: '42', pagesDone: 3, rowsWritten: 250 })
  })
})

describe('fetch', () => {
  it('routes GET /status and POST /kick, 404 otherwise', async () => {
    const state = makeState()
    const coordinator = makeCoordinator(state)

    const statusRes = await coordinator.fetch(new Request('https://do/status'))
    expect(statusRes.status).toBe(200)
    expect(await statusRes.json()).toEqual({ running: false })

    const kickRes = await coordinator.fetch(new Request('https://do/kick?sprintId=7', { method: 'POST' }))
    expect(kickRes.status).toBe(200)
    expect(await kickRes.json()).toEqual({ status: 'started', sprintId: '7' })
    expect((state.map.get('sync') as { sprintId: string }).sprintId).toBe('7')

    const other = await coordinator.fetch(new Request('https://do/other'))
    expect(other.status).toBe(404)
  })
})
