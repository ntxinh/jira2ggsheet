# Nightly Sprint Sync Cron

**Date:** 2026-07-31
**Status:** Approved

## Goal

Add a Cloudflare Worker cron trigger that runs every midnight (UTC) and syncs
every issue of a configured sprint into its per-sprint tab, catching anything
the webhook missed.

## Decisions

| Topic | Decision |
|---|---|
| Runtime | **Cloudflare Worker** — extend the existing worker with a `scheduled` handler. |
| Cron schedule | `0 0 * * *` (midnight **UTC**). Cloudflare crons are UTC-only; the config `TIMEZONE` is not consulted. |
| Jira auth | **Basic auth** — `JIRA_EMAIL` + `JIRA_API_TOKEN` env vars, sent as `Authorization: Basic base64(email:token)`. |
| Sync semantics | **Upsert only** — loop `upsertIssue` over every JQL result; rows not returned are left in place. No clear/rebuild. |
| Sprint id source | Plain var `SPRINT_ID` in `wrangler.jsonc` `vars` (not secret). |
| JQL | `project = {PROJECT_KEY} AND sprint = {SPRINT_ID} ORDER BY created ASC` |
| Jira fields requested | `fields=*all` — no per-field mapping to maintain; a sprint's worth of issues is small. |

## Architecture

Approach: **cron on the existing worker**. New `jira.ts` for the Jira REST
client; the `scheduled` handler reuses the exact `upsertIssue` path the webhook
already uses. No new dependencies, no new sheet logic.

### 1. Cron trigger (`wrangler.jsonc`)

- Add `"triggers": { "crons": ["0 0 * * *"] }`.
- Add var `"SPRINT_ID": "<sprint-id>"`.

### 2. Jira client (`jira.ts`)

New file, one exported function:

- `searchIssues(jql, subdomain, email, apiToken): Promise<JiraIssue[]>` —
  paginated `GET https://{subdomain}.atlassian.net/rest/api/3/search/jql`
  with `jql`, `fields=*all`, `maxResults=100`, `startAt` advancing until all
  pages are collected. Basic auth header. Returns `JiraIssue[]` in the same
  `{ key, fields }` shape the webhook consumes.

### 3. Entry point (`index.ts`)

- Default export becomes `{ fetch: app.fetch, scheduled }` so both the webhook
  and cron share one worker.
- `scheduled` handler:
  1. Build `jql = project = {PROJECT_KEY} AND sprint = {SPRINT_ID} ORDER BY created ASC`.
  2. `issues = await searchIssues(jql, ...)`.
  3. `await withToken(googleEmail, privateKey, token => loop upsertIssue(SPREADSHEET_ID, issue, token, config))`.
  4. Per-issue try/catch — one bad issue logs and continues; the run does not abort.

### 4. Config (`config.ts`, `.dev.vars.example`)

- `Config` + `Env`: add `SPRINT_ID`.
- `Env`: add `JIRA_EMAIL`, `JIRA_API_TOKEN`.
- `.dev.vars.example`: add `SPRINT_ID`, `JIRA_EMAIL`, `JIRA_API_TOKEN`.
- Prod: `wrangler secret put` for `JIRA_EMAIL` / `JIRA_API_TOKEN`.

## Error handling

- Jira search failure (network, 401, 403) → `scheduled` handler throws; Cloudflare
  logs it and the run fails loudly.
- One issue failing to upsert → logged, remaining issues still processed.
- Issue with no resolvable sprint → `upsertIssue` already skips it (existing behavior).

## Edge cases

- Sprint has >100 issues → pagination loop collects all pages.
- JQL `sprint = <id>` returns issues whose sprint *field* also lists other
  sprints; `upsertIssue` targets the tab by its active/last-sprint pick
  (`ponytail:` same selection rule as the webhook). An issue in two active
  sprints may land in the other sprint's tab — accepted, matches webhook behavior.
- Sprint tab missing → `getOrCreateSprintSheet` clones the template (existing behavior).

## Testing

New vitest test `jira.test.ts` with mocked `fetch`:
- URL composition (subdomain, jql, `fields=*all`, pagination params).
- Basic auth header (email:token).
- Multi-page collection.
- `scheduled` handler invokes `searchIssues` + `upsertIssue` (via existing
  mock-env pattern).

## Out of scope

- Full rebuild / reconciliation of the tab (upsert only, per decision).
- Midnight in the configured `TIMEZONE` (UTC only).
- GAS equivalent (legacy runtime untouched).
- Auto-rotating `SPRINT_ID` when the sprint ends — updated manually in `wrangler.jsonc`.
