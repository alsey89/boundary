import { isApiError } from "../error.js";
import { renderProblem, type SinkOptions } from "../render.js";

export type { SinkOptions } from "../render.js";

/** Structural subset of Koa's Context — avoids a hard type dependency. */
interface KoaishContext {
  status: number;
  body: unknown;
  set(name: string, value: string): void;
}
type KoaNext = () => Promise<unknown>;

/**
 * Koa middleware. Register FIRST so it wraps everything downstream:
 *
 *   app.use(problemSink())
 *
 * Transforms only ApiError; anything else is re-thrown for Koa's own
 * error handling (`ctx.onerror`, `app.on('error')`) untouched.
 */
export function problemSink(options: SinkOptions = {}) {
  return async function boundaryProblemSink(ctx: KoaishContext, next: KoaNext): Promise<void> {
    try {
      await next();
    } catch (error) {
      if (!isApiError(error)) throw error;
      const { status, headers, body } = renderProblem(error, options);
      ctx.status = status;
      for (const [name, value] of Object.entries(headers)) ctx.set(name, value);
      ctx.body = body;
    }
  };
}
