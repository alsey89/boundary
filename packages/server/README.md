# @boundaryjs/server

Error sink for HTTP APIs: anything you `throw` becomes RFC 9457
`application/problem+json` with a real status code. Debug context routes
to your OTel span, never the wire. See the [contract](../../SPEC.md).

```bash
npm i @boundaryjs/server
```

## Throw

```ts
import { NotFound, ValidationFailed, RateLimited } from '@boundaryjs/server'

throw new NotFound('ORDER_NOT_FOUND', 'No such order.', {
  log: { shardKey, replicaLagMs: 240 },   // → span + log record. NEVER serialized.
})

throw new ValidationFailed(undefined, 'Order payload failed validation.', {
  errors: [{ field: 'qty', code: 'too_small', message: 'qty must be a positive integer.' }],
})

throw new RateLimited(undefined, 'Slow down.', { retryAfter: 30 })  // → Retry-After: 30
```

Every status has a class (`BadRequest`, `Unauthenticated`, `Forbidden`,
`NotFound`, `Conflict`, `ValidationFailed`, `RateLimited`, `Internal`,
`Unavailable`, …), each with a sensible default `code`, or use
`new ApiError(status, code, detail?, options?)` directly.

Options: `title`, `type`, `instance`, `errors`, `retryAfter`
(seconds or `Date` → `Retry-After` header), `headers`, `extensions`
(public, deliberate body members), `log` (debug context — span + log
record only), `cause`.

## Sink per framework

```ts
// Hono (and anything web-standard) — from the package root:
import { problemSink, problemNotFound } from '@boundaryjs/server'
app.onError(problemSink())
app.notFound(problemNotFound())

// Express 5 — after your routes:
import { problemSink, problemNotFound } from '@boundaryjs/server/express'
app.use(problemNotFound())
app.use(problemSink())
// Express 4 works too, with one caveat: Express 4 doesn't forward
// rejected async handlers to error middleware. Call next(err) yourself
// or use express-async-errors; Express 5 does it natively.

// Fastify:
import { problemSink, problemNotFound } from '@boundaryjs/server/fastify'
app.setErrorHandler(problemSink())
app.setNotFoundHandler(problemNotFound())

// Koa (2 and 3) — first, so it wraps everything downstream:
import { problemSink } from '@boundaryjs/server/koa'
app.use(problemSink())

// Nest — scope with Nest's own @Catch so pass-through is structural:
import { Catch } from '@nestjs/common'
import { ApiError, BoundaryProblemFilter } from '@boundaryjs/server/nest'
@Catch(ApiError)
class ProblemFilter extends BoundaryProblemFilter {}
app.useGlobalFilters(new ProblemFilter())
```

Nest's `@Catch` matches by `instanceof`, so keep a single installed copy
of `@boundaryjs/server` (`npm dedupe` if in doubt) — a duplicated copy's
`ApiError` would slip past the filter. Everywhere else, cross-copy
identity is handled for you via a shared `Symbol.for` marker.

All sinks accept the same options:

```ts
problemSink({
  typeBase: 'https://errors.acme.com/',   // type = typeBase + kebab-cased code
  logger: (event) => log.error(event),    // default: structured stderr line for 5xx / log context
  traceHeader: 'X-Trace-Id',              // rename if your infra already emits the trace id
})                                        // (tell boundary-conform via its traceHeader config)
```

The sink transforms **only** `ApiError`. Plain errors, framework
redirects, third-party throws — re-raised untouched. Installing it is a
no-op until a route opts in by throwing.

## Telemetry

On failure, the active span (if any) gets `boundary.error.code`,
`boundary.error.status`, one `boundary.log.*` attribute per `log` entry,
and — for 5xx — `recordException` + error status. The response's
`traceId` (body and `X-Trace-Id` header) is the active trace's id, or a
random one that also appears on the emitted log record when no OTel SDK
is registered. `@opentelemetry/api` no-ops without an SDK; nothing else
is required.
