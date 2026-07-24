import { isApiError, type ApiError } from "../error.js";
import { renderProblem, type SinkOptions } from "../render.js";

export type { SinkOptions } from "../render.js";

/**
 * Structural subset of Nest's ArgumentsHost — avoids a hard dependency on
 * @nestjs/common so this subpath is importable without it installed.
 */
interface ArgumentsHostish {
  switchToHttp(): { getResponse<T = unknown>(): T };
}

interface ExpressishResponse {
  status(code: number): unknown;
  setHeader(name: string, value: string): unknown;
  send(body: string): unknown;
}
interface FastifyishReply {
  status(code: number): FastifyishReply;
  header(name: string, value: string): FastifyishReply;
  send(body: string): unknown;
}

/**
 * NestJS exception filter for ApiError. Scoping to ApiError is done with
 * Nest's own @Catch decorator, which is what guarantees pass-through for
 * everything else:
 *
 *   import { Catch } from '@nestjs/common'
 *   import { ApiError, BoundaryProblemFilter } from '@boundaryjs/server/nest'
 *
 *   @Catch(ApiError)
 *   export class ProblemFilter extends BoundaryProblemFilter {}
 *
 *   app.useGlobalFilters(new ProblemFilter())
 *
 * Works with both the Express and Fastify adapters.
 */
export class BoundaryProblemFilter {
  constructor(private readonly options: SinkOptions = {}) {}

  catch(exception: unknown, host: ArgumentsHostish): void {
    if (!isApiError(exception)) throw exception;
    const { status, headers, body } = renderProblem(exception as ApiError, this.options);
    const res = host.switchToHttp().getResponse<ExpressishResponse | FastifyishReply>();

    if (typeof (res as ExpressishResponse).setHeader === "function") {
      const express = res as ExpressishResponse;
      express.status(status);
      for (const [name, value] of Object.entries(headers)) express.setHeader(name, value);
      express.send(body);
      return;
    }
    let reply = (res as FastifyishReply).status(status);
    for (const [name, value] of Object.entries(headers)) reply = reply.header(name, value);
    reply.send(body);
  }
}

export { ApiError } from "../error.js";
