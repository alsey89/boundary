export {
  ApiError,
  isApiError,
  API_ERROR_MARKER,
  BadRequest,
  Unauthenticated,
  PaymentRequired,
  Forbidden,
  NotFound,
  MethodNotAllowed,
  Conflict,
  Gone,
  PayloadTooLarge,
  ValidationFailed,
  RateLimited,
  Internal,
  NotImplemented,
  BadGateway,
  Unavailable,
  GatewayTimeout,
  type ApiErrorOptions,
} from "./error.js";

export {
  humanizeCode,
  kebabCode,
  PROBLEM_CONTENT_TYPE,
  TRACE_HEADER,
  type FieldError,
  type JsonValue,
  type Problem,
} from "./problem.js";

export {
  renderProblem,
  type ApiErrorLogEvent,
  type RenderedProblem,
  type SinkOptions,
} from "./render.js";

export { randomTraceId } from "./trace.js";

// The web-standard sink (Hono, Bun, Deno, anything on fetch primitives)
// is the default export surface — the README's `app.onError(problemSink())`
// works from the package root. Framework-specific sinks live at
// @boundaryjs/server/{express,fastify,koa,nest}.
export { problemSink, problemNotFound } from "./sinks/web.js";
