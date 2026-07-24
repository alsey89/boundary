# @boundaryjs/client

Fetch wrapper for RFC 9457 APIs. Errors throw — that's what integrates
with the ecosystem (React Query retries, error boundaries catch, and an
unhandled failure is loud instead of `undefined`). Failure policy is set
per call site, defaulted per code.

```bash
npm i @boundaryjs/client
```

```ts
import { createClient } from '@boundaryjs/client'

export const api = createClient({
  baseUrl: '/api',
  policy: {
    UNAUTHENTICATED: 'reauthenticate',
    RATE_LIMITED:    'retry',
    VALIDATION_FAILED: 'silent',
    '*':             'report',
  },
  onReport: (e) => toast.error(e.title ?? 'Something went wrong'),
  onReauthenticate: () => { session.clear(); location.assign('/login') },
})

const order = await api.get<Order>('/orders/ord_1001')
await api.post('/orders', { sku: 'widget', qty: 2 })
```

## Policies

| Policy | Behavior |
|---|---|
| `silent` | Rethrow only. The call site handles it (e.g. the form renders it). |
| `report` | `onReport` (toast + telemetry), then rethrow. The default. |
| `retry` | Honors `Retry-After`, else capped exponential backoff; report + rethrow when exhausted. Only replays idempotent methods (GET, HEAD, PUT, DELETE) — a POST may have reached the server even when the response didn't, so replaying it can double-submit. Mark a call safe with `{ idempotent: true }` (e.g. it carries an `Idempotency-Key`). |
| `reauthenticate` | `onReauthenticate` (clear session, redirect), then stays pending for a grace period (`reauthenticateGraceMs`, default 10s) so no error UI flashes while the page navigates away — and rejects afterwards, so tests, SSR, and failed redirects don't hang forever. |

Resolution order: per-call `policy[code]` → per-call `'*'` → client
`policy[code]` → client `'*'` → `report`.

```ts
// A 401 on a background poll shouldn't yank the user out of their work:
api.get('/notifications', { policy: { UNAUTHENTICATED: 'silent' } })
```

## The thrown error

`ApiError` carries `code` (branch on this — `HTTP_<status>` when the
server didn't speak problem+json, `NETWORK_ERROR` when the request never
completed), `status`, `title`, `detail`, `traceId`, `errors[]`,
`problem` (raw body), `retryAfterMs`, and `response`. Guard with
`isApiError(e)`.

## Expected failures

```ts
const res = await api.get<User>('/users/123').safe()
if (!res.ok && res.error.code === 'USER_NOT_FOUND') return null
```

`.safe()` converts the final `ApiError` into a Result; policies still run
first, and non-API errors (programmer errors) still throw.

Request options: `query`, `headers`, `signal`, `policy`, `idempotent`.
Client options: `baseUrl`, `policy`, `onReport`, `onReauthenticate`,
`reauthenticateGraceMs`, `retry { attempts, baseDelayMs, maxDelayMs }`,
`headers` (static or per-request factory), `fetch`.
