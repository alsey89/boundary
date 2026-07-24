import { isApiError, NotFound } from "../error.js";
import { renderProblem, type SinkOptions } from "../render.js";

export type { SinkOptions } from "../render.js";

/** Structural subset of Fastify's Reply — avoids a hard type dependency. */
interface FastifyishReply {
  status(code: number): FastifyishReply;
  header(name: string, value: string): FastifyishReply;
  send(body: string): unknown;
}

/**
 * Fastify error handler:
 *
 *   app.setErrorHandler(problemSink())
 *
 * Transforms only ApiError. Anything else is re-thrown, which hands it to
 * Fastify's default error handler untouched.
 */
export function problemSink(options: SinkOptions = {}) {
  return function boundaryProblemSink(
    error: unknown,
    _request: unknown,
    reply: FastifyishReply,
  ): void {
    if (!isApiError(error)) throw error;
    const { status, headers, body } = renderProblem(error, options);
    let r = reply.status(status);
    for (const [name, value] of Object.entries(headers)) r = r.header(name, value);
    r.send(body);
  };
}

/**
 * Not-found handler so unmatched routes speak the contract:
 *
 *   app.setNotFoundHandler(problemNotFound())
 */
export function problemNotFound(
  options: SinkOptions & { code?: string; detail?: string } = {},
) {
  const { code = "NOT_FOUND", detail = "The requested resource does not exist.", ...sink } = options;
  return function boundaryProblemNotFound(_request: unknown, reply: FastifyishReply): void {
    const { status, headers, body } = renderProblem(new NotFound(code, detail), sink);
    let r = reply.status(status);
    for (const [name, value] of Object.entries(headers)) r = r.header(name, value);
    r.send(body);
  };
}
