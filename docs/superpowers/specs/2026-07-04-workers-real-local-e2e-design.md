# Cloudflare Worker Real Local E2E Test - Design

**Date:** 2026-07-04
**Status:** Approved for planning

## Goal

Add one end-to-end test for `src/workers` that runs the Worker locally, fetches a real Jira issue, posts a Jira webhook payload to the local Worker, writes through the real Google Sheets API, and verifies the issue key appears in the configured spreadsheet.

This test proves the live integration path works without deploying a Worker or mocking external services.

## Scope

In scope:

- Local Cloudflare Worker execution through `wrangler dev`.
- Real Jira REST API read of one configured issue.
- Real Google OAuth service account token exchange.
- Real Google Sheets API write through the Worker.
- Real Google Sheets API read for verification.
- One npm script: `npm run test:e2e`.

Out of scope:

- Mocked Jira, OAuth, or Sheets services.
- New test framework dependency.
- Automatic cleanup of the row written to the sheet.
- Deployed Worker testing.
- Jira webhook registration or mutation of Jira data.

## Configuration

The test uses local, gitignored env files:

- `src/workers/.dev.vars` for Worker secrets and runtime values already used by `wrangler dev`.
- `src/workers/.e2e.env` for Jira-only test values.

Required `.dev.vars` values:

- `SECRET_TOKEN`
- `GOOGLE_SERVICE_ACCOUNT_EMAIL`
- `GOOGLE_PRIVATE_KEY`
- `SPREADSHEET_ID`

Required `.e2e.env` values:

- `JIRA_BASE_URL`, for example `https://example.atlassian.net`
- `JIRA_EMAIL`
- `JIRA_API_TOKEN`
- `JIRA_ISSUE_KEY`

The existing `wrangler.jsonc` vars provide project key, custom field IDs, column mapping, key column, template sheet, and delete mode.

## Architecture

Add `src/workers/tests/e2e.js`, a plain Node script using only built-in modules and `fetch`.

Test flow:

1. Load `.dev.vars` and `.e2e.env`.
2. Start `npx wrangler dev --local --port 8787` from `src/workers`.
3. Wait until `http://127.0.0.1:8787` accepts requests.
4. Fetch `JIRA_ISSUE_KEY` from Jira REST:
   `/rest/api/2/issue/{issueKey}`
5. Build a webhook payload:
   `webhookEvent: "jira:issue_updated"` and `issue` from the Jira response.
6. POST that payload to:
   `http://127.0.0.1:8787?token={SECRET_TOKEN}`
7. Wait briefly for `ctx.waitUntil` work to finish.
8. Use the same service account credentials to get a Google OAuth access token.
9. Read Sheets metadata and values to find the issue key in configured sprint tabs.
10. Exit `0` if the issue key is found, else exit `1`.
11. Stop the local Wrangler process in `finally`.

## Data Flow

```text
Node e2e script
  -> Jira REST API: fetch real issue JSON
  -> local Wrangler Worker: POST Jira webhook payload
  -> Google OAuth: Worker exchanges service account JWT for token
  -> Google Sheets API: Worker upserts row
  -> Google OAuth: test script exchanges same service account JWT for token
  -> Google Sheets API: test script verifies issue key exists
```

## Error Handling

The script should fail fast with a clear message when:

- A required env value is missing.
- `wrangler dev` cannot start.
- Jira returns a non-2xx response.
- The local Worker returns a non-2xx response.
- Google OAuth or Sheets verification fails.
- The issue key is not found after retries.

The script should always stop the Wrangler child process before exiting.

## Testing Strategy

This is the test. It is intentionally one file and one npm script.

Expected command:

```bash
cd src/workers
npm run test:e2e
```

The test writes or updates a real row in the configured spreadsheet. That is deliberate. Cleanup is skipped because the target behavior is an upsert, and deleting the row would exercise a different product path.

## Minimality Decisions

- Use plain Node instead of adding Vitest, Playwright, or Miniflare.
- Use `wrangler dev` instead of importing Worker internals, because the goal is local runtime coverage.
- Use one real Jira issue key instead of creating or mutating Jira issues.
- Reuse service account OAuth logic shape instead of adding another auth dependency.
- Leave cleanup out until repeated e2e runs create real maintenance pain.
