# Chunked Sprint Sync Implementation Plan

**Date:** 2026-08-12

**Goal:** Stop Google Sheets `429 RESOURCE_EXHAUSTED` when a sprint has hundreds of issues (observed: 800+ tickets in one `/sync` run). The cron now runs every 15 minutes and processes one rotating chunk of the sprint per tick; the manual `/sync` processes the chunk for the current time slot and reports progress.

## Problem

- Sheets API quota is **per minute per user**: 60 read req/min + 60 write req/min (plus 300/min per project).
- Each `upsertIssue` costs ~2 reads (`getSheets` + `readKeyColumns` batchGet) + ~2–4 writes (row write, cross-tab row deletes, tab rename/duplicate).
- 800 issues ≈ 4,000 requests. Even split into 50-issue chunks **without pacing**, each chunk fires ~100 reads + ~150 writes back-to-back inside the first minute — still over both 60/min caps. Chunking alone does **not** fix the 429; pacing does.

## Solution

1. **Rotating chunks** (stateless, no KV/DO): `chunkIdx = floor(Date.now() / TICK_MS) % numChunks` with `TICK_MS = 15 min` matching the cron. Upserts are idempotent, so a skipped/overlapping tick is harmless.
2. **Pacing**: sleep `SYNC_DELAY_MS` (default 4000 ms) between upserts. ~4s/issue → reads ~30/min, writes ~30–45/min, both under 60. A 50-issue tick takes ~4 min, inside cron's 15-min wall-clock limit. 800 issues cycle fully in ~16 ticks (4 h); webhooks cover real-time changes meanwhile.
3. **429 retry with backoff** in `sheetWriter.apiFetch` (1s/2s/4s, 4 attempts). 429 means the request was rejected, not applied, so retrying is safe. Covers bursts from webhooks sharing the same service-account quota bucket.

## Files

- `src/workers/index.ts` — `CHUNK_SIZE=50`, `TICK_MS`, `DEFAULT_SYNC_DELAY_MS`, `sleep()`, pacing loop, `SyncStats` return (`issuesSynced`, `issuesFailed`, `totalIssues`, `chunkSize`, `chunkIndex`), route description updated.
- `src/workers/config.ts` — optional `SYNC_DELAY_MS` on `Env`.
- `src/workers/sheetWriter.ts` — 429 backoff retry in `apiFetch`.
- `src/workers/wrangler.jsonc` — cron `0 0 * * *` → `*/15 * * * *` (Cloudflare supports ≥1-min intervals; cron invocations get 15-min wall-clock).
- Tests: `tests/mock-env.ts` (`SYNC_DELAY_MS: '0'`), `tests/webhook.test.ts` (response shapes, chunk rotation, pacing), `tests/sheetWriter.test.ts` (429 retry + give-up).
- `src/workers/.dev.vars.example` — documented `SYNC_DELAY_MS`.

## Verification

```bash
cd src/workers
npm run typecheck && npm test
```

## Notes / trade-offs

- `/sync` now returns after one chunk (~4 min for 50 issues at default pacing) instead of failing mid-sprint. `totalIssues`/`chunkIndex`/`chunkSize` show remaining progress; repeat or wait for the cron to advance.
- `numChunks` derives from the live issue count each tick; if it changes, rotation may repeat/skip a chunk — acceptable (idempotent).
- If the cron interval ever changes, `TICK_MS` in `index.ts` must change with it.
