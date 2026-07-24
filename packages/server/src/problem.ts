/**
 * The wire format: RFC 9457 problem details, extended with exactly two
 * members — `code` (the only field clients may branch on) and `traceId`
 * (correlates the response with the OTel trace that carries debug context).
 */

/** JSON-serializable value. Everything that crosses the wire must be one. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** One field-level validation failure, carried on 4xx validation problems. */
export interface FieldError {
  /** JSON-pointer-ish path to the offending field, e.g. "items[0].qty". */
  field: string;
  /** Optional machine-readable reason, e.g. "too_small". */
  code?: string;
  /** Human-readable message for that field. */
  message: string;
}

/** An RFC 9457 problem details body, as Boundary emits it. */
export interface Problem {
  /** URI reference identifying the problem type. Dereferenceable docs URL when `typeBase` is configured, else "about:blank". */
  type: string;
  /** Short human-readable summary. Prose — may be reworded at any time. */
  title: string;
  /** HTTP status code, duplicated in the body per RFC 9457. */
  status: number;
  /** Stable machine-readable error code. The contract clients branch on. */
  code: string;
  /** Human-readable explanation specific to this occurrence. Prose. */
  detail?: string;
  /** URI reference for this specific occurrence. */
  instance?: string;
  /** W3C trace id correlating this response with server-side telemetry. */
  traceId?: string;
  /** Field-level validation failures. */
  errors?: FieldError[];
  /** Author-declared public extensions. Explicit opt-in, never debug data. */
  [extension: string]: JsonValue | FieldError[] | undefined;
}

export const PROBLEM_CONTENT_TYPE = "application/problem+json";
export const TRACE_HEADER = "X-Trace-Id";

/** "ORDER_NOT_FOUND" -> "Order not found" */
export function humanizeCode(code: string): string {
  const words = code.toLowerCase().split(/[_\s-]+/).filter(Boolean);
  if (words.length === 0) return "Error";
  const first = words[0]!;
  return [first.charAt(0).toUpperCase() + first.slice(1), ...words.slice(1)].join(" ");
}

/** "ORDER_NOT_FOUND" -> "order-not-found" */
export function kebabCode(code: string): string {
  return code.toLowerCase().split(/[_\s]+/).filter(Boolean).join("-");
}
