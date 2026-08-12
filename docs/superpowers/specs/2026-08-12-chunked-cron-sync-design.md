# Chunked Sprint Sync (rate-limit fix)

**Date:** 2026-08-12
**Status:** Approved

## Goal

Eliminate Google Sheets `429 RESOURCE_EXHAUSTED` on the sprint sync when a sprint
has hundreds of issues (observed with 800+ tickets), without adding stateful
infrastructure.

## Problem

Sheets API quotas are **per minute per user**: 60 read req/min, 60 write
req/min (per project: 300/min). `upsertIssue` costs ~2 reads + ~2–4 writes per
issue. A one-shot sync of 800 issues (~4,000 requests) exceeds the per-minute
caps immediately. Chunking by time window alone is insufficient — a 50-issue
chunk still bursts ~100 reads + ~150 writes inside the first minute of its tick.

## Decisions

| Topic | Decision |
|---|---|
| Cadence | Cron `*/15 * * * *` (was daily `0 0 * * *`); Cloudflare supports ≥1-min intervals, cron invocations get 15-min wall-clock. |
| Chunking | Stateless rotating slices: `chunkIdx = floor(now / 15min) % numChunks`. No KV/Durable Object. Upserts idempotent → skipped/overlapping ticks harmless. |
| Pacing | Sleep `SYNC_DELAY_MS` (default 4000 ms) between upserts → ~30 reads + ~30–45 writes per minute, under both 60/min caps. 50-issue tick ≈ 4 min. |
| 429 handling | `apiFetch` retries 429 with 1s/2s/4s backoff (4 attempts max). 429 = rejected-before-apply, retry is safe. |
| Manual `/sync` | Runs the current chunk and returns `{sprintId, issuesSynced, issuesFailed, totalIssues, chunkSize, chunkIndex}` so progress is visible. |
| Config | Optional `SYNC_DELAY_MS` env (code default 4000 ms); tests set `0` to stay fast. |

## Architecture

- `index.ts`: `syncSprint` fetches the sprint's issues (JQL), computes the
  rotating chunk, upserts it with pacing, and returns `SyncStats`. Shared by the
  `scheduled` cron handler and the `GET /sync` route.
- `sheetWriter.ts`: `apiFetch` gains 429 backoff retry (applies to webhooks too,
  which share the same service-account quota bucket).
- `wrangler.jsonc`: cron interval changed to `*/15 * * * *`.

## Edge cases

- Issues ≤ 50 → `numChunks = 1`, whole sprint in one tick (behavior unchanged).
- Zero issues → early return with zeroed stats, same shape as a normal run.
- Issue count changes between ticks → modulo rotation may repeat/skip a chunk;
  idempotent upserts make this harmless.
- Webhook bursts during a tick consume the same per-user quota → 429 retry absorbs them.

## Testing

- Chunk rotation: 120 issues, two 15-min slots → 50 issues each, keys `ABC-1..50`
  then `ABC-51..100` (fake timers).
- Pacing: with `SYNC_DELAY_MS=4000`, the second issue's upsert only happens
  after the delay elapses.
- 429: first metadata call returns 429, backoff elapses, retry succeeds
  (2 metadata calls); all-429 stub throws `Sheets API 429` after 4 attempts.
- Response shapes updated for the new `SyncStats` fields.

## Out of scope

- Batch Sheets API refactor of `sheetWriter.ts` (bigger win, bigger change).
- Persistent cursor / queue for guaranteed no-skip rotation.
- GAS equivalent (legacy runtime untouched).
