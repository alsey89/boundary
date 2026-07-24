import { describe, expect, it } from "vitest";
import { NotFound } from "@boundaryjs/server";
import { BoundaryProblemFilter } from "@boundaryjs/server/nest";

const silent = { logger: () => {} };

function expressHost() {
  const headers: Record<string, string> = {};
  const state = { status: 0, body: "" };
  const res = {
    status(code: number) {
      state.status = code;
      return res;
    },
    setHeader(name: string, value: string) {
      headers[name] = value;
      return res;
    },
    send(body: string) {
      state.body = body;
      return res;
    },
  };
  return {
    host: { switchToHttp: () => ({ getResponse: <T>() => res as T }) },
    headers,
    state,
  };
}

function fastifyHost() {
  const headers: Record<string, string> = {};
  const state = { status: 0, body: "" };
  const reply = {
    status(code: number) {
      state.status = code;
      return reply;
    },
    header(name: string, value: string) {
      headers[name] = value;
      return reply;
    },
    send(body: string) {
      state.body = body;
    },
  };
  return {
    host: { switchToHttp: () => ({ getResponse: <T>() => reply as T }) },
    headers,
    state,
  };
}

describe("nest filter", () => {
  it("renders problem+json through the Express adapter", () => {
    const { host, headers, state } = expressHost();
    new BoundaryProblemFilter(silent).catch(new NotFound("ORDER_NOT_FOUND", "No such order."), host);
    expect(state.status).toBe(404);
    expect(headers["Content-Type"]).toBe("application/problem+json");
    const body = JSON.parse(state.body);
    expect(body.code).toBe("ORDER_NOT_FOUND");
    expect(headers["X-Trace-Id"]).toBe(body.traceId);
  });

  it("renders problem+json through the Fastify adapter", () => {
    const { host, headers, state } = fastifyHost();
    new BoundaryProblemFilter(silent).catch(new NotFound(), host);
    expect(state.status).toBe(404);
    expect(headers["Content-Type"]).toBe("application/problem+json");
    expect(JSON.parse(state.body).code).toBe("NOT_FOUND");
  });

  it("re-throws non-ApiError (pass-through; @Catch(ApiError) scopes it in Nest)", () => {
    const { host } = expressHost();
    const err = new Error("not an ApiError");
    expect(() => new BoundaryProblemFilter(silent).catch(err, host)).toThrow(err);
  });
});
