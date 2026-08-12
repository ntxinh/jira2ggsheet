# Sentry Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Sentry error tracking to the Cloudflare Worker so webhook and cron-sync failures — including errors currently swallowed by `console.error` — produce Sentry events and logs.

**Architecture:** Wrap the existing Hono exported handler (`fetch` + `scheduled`) with `Sentry.withSentry` from `@sentry/cloudflare`. The SDK is enabled only when the `SENTRY_DSN` env/secret is present, so local `wrangler dev` never sends events. `enableLogs` forwards existing `console.*` output; `Sentry.captureException` is added at the three catch sites that currently swallow errors.

**Tech Stack:** TypeScript, Cloudflare Workers (`wrangler`), Hono, `@sentry/cloudflare`, vitest.

## Global Constraints

- SDK: `@sentry/cloudflare` (official Cloudflare Workers SDK).
- `wrangler.jsonc` must gain `"compatibility_flags": ["nodejs_compat"]` (SDK needs `AsyncLocalStorage`).
- DSN comes only from env var / secret `SENTRY_DSN`. SDK options use `enabled: Boolean(env.SENTRY_DSN)` so an absent DSN disables sending.
- Options: `tracesSampleRate: 1.0`, `enableLogs: true`.
- Keep Cloudflare's own `"observability": { "enabled": true }` untouched.
- `Sentry.captureException` added to: webhook background-task catch, webhook handler catch, per-issue cron catch (`src/workers/index.ts:86,90,129`).
- Source maps / de-minified stack traces: **out of scope** (deferred).
- All commands run from `src/workers/` unless noted.

---

### Task 1: SDK dependency, compat flag, and `SENTRY_DSN` plumbing

**Files:**
- Modify: `src/workers/package.json` + `package-lock.json` (via `npm install`)
- Modify: `src/workers/wrangler.jsonc`
- Modify: `src/workers/config.ts`
- Modify: `src/workers/.dev.vars.example`
- Modify: `SETUP.md`

**Interfaces:**
- Produces: `Env.SENTRY_DSN?: string` (used by Task 2 as `env.SENTRY_DSN`).

- [ ] **Step 1: Install the SDK**

Run: `npm install @sentry/cloudflare`
Expected: package added under `"dependencies"` in `package.json` (e.g. `^9.x`).

- [ ] **Step 2: Add the compat flag to `wrangler.jsonc`**

Add after the existing `"compatibility_date"` line:

```jsonc
  "compatibility_flags": ["nodejs_compat"],
```

- [ ] **Step 3: Add `SENTRY_DSN` to the `Env` interface in `config.ts`**

Add this line to the `Env` interface (after `COLUMN_MAP_JSON`):

```ts
  SENTRY_DSN?: string;
```

Note: it is optional on purpose — `tests/mock-env.ts` does not need it, and an
absent DSN disables the SDK in Task 2.

- [ ] **Step 4: Document local opt-in in `.dev.vars.example`**

Append a commented line:

```
# SENTRY_DSN=https://660a1d71d1c0c899f5fe3deb29fa3734@o4511895609475072.ingest.us.sentry.io/4511895614980096  # uncomment to enable local Sentry reporting
```

- [ ] **Step 5: Document the prod secret in `SETUP.md`**

In `SETUP.md` under **Option A → 4. Configure and deploy**, inside the "Set
required secrets" code block (after the `SPREADSHEET_ID` entry), add:

```bash
npx wrangler secret put SENTRY_DSN
# Paste: https://660a1d71d1c0c899f5fe3deb29fa3734@o4511895609475072.ingest.us.sentry.io/4511895614980096
```

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no errors).

- [ ] **Step 7: Commit**

```bash
git add src/workers/package.json src/workers/package-lock.json src/workers/wrangler.jsonc src/workers/config.ts src/workers/.dev.vars.example SETUP.md
git commit -m "chore: add @sentry/cloudflare and nodejs_compat flag"
```

---

### Task 2: Wire Sentry into the handler and capture errors (TDD)

**Files:**
- Modify: `src/workers/tests/webhook.test.ts`
- Modify: `src/workers/index.ts`

**Interfaces:**
- Consumes: `Env.SENTRY_DSN?: string` from Task 1.
- Produces: default export becomes `{ fetch, scheduled }` produced by
  `Sentry.withSentry(...)`; `Sentry.captureException(err)` calls at the three
  catch sites. Test mock exports `withSentry` (passthrough) and
  `captureException` (spy) from `@sentry/cloudflare`.

- [ ] **Step 1: Write the failing test**

In `src/workers/tests/webhook.test.ts`:

1. After the existing `vi.mock('../sheetWriter', ...)` block, add a Sentry shim
   so tests never touch the real SDK, and import the spy:

```ts
vi.mock('@sentry/cloudflare', () => ({
  withSentry: (_options: unknown, handler: unknown) => handler,
  captureException: vi.fn(),
}))

import { captureException } from '@sentry/cloudflare'

const captureExceptionMock = vi.mocked(captureException)
```

2. Add this test inside the existing `describe('scheduled — sprint cron sync', ...)` block:

```ts
it('reports per-issue failures to Sentry', async () => {
  searchIssuesMock.mockResolvedValue([{ key: 'ABC-1', fields: {} }])
  upsertIssueMock.mockRejectedValueOnce(new Error('sheets down'))

  const module = await import('../index')
  const { scheduled } = module.default as { scheduled: (c: { cron: string }, env: typeof testEnv) => Promise<void> }

  await scheduled({ cron: '0 0 * * *' }, testEnv)

  expect(captureExceptionMock).toHaveBeenCalledTimes(1)
  expect(captureExceptionMock).toHaveBeenCalledWith(expect.any(Error))
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/webhook.test.ts -t "reports per-issue failures"`
Expected: FAIL — `captureExceptionMock` was not called (index.ts doesn't call
it yet). All other existing tests in the file still PASS.

- [ ] **Step 3: Implement the wrapper and captures in `index.ts`**

1. Add the import at the top of the file:

```ts
import * as Sentry from '@sentry/cloudflare'
```

2. Replace the current default export (`export default { fetch: app.fetch, scheduled: syncSprint }`) with:

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
)
```

`fetch` is an arrow wrapper (not `app.fetch` bare) so `this` binding inside
Hono is correct. `ExportedHandler` is a global from `@cloudflare/workers-types`
(already in `tsconfig.json` `types`).

3. Add `Sentry.captureException` to the three catch sites, alongside the
   existing `console` calls:

- Background-task catch (`work.catch((err) => console.error('Handler failed: ' + err))`):

```ts
      const safe = work.catch((err) => {
        console.error('Handler failed: ' + err)
        Sentry.captureException(err)
      })
```

- Webhook handler catch (`catch (err) { console.log('Webhook handler error: ' + err) }`):

```ts
  } catch (err) {
    console.log('Webhook handler error: ' + err)
    Sentry.captureException(err)
  }
```

- Per-issue cron catch (`catch (err) { console.error(...) }`):

```ts
        } catch (err) {
          console.error(`Sprint sync failed for ${issue.key}: ${err}`)
          Sentry.captureException(err)
        }
```

- [ ] **Step 4: Run tests and typecheck to verify pass**

Run: `npm test`
Expected: ALL PASS, including the new "reports per-issue failures to Sentry"
test and all pre-existing webhook, schema, and jira tests.

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/workers/index.ts src/workers/tests/webhook.test.ts
git commit -m "feat: track worker errors with Sentry"
```

---

### Task 3: Manual verification (no commit)

Verify end-to-end that a captured error actually lands in Sentry, then remove
all verification scaffolding.

**Files:**
- Modify (temporarily, then revert): `src/workers/.dev.vars`, `src/workers/index.ts`

- [ ] **Step 1: Enable local Sentry**

Copy `.dev.vars.example` to `.dev.vars` if it doesn't exist, then uncomment the
`SENTRY_DSN=` line (the real DSN from `.dev.vars.example`). Keep `SECRET_TOKEN`
and the Google vars from your existing `.dev.vars`.

- [ ] **Step 2: Add the verify snippet**

Inside the POST route handler in `index.ts`, just before `return c.text('ok')`,
temporarily add:

```ts
Sentry.logger.info('User triggered test error', { action: 'test_error_worker' })
Sentry.metrics.count('test_counter', 1)
throw new Error('Sentry verify')
```

The throw is caught by the route's `try/catch`, so the response is still `ok`
and `Sentry.captureException` fires.

- [ ] **Step 3: Run and trigger**

Run: `npm run dev`
Then POST a valid webhook from another terminal (matches the test payload):

```bash
curl -s -X POST 'http://localhost:8787/?token=<your SECRET_TOKEN>' \
  -H 'content-type: application/json' \
  -d '{"webhookEvent":"jira:issue_created","issue":{"key":"TEST-1","fields":{"project":{"key":"ABC"}}}}'
```

Expected: response `ok`; in the Sentry project dashboard
(`https://sentry.io/organizations/home-741/`), a new **Issue** titled
`Error: Sentry verify` with a captured stack trace, plus the log line and the
`test_counter` metric.

- [ ] **Step 4: Revert all verification scaffolding**

Remove the verify snippet from `index.ts` and the `SENTRY_DSN` line from
`.dev.vars` (`.dev.vars` is gitignored; the committed `.dev.vars.example`
stays as-is).

- [ ] **Step 5: Confirm clean state**

Run: `npm run typecheck && npm test`
Expected: PASS. Then deploy to production with the secret set:

```bash
npx wrangler secret put SENTRY_DSN   # paste https://660a1d71d1c0c899f5fe3deb29fa3734@o4511895609475072.ingest.us.sentry.io/4511895614980096
npm run deploy
```

No commit needed — Task 3 leaves no source diff.
