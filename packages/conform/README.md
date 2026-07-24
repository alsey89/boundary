# boundary-conform

A spec nobody enforces is a document. `boundary-conform` runs black-box
against a live server and proves it honors the
[Boundary error contract](../../SPEC.md) — any backend, any language. It
only speaks HTTP.

```bash
npx boundary-conform http://localhost:3000
# ✓ 404 emits application/problem+json with a stable code
# ✓ 422 carries field-level errors[]
# ✓ no stack trace, SQL, or hostname in any error body — any NODE_ENV
# ✓ Retry-After present on 429 and 503
# ✓ framework redirect() passes through untouched
# ✓ traceId in header and body match
```

Exit code 0 when every non-skipped check passes; 1 otherwise. Put it in
CI for your Go and Python services too.

## Probes

The 404, trace, and leak checks run with no configuration. Checks that
need a route on *your* API are driven by probes, from
`boundary-conform.json` (or `--config <path>`):

```json
{
  "probes": {
    "validation":  { "method": "POST", "path": "/orders", "body": {} },
    "rateLimited": { "path": "/rate-limited" },
    "unavailable": { "path": "/unavailable" },
    "redirect":    { "path": "/old-path" },
    "errors":      [{ "path": "/boom" }]
  },
  "leakAllow": ["docs\\.internal"]
}
```

`probes.errors` lists extra error-producing requests to include in the
trace and leak scans. Unconfigured probes are reported as **skipped, not
passed**.

Options: `--reporter pretty|json`, `--help`.

## As a library

```ts
import { runConformance } from 'boundary-conform'

const report = await runConformance('http://localhost:3000', config)
if (!report.ok) process.exit(1)
```
