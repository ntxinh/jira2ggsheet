# Design Spec: Hono + Scalar OpenAPI Integration

## Overview
Migrate the existing raw Cloudflare Worker to Hono and integrate Scalar for OpenAPI documentation. Use `@hono/zod-openapi` for type-safe schema definition and automatic spec generation.

## Goals
- Type-safe webhook payload validation.
- Automatic OpenAPI 3.0/3.1 spec generation.
- Interactive API documentation via Scalar.
- Maintain existing webhook functionality and security.

## Architecture
- **Framework**: `Hono` with `@hono/zod-openapi`.
- **Documentation**: `@scalar/hono-api-reference`.
- **Validation**: `Zod`.

## Proposed Changes

### Dependencies
Add the following to `src/workers/package.json`:
- `hono`
- `@hono/zod-openapi`
- `@scalar/hono-api-reference`
- `zod`

### Routing Table
| Path | Method | Description |
|------|--------|-------------|
| `/` | `POST` | Jira Webhook receiver (requires `token` query param). |
| `/openapi.json` | `GET` | Generated OpenAPI spec. |
| `/docs` | `GET` | Scalar UI. |

### Component Details

#### 1. Schema Definitions
Define `JiraWebhookSchema` representing the expected Jira payload. This will be used for both documentation and runtime validation.

#### 2. Webhook Handler
Refactor `src/workers/index.ts` to use Hono routes.
- Use `openapi.openapi()` to define the POST route.
- Implement token validation as a Hono middleware or within the route definition.
- Use `c.req.valid('json')` for validated payload access.

#### 3. Scalar Integration
Mount the Scalar middleware at `/docs` pointing to `/openapi.json`.

## Error Handling
- **401 Unauthorized**: Missing or invalid `token` query param.
- **400 Bad Request**: Payload does not match `JiraWebhookSchema`.
- **405 Method Not Allowed**: Non-POST requests to `/`.

## Testing Strategy
- Unit tests for schema validation.
- Integration tests (using `app.request()`) to verify:
  - Webhook still processes valid payloads.
  - `/openapi.json` returns valid JSON.
  - `/docs` returns HTML.
