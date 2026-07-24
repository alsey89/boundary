import { isApiError, NotFound } from "../error.js";
import { renderProblem, type SinkOptions } from "../render.js";

export type { SinkOptions } from "../render.js";

/**
 * Web-standard error sink for frameworks whose error handlers return a
 * `Response` — Hono, and anything else running on fetch primitives.
 *
 *   app.onError(problemSink())
 *
 * Transforms only ApiError. Everything else — framework exceptions,
 * redirects, third-party throws — is re-raised untouched, so installing
 * the sink is a no-op until a route opts in by throwing.
 */
export function problemSink(options: SinkOptions = {}): (error: Error, context?: unknown) => Response {
  return function boundaryProblemSink(error: Error): Response {
    if (!isApiError(error)) throw error;
    const { status, headers, body } = renderProblem(error, options);
    return new Response(body, { status, headers });
  };
}

/**
 * Optional 404 handler so unmatched routes speak the same contract:
 *
 *   app.notFound(problemNotFound())
 */
export function problemNotFound(
  options: SinkOptions & { code?: string; detail?: string } = {},
): () => Response {
  const { code = "NOT_FOUND", detail = "The requested resource does not exist.", ...sink } = options;
  return function boundaryProblemNotFound(): Response {
    const { status, headers, body } = renderProblem(new NotFound(code, detail), sink);
    return new Response(body, { status, headers });
  };
}
