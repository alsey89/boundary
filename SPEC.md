# The Boundary error contract

Version 0.1 — this document is the normative spec that `boundary-conform`
enforces. The wire format is RFC 9457 (`application/problem+json`),
unextended except for two members: `code` and `traceId`.

The key words MUST, MUST NOT, SHOULD, and MAY are to be interpreted as
described in RFC 2119.

## 1. Status codes

1. Every error response MUST carry a real HTTP status code: 4xx when the
   client erred, 5xx when the server did.
2. The `status` member of the body MUST equal the HTTP status line.
3. `429` and `503` responses MUST carry a `Retry-After` header, either
   delta-seconds or an HTTP-date.

## 2. Body

Error responses MUST have `Content-Type: application/problem+json`
(parameters such as `charset` MAY be appended) and a JSON object body with
these members:

| Member | Required | Meaning |
|---|---|---|
| `type` | yes | URI reference for the problem type. `about:blank` when there is no documentation URL. Clients MUST NOT branch on it — it is allowed to move. |
| `title` | yes | Short human-readable summary. Prose; MAY be reworded at any time. |
| `status` | yes | The HTTP status code, duplicated per RFC 9457. |
| `code` | yes | Stable machine-readable error code. **The only member clients may branch on.** |
| `detail` | no | Human-readable explanation of this occurrence. Prose; MAY be reworded. |
| `instance` | no | URI reference for this occurrence. |
| `traceId` | yes | Correlates the response with server-side telemetry. See §4. |
| `errors` | 422 only | Field-level failures; see §5. |

Additional members MAY appear only as deliberate, documented public
extensions. They MUST NOT carry debug data.

## 3. `code`

1. `code` MUST match `^[A-Z][A-Z0-9_]*$` (SCREAMING_SNAKE).
2. `code` MUST be stable: the same failure mode on the same endpoint MUST
   produce the same `code`, across requests, deploys, and versions.
3. A `code` MUST NOT be renamed or reused with a different meaning.
   Deprecate and add a new one instead.

## 4. `traceId`

1. Every problem response MUST carry the trace id both in the body
   (`traceId`) and in a response header, and the two MUST match. The
   header SHOULD be `X-Trace-Id`; a deployment already emitting the trace
   id under another name MAY use that header instead, and MUST then point
   `boundary-conform` at it via its `traceHeader` configuration.
2. When the server participates in distributed tracing, the value MUST be
   the active trace's id (W3C trace-context format). Otherwise it MUST be
   a freshly generated random id that also appears on the corresponding
   server-side log record.

## 5. Validation failures

A request rejected for payload validation MUST return `422` with a
non-empty `errors` array. Each entry MUST carry string members `field`
and `message`, and MAY carry a machine-readable `code`.

## 6. What MUST NOT cross the wire

Error bodies MUST NOT contain, under any configuration or environment
(there is no "dev mode" exemption):

- stack traces or source file paths
- SQL or database error strings
- internal hostnames or private IP addresses
- environment variable names or values
- exception class names or messages from underlying runtimes

Debug context belongs on the trace identified by `traceId`, never in the
response.

## 7. Pass-through

The error sink transforms only errors that opt into this contract
(`ApiError`). Everything else — framework redirects, framework error
pages, third-party throws — MUST pass through untouched. In particular, a
framework redirect MUST reach the client as its original 3xx with its
`Location` header, not as a problem document.

## 8. Conformance

`boundary-conform` verifies, black-box over HTTP: the 404 shape and
stability of `code` (§2, §3), trace correlation (§4), the 422 `errors`
shape (§5), the leak rules (§6), `Retry-After` on 429/503 (§1), and
redirect pass-through (§7). Anything it cannot provoke without knowledge
of your API (validation, rate limits, redirects) is driven by probe
configuration; unconfigured probes are reported as skipped, not passed.
