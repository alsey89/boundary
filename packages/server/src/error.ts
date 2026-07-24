import type { FieldError, JsonValue } from "./problem.js";
import { humanizeCode } from "./problem.js";

/**
 * Cross-realm / cross-copy marker. A bundler that duplicates this package
 * must not break `isApiError`, so identity is a well-known symbol, not
 * `instanceof` alone.
 */
export const API_ERROR_MARKER = Symbol.for("boundary.ApiError");

export interface ApiErrorOptions {
  /** Short human-readable summary. Defaults to a humanized `code`. */
  title?: string;
  /** Override the problem `type` URI for this error only. */
  type?: string;
  /** URI reference for this specific occurrence. */
  instance?: string;
  /** Field-level validation failures, serialized as `errors[]`. */
  errors?: FieldError[];
  /**
   * Retry hint. Number of seconds, or an absolute Date. Emitted as a
   * `Retry-After` response header — never in the body.
   */
  retryAfter?: number | Date;
  /** Extra response headers to set alongside the problem body. */
  headers?: Record<string, string>;
  /**
   * Debug context. Routed to the active OTel span and the log record.
   * NEVER serialized into the response — there is no flag, env var, or
   * code path that puts this on the wire.
   */
  log?: Record<string, unknown>;
  /**
   * Author-declared public extension members, merged into the problem
   * body. Explicit opt-in for data you WANT clients to see.
   */
  extensions?: Record<string, JsonValue>;
  /** Standard Error cause. Kept server-side, never serialized. */
  cause?: unknown;
}

/**
 * The one error the sink transforms. Everything else passes through
 * untouched — that's what makes route-by-route adoption real.
 */
export class ApiError extends Error {
  readonly [API_ERROR_MARKER] = true;

  readonly status: number;
  readonly code: string;
  readonly title: string;
  readonly detail?: string;
  readonly type?: string;
  readonly instance?: string;
  readonly errors?: FieldError[];
  readonly retryAfter?: number | Date;
  readonly headers?: Record<string, string>;
  readonly log?: Record<string, unknown>;
  readonly extensions?: Record<string, JsonValue>;

  constructor(status: number, code: string, detail?: string, options: ApiErrorOptions = {}) {
    super(detail ?? humanizeCode(code), options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.status = status;
    this.code = code;
    this.title = options.title ?? humanizeCode(code);
    this.detail = detail;
    this.type = options.type;
    this.instance = options.instance;
    this.errors = options.errors;
    this.retryAfter = options.retryAfter;
    this.headers = options.headers;
    this.log = options.log;
    this.extensions = options.extensions;
  }
}

/**
 * True for any ApiError, including one constructed by a duplicate copy of
 * this package in the same process.
 */
export function isApiError(value: unknown): value is ApiError {
  if (value instanceof ApiError) return true;
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[API_ERROR_MARKER] === true
  );
}

type SubclassArgs = [code?: string, detail?: string, options?: ApiErrorOptions];

function subclass(status: number, defaultCode: string) {
  return class extends ApiError {
    constructor(...[code = defaultCode, detail, options]: SubclassArgs) {
      super(status, code, detail, options);
    }
  };
}

export class BadRequest extends subclass(400, "BAD_REQUEST") {}
export class Unauthenticated extends subclass(401, "UNAUTHENTICATED") {}
export class PaymentRequired extends subclass(402, "PAYMENT_REQUIRED") {}
export class Forbidden extends subclass(403, "FORBIDDEN") {}
export class NotFound extends subclass(404, "NOT_FOUND") {}
export class MethodNotAllowed extends subclass(405, "METHOD_NOT_ALLOWED") {}
export class Conflict extends subclass(409, "CONFLICT") {}
export class Gone extends subclass(410, "GONE") {}
export class PayloadTooLarge extends subclass(413, "PAYLOAD_TOO_LARGE") {}
export class ValidationFailed extends subclass(422, "VALIDATION_FAILED") {}
export class RateLimited extends subclass(429, "RATE_LIMITED") {}
export class Internal extends subclass(500, "INTERNAL") {}
export class NotImplemented extends subclass(501, "NOT_IMPLEMENTED") {}
export class BadGateway extends subclass(502, "BAD_GATEWAY") {}
export class Unavailable extends subclass(503, "UNAVAILABLE") {}
export class GatewayTimeout extends subclass(504, "GATEWAY_TIMEOUT") {}
