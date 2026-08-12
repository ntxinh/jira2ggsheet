# Sentry Error Tracking for the Cloudflare Worker

**Date:** 2026-08-12
**Status:** Approved

## Goal

Add Sentry error tracking to the Cloudflare Worker so webhook and cron-sync
failures — including the errors currently swallowed by `console.error` — produce
Sentry events and logs for production visibility.

## Decisions

| Topic | Decision |
|---|---|
| SDK | **`@sentry/cloudflare`** — official Cloudflare Workers SDK. |
| Handler integration | **`Sentry.withSentry`** wrapping the exported handler (`fetch` + `scheduled`). No manual hub management. |
| Instrumentation depth | **Wrapper + explicit captures** — `withSentry` plus `Sentry.captureException` at every catch site that currently swallows an error. |
| Logs | **`enableLogs: true`** — existing `console.*` output is forwarded to Sentry as logs; no log calls change. |
| DSN provisioning | **`SENTRY_DSN` secret** (prod via `wrangler secret put`). Absent locally → SDK disabled, so `wrangler dev` never sends events. |
| Tracking | **`tracesSampleRate: 1.0`** — low-traffic webhook/cron worker, full tracing is cheap. |
| Compat | Add **`nodejs_compat`** compatibility flag (SDK requires `AsyncLocalStorage`). |
| Source maps | **Deferred** — error stack traces reference the bundled file for now. |

## Architecture

Approach: official SDK wrapper around the existing Hono handler. No new
services, no request-shaped changes, no schema changes.

### 1. Dependency

```bash
cd src/workers
npm install @sentry/cloudflare
```

### 2. `wrangler.jsonc`

- Add `"compatibility_flags": ["nodejs_compat"]`.
- Cloudflare's own `"observability": { "enabled": true }` stays untouched;
  Sentry is additive.

### 3. Config (`config.ts`, `.dev.vars.example`)

- `Env`: add optional `SENTRY_DSN?: string`.
- `.dev.vars.example`: add commented line documenting how to opt into local
  Sentry reporting.

### 4. Entry point (`index.ts`)

- Import `* as Sentry from '@sentry/cloudflare'`.
- Wrap the default export:

```ts
export default Sentry.withSentry(
  (env: Env) => ({
    dsn: env.SENTRY_DSN,
    enabled: Boolean(env.SENTRY_DSN),
    tracesSampleRate: 1.0,
    enableLogs: true,
  }),
  {
    fetch: (request, env, ctx) => app.fetch(request, env, ctx),
    scheduled: syncSprint,
  } satisfies ExportedHandler<Env>,
);
```

- `fetch` is an arrow wrapper (not `app.fetch` directly) so `this` binding is
  correct inside Hono.
- Add `Sentry.captureException(err)` at the three sites that currently swallow
  errors (`index.ts:86` background-task catch, `index.ts:90` handler catch,
  `index.ts:129` per-issue cron catch) alongside the existing `console.error`.

### 5. Deployment

- Prod: one-time `wrangler secret put SENTRY_DSN "660a1d71d1c0c899f5fe3deb29fa3734@o4511895609475072.ingest.us.sentry.io/4511895614980096"`
  (the DSN already provided; prefix `https://`). The existing deploy
  workflow (`--keep-vars`) preserves it across deploys.
- CI `.github/workflows/deploy.yml`: no changes needed.

## Data flow

1. Request/cron arrives → `withSentry`-wrapped handler starts a transaction.
2. Normal path: issue upsert/deletes proceed as today; `console.*` lines stream
   to Sentry as logs.
3. Failure path: catch sites call `Sentry.captureException(err)` → error event
   with stack trace; the existing `console.error` text also lands as a log.

## Error handling

- Swallowed errors are now captured individually; one webhook issue can't fail
  silently.
- The SDK is disabled when `SENTRY_DSN` is unset, so a broken secret can't throw
  in the request path.

## Testing

- Existing vitest suite and `npm run typecheck` must pass unchanged — tests hit
  `app.fetch` directly and are unaffected by the export wrapper.
- Manual verify: set `SENTRY_DSN` in `.dev.vars`, temporarily add the docs'
  verify snippet (a `Sentry.logger` line + a thrown error), confirm the event
  lands in Sentry, then remove the snippet.

## Out of scope

- `Sentry.logger` / `Sentry.metrics` calls beyond what `console.*` forwarding
  provides.
- Source-map upload and stack-trace de-minification (deferred).
- GAS runtime (legacy) — Cloudflare Worker only.
- Error alerting / rate limits / quota tuning on the Sentry project side.