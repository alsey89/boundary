import type { ApiError } from "./error.js";
import { kebabCode, PROBLEM_CONTENT_TYPE, TRACE_HEADER, type Problem } from "./problem.js";
import { recordToSpan } from "./trace.js";

/** Structured event handed to the sink's logger for every ApiError caught. */
export interface ApiErrorLogEvent {
  code: string;
  status: number;
  traceId: string;
  title: string;
  detail?: string;
  /** The debug context from the throw site. Present here, never on the wire. */
  log?: Record<string, unknown>;
  error: ApiError;
}

export interface SinkOptions {
  /**
   * Base URL for problem `type` URIs, e.g. "https://errors.acme.com/".
   * `type` becomes `typeBase` + kebab-cased code. Without it, `type` is
   * "about:blank" per RFC 9457 — clients must branch on `code` either way.
   */
  typeBase?: string;
  /**
   * Receives every ApiError the sink transforms. Default logs a structured
   * line to stderr for 5xx or when debug context is present. Pass your own
   * to route into pino/winston/etc., or `() => {}` to disable.
   */
  logger?: (event: ApiErrorLogEvent) => void;
  /**
   * Response header carrying the trace id. Default "X-Trace-Id". If your
   * infrastructure already emits the trace id under another name, set it
   * here — and tell boundary-conform via its `traceHeader` config so the
   * correlation check looks at the right header.
   */
  traceHeader?: string;
}

export interface RenderedProblem {
  status: number;
  /** Includes Content-Type, X-Trace-Id, Retry-After (if set), custom headers. */
  headers: Record<string, string>;
  /** The serialized problem+json body. */
  body: string;
  problem: Problem;
  traceId: string;
}

function defaultLogger(event: ApiErrorLogEvent): void {
  if (event.status < 500 && !event.log) return;
  const line: Record<string, unknown> = {
    level: event.status >= 500 ? "error" : "warn",
    msg: "api_error",
    code: event.code,
    status: event.status,
    traceId: event.traceId,
  };
  if (event.detail) line.detail = event.detail;
  if (event.log) line.context = event.log;
  if (event.status >= 500 && event.error.cause instanceof Error) {
    line.cause = event.error.cause.stack ?? event.error.cause.message;
  }
  console.error(JSON.stringify(line));
}

/**
 * Turn an ApiError into wire-ready status/headers/body, routing debug
 * context to the active OTel span and the logger on the way. This is the
 * single choke point every sink goes through: `log` and `cause` are read
 * here for telemetry and are structurally absent from the body.
 */
export function renderProblem(error: ApiError, options: SinkOptions = {}): RenderedProblem {
  const traceId = recordToSpan(error);

  const problem: Problem = {
    type:
      error.type ??
      (options.typeBase !== undefined
        ? options.typeBase + kebabCode(error.code)
        : "about:blank"),
    title: error.title,
    status: error.status,
    code: error.code,
  };
  if (error.detail !== undefined) problem.detail = error.detail;
  if (error.instance !== undefined) problem.instance = error.instance;
  problem.traceId = traceId;
  if (error.errors !== undefined) problem.errors = error.errors;
  if (error.extensions) {
    for (const [key, value] of Object.entries(error.extensions)) {
      if (!(key in problem)) problem[key] = value;
    }
  }

  const headers: Record<string, string> = {
    "Content-Type": PROBLEM_CONTENT_TYPE,
    [options.traceHeader ?? TRACE_HEADER]: traceId,
  };
  if (error.retryAfter !== undefined) {
    headers["Retry-After"] =
      error.retryAfter instanceof Date
        ? error.retryAfter.toUTCString()
        : String(Math.max(0, Math.ceil(error.retryAfter)));
  }
  if (error.headers) Object.assign(headers, error.headers);

  (options.logger ?? defaultLogger)({
    code: error.code,
    status: error.status,
    traceId,
    title: error.title,
    detail: error.detail,
    log: error.log,
    error,
  });

  return { status: error.status, headers, body: JSON.stringify(problem), problem, traceId };
}
