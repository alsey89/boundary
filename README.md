# Boundary

**Errors, debugging, and failure policy for HTTP APIs. Throw on the server, policy on the client, proof in CI.**

Your validation already works (Zod). Your tracing already works (OTel). Boundary makes your *failures* work — and never replaces either.

```bash
npm i @boundaryjs/server @boundaryjs/client
```

---

## The problem

Every team reinvents the same four things, slightly differently:

- What an error looks like on the wire
- How to stop debug data leaking into responses
- What the client does when a call fails
- How to prove any of it stays true

Boundary is one answer to all four, adoptable one route at a time, deletable without a rewrite.

## What you get

| Piece | What it does |
|---|---|
| [`@boundaryjs/server`](packages/server) | Error sink: anything you `throw` becomes RFC 9457 `application/problem+json` with a real status code. Debug context routes to your OTel span, never the wire. |
| [`@boundaryjs/next`](packages/next) | Build-time transform for Next.js App Router, which has no error sink. No wrapper code, no ceremony. |
| [`@boundaryjs/client`](packages/client) | Fetch wrapper (~400 lines). Errors throw. Failure policy is set per call site, defaulted per code. |
| [`boundary-conform`](packages/conform) | Black-box CI suite that proves your API honors the contract — any backend, any language. |

## Server

Register once. Then just throw.

```ts
import { problemSink, NotFound } from '@boundaryjs/server'

app.onError(problemSink())   // one line, app-wide, opt-out not opt-in

app.get('/orders/:id', async (c) => {
  const order = await db.find(c.req.param('id'))
  if (!order) {
    throw new NotFound('ORDER_NOT_FOUND', 'No such order.', {
      log: { shardKey, replicaLagMs: 240 },   // → span + log record. NEVER serialized.
    })
  }
  return c.json(order)
})
```

Wire output:

```http
HTTP/1.1 404 Not Found
Content-Type: application/problem+json
X-Trace-Id: 4bf92f3577b34da6a3ce929d0e0e4736

{
  "type": "https://errors.acme.com/order-not-found",
  "title": "Order not found",
  "status": 404,
  "code": "ORDER_NOT_FOUND",
  "detail": "No such order.",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

**The rules that make this safe:**

- **Real status codes.** 4xx means you erred, 5xx means we did. CDNs, load balancers, Sentry, and `Retry-After` all work for free.
- **`code` is the only field clients may branch on.** `type` is a URL and will move; `title`/`detail` are prose and will be reworded. `code` is the contract.
- **Debug context never crosses the wire.** There is no env flag, no dev mode, no code path that serializes `log`. Paste the `traceId` into your log tool and get context richer than any response body could carry. One misconfigured `NODE_ENV` cannot leak your API surface, because nothing is gated on it.
- **Pass-through.** The sink transforms only `ApiError`. Plain errors, framework redirects, third-party throws — re-raised untouched. Installing the sink is a no-op until a route opts in by throwing, which is what makes route-by-route adoption real.

**Next.js App Router** has no error sink — middleware runs before routing and can't catch a throw. `@boundaryjs/next` wraps your exported handlers at build time (same technique Sentry's SDK uses), so you write plain handlers and the contract holds anyway. Works under both webpack and Turbopack builds.

**Express 4** works too — register the sink the same way, but Express 4 doesn't forward rejected async handlers to error middleware on its own: call `next(err)` or use `express-async-errors`. Express 5 does it natively.

## Client

Errors throw. That's what integrates with the ecosystem — React Query retries, error boundaries catch, and an unhandled failure is loud instead of `undefined`.

```ts
import { createClient } from '@boundaryjs/client'

export const api = createClient({
  baseUrl: '/api',
  policy: {
    UNAUTHENTICATED: 'reauthenticate',   // clear session, redirect
    RATE_LIMITED:    'retry',            // honors Retry-After, capped
    VALIDATION_FAILED: 'silent',         // the form renders it
    '*':             'report',           // toast + telemetry, then rethrow
  },
})
```

The same error code means different things at different call sites. A 401 on a background poll should not yank the user out of their work; a 401 on a form submit should. Policy is a per-call option:

```ts
// Background poll — swallow the 401
api.get('/notifications', { policy: { UNAUTHENTICATED: 'silent' } })

// Form submit — default policy applies
api.post('/orders', body)
```

Four policies, deliberately few: `silent`, `report`, `retry`, `reauthenticate`. All rethrow — `reauthenticate` after a grace period long enough for the redirect to unload the page — so global side effects and local handling both happen, and nothing hangs forever when a redirect doesn't. `retry` only replays idempotent methods; a POST that's safe to replay (say, it carries an `Idempotency-Key`) opts in with `{ idempotent: true }`.

Where failure is an *expected* outcome, opt into a Result:

```ts
const res = await api.get<User>('/users/123').safe()
if (!res.ok && res.error.code === 'USER_NOT_FOUND') return null
```

## Conformance

A spec nobody enforces is a document. `boundary-conform` runs black-box against a live server:

```bash
npx boundary-conform http://localhost:3000
# ✓ 404 emits application/problem+json with a stable code
# ✓ 422 carries field-level errors[]
# ✓ no stack trace, SQL, or hostname in any error body — any NODE_ENV
# ✓ Retry-After present on 429 and 503
# ✓ framework redirect() passes through untouched
# ✓ traceId in header and body match
```

Language-agnostic by construction: it only speaks HTTP. Put it in CI for your Go and Python services too.

## What Boundary does not do

- **Payload validation.** Zod, generated OpenAPI clients, ts-rest — use them. Boundary defines what an error looks like *after* validation fails, not how you validate.
- **Telemetry.** OTel already does zero-config trace propagation. Boundary's entire contribution: `code` and `trace_id` become span attributes on failure.
- **Data fetching.** No cache, no dedup, no invalidation. React Query does it better. The client is a fetch wrapper you can delete in an afternoon.
- **End-to-end type inference.** `api.get<User>()` is an assertion. Want checked types? Generate a client from OpenAPI — Boundary composes with it.

## Compatibility

- **Node ≥ 20.** Declared via `engines` on every package.
- **ESM and CommonJS.** Every package ships both builds; `require('@boundaryjs/server')` works in a legacy CJS Express or Nest app, no transpiler gymnastics. Cross-build identity is safe: `isApiError` recognizes an `ApiError` thrown by the other build (or a duplicated copy) via a shared `Symbol.for` marker.
- **Frameworks:** Hono (and anything web-standard), Express 5 (Express 4 with `next(err)` or `express-async-errors`), Fastify 5, Koa 2 and 3, NestJS (Express and Fastify adapters), Next.js App Router (webpack and Turbopack, verified against Next 16).
- **`boundary-conform`** needs none of the above — it only speaks HTTP.

## Adoption

1. Add `problemSink()` — a no-op until a route throws `ApiError`.
2. Convert one route. Run `boundary-conform` against it.
3. Convert the rest at whatever pace you like. Old routes keep their old error shapes until touched.
4. To leave: delete the throws, delete the sink. No rewrite.

## Repository layout

| Path | Contents |
|---|---|
| [`SPEC.md`](SPEC.md) | The normative wire contract `boundary-conform` enforces |
| [`packages/server`](packages/server) | `@boundaryjs/server` — errors, renderer, sinks for Hono/web, Express, Fastify, Koa, Nest |
| [`packages/client`](packages/client) | `@boundaryjs/client` — fetch wrapper with failure policies |
| [`packages/next`](packages/next) | `@boundaryjs/next` — App Router build-time transform |
| [`packages/conform`](packages/conform) | `boundary-conform` — black-box conformance suite + CLI |
| [`examples/express-basic`](examples/express-basic) | Complete example API; CI runs the conformance suite against it |

Develop:

```bash
npm install
npm run build          # tsc -b across packages
npm test               # vitest across packages
npm run conform:example  # boot the example server, run boundary-conform against it
```

## FAQ

**Why not tRPC / ts-rest?** They own the whole channel and shine on greenfield. Boundary is for the existing REST API you can't rewrite: it rides on plain HTTP, composes with React Query, and is removable.

**Why not just RFC 9457 by hand?** You can — the wire format is the standard, unextended except for `code` and `traceId`. Boundary is the sink, the Next transform, the policy layer, and the proof. The spec is free; the enforcement is the product.

**Why do errors throw instead of returning a Result?** Because `res.ok` checks compile fine when omitted, converting "throws loudly" into "proceeds with undefined." Throwing is the failure mode the ecosystem is built around. `.safe()` exists for the minority of call sites where failure is expected.

---

MIT. Spec, sink implementations (Hono, Fastify, Express, Koa, Nest), Next transform, client, and conformance suite in one repo, published as independent packages — take only what you need.
