# Durable Object + Alarm-Chain Sprint Sync (Free-plan-safe)

**Date:** 2026-08-12
**Status:** Approved

## Goal

Move the full-sprint sync off the stateless chunked-cron approach and onto a
**Durable Object with a self-scheduling alarm chain** so it runs safely within
Cloudflare **Free plan** limits (10ms CPU/invocation, 50 subrequests/invocation,
5 cron triggers). One Jira page (100 issues) per "tick", paced ~3s apart by
DO alarms.

## Problem

Confirmed Cloudflare limits (Aug 2026):

| | Free | Paid ($5/mo) |
|---|---|---|
| CPU time / invocation | **10ms** | 30s (up to 5 min) |
| Subrequests / invocation | 50 | 10,000 |
| Cron triggers | 5 | 250 |
| DO storage | SQLite-backed, included | ✅ |

The killer constraint is **10ms CPU on Free** — wall-clock waiting on `fetch`
is free, but actual JS execution is not. RS256-signing a JWT on every tick +
parsing a 100-issue `fields=*all` page + per-issue sheet metadata parsing would
blow 10ms in one shot. DO **alarms are available on Free** (alarm handler
invocations get a 15-min wall-clock limit) and **SQLite-backed DO storage is
included on Free** — both verified against official Cloudflare docs.

## Decisions

| Topic | Decision |
|---|---|
| Engine | Single `SyncCoordinator` **Durable Object** (SQLite storage). Cron, manual `/sync`, and `/sync/status` all talk to it — one engine, one progress state, no concurrent syncs. |
| Drive loop | DO **alarm chain**: each alarm does exactly one unit of work (1 Jira page → 1 batched sheet write → save cursor → `setAlarm(+3s)` if more pages, else clear state). Alarms are not gated by the 5-cron-trigger limit. |
| Cron | `*/5 * * * *` (was `*/15`). Role is watchdog/kick: wake the DO; if a sync is running it does nothing, if the in-progress marker is **stale** (>4 min since last page) it restarts from page 0. The alarm chain does the real looping. |
| Jira paging | New `searchIssuesPage` fetches **one** page via `nextPageToken`/`isLast` (the `/search/jql` endpoint has no `total` and ignores `startAt` — existing gotcha). The JQL field list is narrowed to what the extractors read (not `fields=*all`) so a 100-issue page stays under the 10ms CPU budget. Cursor stored in DO state; a failed tick does not advance it. |
| OAuth token | **Cached in DO storage** (`oauth_token`, ~1h validity, 60s headroom). JWT is RS256-signed at most once per hour per DO, not once per page. Webhooks keep the existing in-memory `auth.ts` cache. |
| Sheet writes | New `syncSprintPage` writes a whole page in **one `values:batchUpdate`** (≤100 ranges) + **one `batchUpdate` per tab with stale copies** (rows descending — batchUpdate applies sequentially, so lower-row deletes would shift higher rows), after 1 metadata read + 1 key-column `batchGet`. ~5 subrequests/tick, far under 50. |
| Manual `/sync` | Now **kicks the DO** and returns `{ sprintId, status: 'started' | 'in_progress' }` immediately — a synchronous full sync can't fit Free's 30s HTTP wall-clock. New `GET /sync/status` polls progress. |
| Failure handling | On tick failure: keep cursor, exponential backoff (5s · 2^failures, cap 5 min), reschedule alarm, report to Sentry. Next tick retries the same page (upserts idempotent). |
| Read failures | `readKeyColumns` becomes strict (no silent empty fallback) — a failed key read must fail the tick, not cause up to 100 duplicated rows. |

## Architecture

```
Cron */5  ──► SyncCoordinator.kick()      (watchdog: start if idle/stale)
GET /sync ──► SyncCoordinator.kick(id)    (manual trigger)
GET /sync/status ──► SyncCoordinator.getStatus()

SyncCoordinator (DO, SQLite storage)
  state: { sprintId, nextPageToken?, pagesDone, rowsWritten, updatedAt, failures }
  oauth: { token, expiresAt }             (cached, refreshed ≤1/hr)

alarm() — one unit of work:
  1. load state (no state ⇒ return)
  2. searchIssuesPage(jql, ..., state.nextPageToken)      # 1 subrequest
  3. withStoredToken → syncSprintPage(issues)             # ~4 subrequests
     - 1 metadata GET, 1 key-column batchGet
     - 1 values:batchUpdate (all rows), 1 batchUpdate per tab (stale deletes, rows descending)
  4. save new cursor + progress to SQLite storage
  5. more pages ⇒ setAlarm(+3s); done ⇒ delete state, log completion
     failure ⇒ keep cursor, setAlarm(backoff), Sentry
```

Per-tick CPU is one page parse + one page write + light JSON — close to the
10ms budget, which is why the batch write and the token cache are non-negoti­able.

## Edge cases

- **Chain dies mid-sync** (crash between `put` and `setAlarm`): cron kick sees
  `updatedAt` > 4 min old, restarts from page 0. Re-processing is idempotent.
- **Jira/Sheets outage**: tick throws, cursor not advanced, backoff doubles up
  to 5 min; when the cron fires after 4+ idle minutes it restarts cleanly.
- **Sprint renamed in Jira**: `getOrCreateSprintSheet` renames the tab on the
  first page that hits it (one extra write, fine).
- **Issue in two active sprints**: `pickSprint` may land it on the "wrong" tab —
  same accepted trade-off as the webhook path.
- **0 issues**: page `isLast` immediately, sync completes on the first tick.
- **`/sync` while cron sync running**: `kick` returns `in_progress`, no state
  change, no double sync.

## Testing

- `syncCoordinator.test.ts` (new): kick start / in-progress / stale-restart;
  alarm advances cursor & reschedules; last page clears state; failure keeps
  cursor, increments backoff, reports to Sentry; `getStatus`; fetch routing.- `sheetWriter.test.ts`: `syncSprintPage` does 1 `values:batchUpdate` with all ranges, per-tab stale-row deletes high-to-low in `batchUpdate`, updates existing rows in place, appends new rows after the header, skips no-sprint issues;
  `withStoredToken` reuses a fresh cached token and refreshes an expired one.
- `jira.test.ts`: `searchIssuesPage` builds URL + Basic auth, passes
  `nextPageToken` on later pages, honors `isLast`, throws on non-OK.
- `webhook.test.ts`: scheduled handler kicks the DO; `/sync` returns
  `{ sprintId, status }` (+ `runningSprintId` when another sprint is mid-sync);
  `/sync/status` returns running/progress.

## Out of scope

- GAS equivalent (legacy runtime untouched).
- Retrying *individual* failed issues within a page (whole-page retry instead).
- Removing duplicate rows that the old chunked sync may have left behind.
