# Sprint Rename → Sheet Tab Rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a sprint is renamed in Jira, rename the matching `<sprintId>_<name>` spreadsheet tab — for any sprint with a tab — via a webhook fast path (bug fix) plus a 5-minute cron sweep that checks every sprint tab against Jira's Agile API.

**Architecture:** `SyncCoordinator.kick()` (already called by the `*/5` cron and `GET /sync`) runs a new best-effort `syncTabNames()` sweep before starting page sync: enumerate all `^\d+_` tabs via the existing spreadsheet metadata read, fetch each sprint's current name from `GET /rest/agile/1.0/sprint/{id}`, rename all mismatches in one `batchUpdate`. Separately, fix `getOrCreateSprintSheet` to return the new title after renaming so webhook/sync writes target the renamed tab.

**Tech Stack:** Cloudflare Workers, Hono, Durable Objects (SQLite), Jira REST Agile API, vitest.

**Spec:** `docs/superpowers/specs/2026-08-14-sprint-rename-tab-sync-design.md`

## Global Constraints

- No new npm dependencies.
- Working dir for all commands: `src/workers/`.
- Follow AGENTS.md conventions: TypeScript strict, 2-space indent, no comments unless they encode intent, reuse existing helpers (`getConfig`, `withToken`, `withStoredToken`, `getSheets`, `pickSprint`, `sprintSheetName`).
- Jira Agile API uses the same Basic auth (`email:apiToken`) as `searchIssuesPage` — no OAuth, no extra config.
- Sweep failures (404 = sprint deleted, Sheets errors) log + `Sentry.captureException`, never throw out of `kick()`.
- GAS legacy runtime untouched.
- Verify commands: `npm test` (vitest) and `npm run typecheck` from `src/workers/`.

---

### Task 1: `jira.ts` — fetch a sprint's current name

**Files:**
- Modify: `src/workers/jira.ts` (add `fetchSprintName` next to `searchIssuesPage`)
- Test: `src/workers/tests/jira.test.ts`

**Interfaces:**
- Produces: `fetchSprintName(sprintId: string, subdomain: string, email: string, apiToken: string): Promise<string>` — GETs `https://{subdomain}.atlassian.net/rest/agile/1.0/sprint/{sprintId}` with Basic auth, returns `data.name`, throws `Jira sprint {status}: {text}` on non-OK. Consumed by `syncCoordinator.ts` (Task 3).

- [ ] **Step 1: Write the failing test**

Add to `src/workers/tests/jira.test.ts`:

```ts
import { fetchSprintName } from '../jira'

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/workers && npx vitest run tests/jira.test.ts`
Expected: FAIL — `fetchSprintName is not a function` / module has no exported member.

- [ ] **Step 3: Implement `fetchSprintName`**

Add to `src/workers/jira.ts` (above or below `searchIssuesPage`):

```ts
// Jira Software Agile API: authoritative current sprint name even for empty/closed
// sprints (issue-search JQL would miss them). Same Basic auth as searchIssuesPage.
export async function fetchSprintName(
  sprintId: string,
  subdomain: string,
  email: string,
  apiToken: string,
): Promise<string> {
  const url = `https://${subdomain}.atlassian.net/rest/agile/1.0/sprint/${sprintId}`
  const auth = 'Basic ' + btoa(`${email}:${apiToken}`)
  const res = await fetch(url, { headers: { Authorization: auth } })
  if (!res.ok) throw new Error(`Jira sprint ${res.status}: ${await res.text()}`)
  const data = (await res.json()) as { name?: string }
  return String(data.name ?? '')
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src/workers && npx vitest run tests/jira.test.ts`
Expected: PASS (2 new tests + existing `searchIssuesPage` tests green).

- [ ] **Step 5: Commit**

```bash
git add src/workers/jira.ts src/workers/tests/jira.test.ts
git commit -m "feat: fetch sprint name from Jira Agile API"
```

### Task 2: `sheetWriter.ts` — stale-title fix + batched rename helper

**Files:**
- Modify: `src/workers/sheetWriter.ts` (export `getSheets` + `sprintSheetName`; fix stale-title return in `getOrCreateSprintSheet`; add `renameSprintTabs`)
- Test: `src/workers/tests/sheetWriter.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `getSheets(spreadsheetId: string, token: string): Promise<SheetInfo[]>` (now exported; `SheetInfo = { sheetId: number; title: string }`)
  - `sprintSheetName(sprint: Sprint): string` (now exported)
  - `renameSprintTabs(spreadsheetId: string, renames: Array<{ sheetId: number; title: string }>, token: string): Promise<void>` — one `batchUpdate` with `updateSheetProperties` requests, no-op on empty list. Consumed by `syncCoordinator.ts` (Task 3).
  - `getOrCreateSprintSheet` returns `{ sheetId, title: target }` (new title) after renaming.

- [ ] **Step 1: Write the failing tests**

Add to `src/workers/tests/sheetWriter.test.ts` (inside the existing file, new `describe` blocks; `json`, `config` already defined):

```ts
import { upsertIssue, syncSprintPage, withStoredToken, renameSprintTabs } from '../sheetWriter'

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/workers && npx vitest run tests/sheetWriter.test.ts`
Expected: FAIL — `renameSprintTabs` not exported; rename assertion fails (function returns stale title).

- [ ] **Step 3: Implement the changes**

In `src/workers/sheetWriter.ts`:

1. Add `export` to `interface SheetInfo`, `getSheets`, and `sprintSheetName`.
2. In `getOrCreateSprintSheet`, change the rename branch to return the new title:

```ts
      if (sheet.title !== target) {
        await apiFetch(
          token,
          `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`,
          {
            method: 'POST',
            body: JSON.stringify({
              requests: [{
                updateSheetProperties: {
                  properties: { sheetId: sheet.sheetId, title: target },
                  fields: 'title',
                },
              }],
            }),
          },
        );
        return { sheetId: sheet.sheetId, title: target };
      }
      return sheet;
```

3. Add `renameSprintTabs` after `getOrCreateSprintSheet`:

```ts
export interface TabRename {
  sheetId: number;
  title: string;
}

// Renames all mismatched sprint tabs in ONE batchUpdate (same batched pattern as the
// page sync). No-op on an empty list so the sweep costs zero requests when nothing changed.
export async function renameSprintTabs(
  spreadsheetId: string,
  renames: TabRename[],
  token: string,
): Promise<void> {
  if (renames.length === 0) return;
  await apiFetch(
    token,
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`,
    {
      method: 'POST',
      body: JSON.stringify({
        requests: renames.map((r) => ({
          updateSheetProperties: {
            properties: { sheetId: r.sheetId, title: r.title },
            fields: 'title',
          },
        })),
      }),
    },
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src/workers && npx vitest run tests/sheetWriter.test.ts`
Expected: PASS — new rename tests + existing `upsertIssue`/`syncSprintPage`/`withStoredToken` tests green.

- [ ] **Step 5: Commit**

```bash
git add src/workers/sheetWriter.ts src/workers/tests/sheetWriter.test.ts
git commit -m "fix: return new title after tab rename + batched renameSprintTabs"
```

### Task 3: `syncCoordinator.ts` — the sprint-name sweep

**Files:**
- Modify: `src/workers/syncCoordinator.ts` (add `syncTabNames()` private method; call it in `kick()` after the in-progress early-return)
- Test: `src/workers/tests/syncCoordinator.test.ts`

**Interfaces:**
- Consumes: `fetchSprintName` (Task 1), `getSheets`, `sprintSheetName`, `renameSprintTabs`, `withStoredToken` (Task 2), `config.JIRA_SUBDOMAIN`, `env.JIRA_EMAIL`, `env.JIRA_API_TOKEN`.
- Produces: nothing new externally — `kick()` behavior extended (sweep runs on fresh start/restart, skipped on `in_progress`).

- [ ] **Step 1: Write the failing tests**

In `src/workers/tests/syncCoordinator.test.ts`, extend the mocks and add a `syncTabNames` describe block:

```ts
import { fetchSprintName } from '../jira'
import { getSheets, renameSprintTabs } from '../sheetWriter'

vi.mock('../jira', () => ({ searchIssuesPage: vi.fn(), fetchSprintName: vi.fn() }))
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

const fetchSprintNameMock = vi.mocked(fetchSprintName)
const getSheetsMock = vi.mocked(getSheets)
const renameSprintTabsMock = vi.mocked(renameSprintTabs)
```

Then (after the existing `kick` describe block):

```ts
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
      id === '7' ? 'NewName' : id === '8' ? 'S2' : ''),
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/workers && npx vitest run tests/syncCoordinator.test.ts`
Expected: FAIL — `getSheets`/`renameSprintTabs` not called by `kick` (mock assertions fail).

- [ ] **Step 3: Implement the sweep**

In `src/workers/syncCoordinator.ts`:

1. Update the imports:

```ts
import { searchIssuesPage, fetchSprintName } from './jira'
import { syncSprintPage, withStoredToken, getSheets, sprintSheetName, renameSprintTabs } from './sheetWriter'
```

2. In `kick()`, after the in-progress early-return and before `storage.put`:

```ts
    await this.syncTabNames()
```

3. Add the private method at the end of the class:

```ts
  // Best-effort tab-name sweep: compares every sprint tab against Jira's current sprint
  // name and renames mismatches in one batch. Webhooks don't reliably fire on sprint
  // renames, so the cron watchdog is the dependable detector. Errors never block the
  // page sync — a 404 just means the sprint (and its tab) is left alone.
  private async syncTabNames(): Promise<void> {
    try {
      await withStoredToken(
        this.ctx.storage,
        this.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        this.env.GOOGLE_PRIVATE_KEY,
        async (token) => {
          const sheets = await getSheets(this.env.SPREADSHEET_ID, token)
          const sprintTabs = sheets.filter(
            (s) => s.title !== this.config.TEMPLATE_SHEET && /^\d+_/.test(s.title),
          )
          const renames: Array<{ sheetId: number; title: string }> = []
          for (const tab of sprintTabs) {
            const sprintId = tab.title.split('_')[0]
            try {
              const name = await fetchSprintName(
                sprintId,
                this.config.JIRA_SUBDOMAIN,
                this.env.JIRA_EMAIL,
                this.env.JIRA_API_TOKEN,
              )
              const target = sprintSheetName({ id: Number(sprintId), name, state: '' })
              if (tab.title !== target) renames.push({ sheetId: tab.sheetId, title: target })
            } catch (err) {
              console.error(`Sprint name lookup failed for tab "${tab.title}": ${err}`)
              try {
                Sentry.captureException(err)
              } catch {
                // telemetry must never kill the sweep
              }
            }
          }
          await renameSprintTabs(this.env.SPREADSHEET_ID, renames, token)
        },
      )
    } catch (err) {
      console.error(`Tab-name sweep failed: ${err}`)
      try {
        Sentry.captureException(err)
      } catch {
        // telemetry must never kill the sweep
      }
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src/workers && npx vitest run tests/syncCoordinator.test.ts`
Expected: PASS — sweep tests + existing kick/alarm/getStatus/fetch tests green.

- [ ] **Step 5: Run the full suite + typecheck**

Run: `cd src/workers && npm test && npm run typecheck`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/workers/syncCoordinator.ts src/workers/tests/syncCoordinator.test.ts
git commit -m "feat: sweep sprint tab names on cron kick"
```

### Task 4: docs

**Files:**
- Modify: `AGENTS.md`, `README.md`

- [ ] **Step 1: Update AGENTS.md**

In the **Full-sprint sync** paragraph of "Key flow", after the sentence about `getOrCreateSprintSheet` (webhooks), note the rename sweep. Suggested addition to the "Key flow" webhook paragraph and/or the gotchas:

```markdown
- **Sprint renames**: Jira doesn't reliably fire webhooks when a sprint is renamed, so `SyncCoordinator.kick()` (cron `*/5` + `GET /sync`) runs a best-effort `syncTabNames()` sweep first — it compares every `{sprintId}_*` tab against Jira's Agile API (`/rest/agile/1.0/sprint/{id}`) and renames mismatches in one `batchUpdate`; failures never block the page sync. Webhooks that *do* carry a renamed sprint still rename immediately via `getOrCreateSprintSheet`.
```

- [ ] **Step 2: Update README.md**

In the "How it works" paragraph (after the full-sync resync sentence), add one sentence:

```markdown
When a sprint is renamed in Jira, the cron sync renames the matching tab (webhook fast path plus a 5-minute tab-name sweep).
```

- [ ] **Step 3: Commit**

```bash
git add AGENTS.md README.md
git commit -m "doc: sprint-rename tab sweep"
```

### Task 5: verify

- [ ] **Step 1:** `cd src/workers && npm run typecheck && npm test` — all green.
- [ ] **Step 2:** `cd .. && git status` — clean tree, only expected commits ahead of origin.
- [ ] **Step 3:** Commit any stragglers (should be none; if the verify step found fixes, commit them with a repo-style message).
