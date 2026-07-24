# @boundaryjs/next

Next.js App Router has no error sink — middleware runs before routing and
can't catch a throw. This package wraps your exported route handlers at
build time (the same technique Sentry's SDK uses), so you write plain
handlers and the [contract](../../SPEC.md) holds anyway.

```bash
npm i @boundaryjs/next @boundaryjs/server
```

```js
// next.config.mjs
import { withBoundary } from '@boundaryjs/next'

export default withBoundary({ /* your config */ }, {
  typeBase: 'https://errors.acme.com/',
})
```

```ts
// app/api/orders/[id]/route.ts — no wrapper code, no ceremony
import { NotFound } from '@boundaryjs/server'

export async function GET(req: Request, { params }) {
  const order = await db.find(params.id)
  if (!order) throw new NotFound('ORDER_NOT_FOUND', 'No such order.')
  return Response.json(order)
}
```

Next's own `redirect()` / `notFound()` control-flow throws are re-raised
untouched — only `ApiError` is transformed.

## How it works

A build-time loader replaces each `app/**/route.{ts,js}` with a thin
proxy that imports the original module, re-exports everything (`dynamic`,
`revalidate`, … pass through), and shadows the HTTP-method exports with
wrapped versions. The original file is untouched on disk.

`withBoundary` registers the loader for **both bundlers** — a webpack
rule and a `turbopack.rules` entry — so it works under `next build` and
`next build --turbopack` alike (verified against Next 16).

## Manual wrapping

If you prefer the wrapping explicit, use the same runtime the transform
uses:

```ts
import { wrapRouteHandler } from '@boundaryjs/next'

export const GET = wrapRouteHandler(async () => { /* ... */ })
```

A custom `logger` can't be serialized into build output; set one at
runtime, once, from `instrumentation.ts`:

```ts
import { configureBoundary } from '@boundaryjs/next'
configureBoundary({ typeBase: 'https://errors.acme.com/', logger: myLogger })
```
