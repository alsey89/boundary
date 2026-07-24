import { isApiError, NotFound } from "../error.js";
import { renderProblem, type SinkOptions } from "../render.js";

export type { SinkOptions } from "../render.js";

/** Structural subset of Express's Response — avoids a hard type dependency. */
interface ExpressishResponse {
  status(code: number): unknown;
  setHeader(name: string, value: string): unknown;
  send(body: string): unknown;
  headersSent?: boolean;
}
type Next = (error?: unknown) => void;

/**
 * Express 5 error-handling middleware. Register after your routes:
 *
 *   app.use(problemSink())
 *
 * Transforms only ApiError; anything else is forwarded to the next error
 * handler untouched via `next(err)`.
 */
export function problemSink(options: SinkOptions = {}) {
  return function boundaryProblemSink(
    error: unknown,
    _req: unknown,
    res: ExpressishResponse,
    next: Next,
  ): void {
    if (!isApiError(error) || res.headersSent) {
      next(error);
      return;
    }
    const { status, headers, body } = renderProblem(error, options);
    res.status(status);
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
    res.send(body);
  };
}

/**
 * Terminal middleware for unmatched routes, so 404s speak the contract.
 * Register after all routes, before the error sink:
 *
 *   app.use(problemNotFound())
 */
export function problemNotFound(
  options: SinkOptions & { code?: string; detail?: string } = {},
) {
  const { code = "NOT_FOUND", detail = "The requested resource does not exist.", ...sink } = options;
  return function boundaryProblemNotFound(_req: unknown, res: ExpressishResponse): void {
    const { status, headers, body } = renderProblem(new NotFound(code, detail), sink);
    res.status(status);
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
    res.send(body);
  };
}
