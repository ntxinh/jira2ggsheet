# Sprint Rename → Sheet Tab Rename

**Date:** 2026-08-14
**Status:** Approved

## Goal

When a sprint is renamed in Jira, the spreadsheet tab `<sprintId>_<name>` must be
renamed to match — for **any** sprint that has a tab, not just the configured
`SPRINT_ID`, and as fast as Jira will tell us (webhook fast path when it fires,
5-minute cron sweep as the reliable backstop).

## Problem

The rename logic already exists (`getOrCreateSprintSheet` in `sheetWriter.ts`
finds a tab by the `{sprintId}_` prefix and renames it via `updateSheetProperties`
when the title differs; the GAS legacy `getSprintSheet_` does the same), but in
practice **tabs never get renamed**:

1. **Jira does not reliably fire webhooks on sprint renames.** Sprint renames are
   sprint-level operations; Atlassian community reports indicate the sprint field
   change often produces no `jira:issue_updated` event (e.g. "Sprint on Ticket is
   not seen as an 'update'", Jul 2024). So the webhook path (`upsertIssue` →
   `getOrCreateSprintSheet`) rarely sees the new name.
2. **The cron sync only covers the configured `SPRINT_ID`.** Its JQL is
   `project = X AND sprint = {SPRINT_ID}`, so tabs for any other renamed sprint are
   never touched by the 5-minute alarm chain either.

Additionally, the webhook fast path has a latent bug: after renaming,
`getOrCreateSprintSheet` returns the `SheetInfo` with the **old title**, and its
callers (`upsertIssue`, `syncSprintPage`) then read key columns / write rows
against the old, now-nonexistent tab name — failing the rest of that request.

## Decisions

| Topic | Decision |
|---|---|
| Detection | **Active sweep, not passive rename.** Since webhooks can't be trusted for sprint renames, the `*/5` cron watchdog (which already wakes `SyncCoordinator`) also compares every sprint tab's name against Jira's current sprint name and renames mismatches. Webhook-driven rename stays as the fast path where Jira *does* fire an update. |
| Where the sweep runs | Inside `SyncCoordinator.kick()`, after the in-progress early-return and before starting/restarting page sync. Both the cron and `GET /sync` already call `kick()`, so no new routes or triggers. If a sync is already running, `kick()` returns `in_progress` without running the sweep; it is picked up on the next cron tick. |
| Source of truth for names | Jira Software Agile API `GET /rest/agile/1.0/sprint/{sprintId}` (same Basic auth as `searchIssuesPage`), one call per tab. Authoritative even for empty/closed sprints, which issue-search JQL would miss. |
| Tab enumeration | Reuse the existing spreadsheet metadata read (`getSheets`): tabs matching `^\d+_` (template excluded) → sprint ID = leading digits. |
| Rename write | All mismatches renamed in **one** `batchUpdate` (one `updateSheetProperties` per tab, `fields: 'title'`) — same batched pattern as the page sync. |
| Failure isolation | A sprint fetch failure (e.g. 404 — sprint deleted) or a rename failure logs + reports to Sentry and never blocks the page sync. Sweep errors are caught in `kick()`. |
| Stale-title bug | `getOrCreateSprintSheet` returns `{ sheetId, title: target }` after a rename so webhook/sync writes target the new tab name. |
| GAS legacy | Untouched (AGENTS.md: no features unless asked). Its `getSprintSheet_` has no stale-title bug (returns the live sheet object). |

## Architecture

```
Cron */5 ──► SyncCoordinator.kick()          GET /sync ──► SyncCoordinator.kick(id)
                 │
                 ├─ 1. syncTabNames()   (new, best-effort)
                 │      getSheets → sprint tabs
                 │      per tab: fetchSprintName(id) from Agile API   # 1 subrequest each
                 │      collect { sheetId, newTitle } mismatches
                 │      one batchUpdate rename                        # 1 subrequest
                 │      (errors → log + Sentry, never throw)
                 │
                 └─ 2. existing page-sync start (unchanged)
```

New/changed units:

- `jira.ts`: `fetchSprintName(sprintId, subdomain, email, apiToken)` → `string` —
  Basic auth, throws on non-OK (404 included; caller treats it as skip).
- `sheetWriter.ts`: fix stale-title return; export `getSheets` and `sprintSheetName`
  (name computation stays in one place); add
  `renameSprintTabs(spreadsheetId, renames, token)` — one `batchUpdate`.
- `syncCoordinator.ts`: private `syncTabNames()` called at the top of `kick()`;
  composes the above with `withStoredToken` for the Sheets side.

Naming stays `{sprintId}_{sanitizedName}` sliced to 100 chars (existing
`sprintSheetName`), so a rename can never collide with another sprint's tab (the
ID prefix is unique).

## Edge cases

- **Sprint deleted in Jira**: Agile API 404 → tab left as-is (logged, Sentry).
  Deleting orphan tabs is out of scope.
- **Tab whose sprint ID no longer exists**: same as above — skip, keep tab.
- **Rename during a long page sync**: sweep is skipped while `in_progress`; the
  next `*/5` cron kick (after the sync finishes) catches it — bounded by one cron
  interval.
- **Multiple sprint tabs / many renames**: one `batchUpdate` handles all renames
  in a single request; subrequest count stays ~N+2 (N sprint fetches + 1 metadata
  + 1 rename), well under the Free-plan 50-subrequest cap for realistic sprint
  counts.
- **Sweep failure mid-way**: caught in `kick()`, logged, Sentry; page sync still
  starts (a rename failure must never block syncing rows).
- **Webhook with a renamed sprint**: existing `upsertIssue` path renames the tab
  immediately (fast path) — now without the stale-title failure.

## Testing

- `sheetWriter.test.ts`: `getOrCreateSprintSheet` returns the **new** title after
  a rename; `renameSprintTabs` issues one `batchUpdate` with all
  `updateSheetProperties` requests.
- `jira.test.ts`: `fetchSprintName` builds the Agile URL + Basic auth, returns the
  name, throws on non-OK.
- `syncCoordinator.test.ts`: `kick()` runs `syncTabNames` first (renames a
  mismatched tab, skips a matching one, skips a 404 sprint), and a sweep failure
  does not prevent the page sync from starting; `kick` while `in_progress` skips
  the sweep.
- Existing suite stays green: `npm run typecheck` + `npm test` in `src/workers/`.

## Out of scope

- GAS equivalent (legacy runtime untouched).
- Deleting tabs for sprints deleted in Jira.
- Renaming the Template tab or non-sprint tabs.
- New webhook event types or Jira-side configuration changes.
