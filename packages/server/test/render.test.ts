import { describe, expect, it, vi } from "vitest";
import { context, ROOT_CONTEXT, trace, type Context, type ContextManager, type Span } from "@opentelemetry/api";
import { Internal, NotFound, RateLimited, renderProblem, ValidationFailed } from "@boundaryjs/server";

const silent = { logger: () => {} };

describe("renderProblem", () => {
  it("emits an RFC 9457 body with code and traceId", () => {
    const { status, headers, problem, body } = renderProblem(
      new NotFound("ORDER_NOT_FOUND", "No such order."),
      silent,
    );
    expect(status).toBe(404);
    expect(headers["Content-Type"]).toBe("application/problem+json");
    expect(problem).toMatchObject({
      type: "about:blank",
      title: "Order not found",
      status: 404,
      code: "ORDER_NOT_FOUND",
      detail: "No such order.",
    });
    expect(problem.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(headers["X-Trace-Id"]).toBe(problem.traceId);
    expect(JSON.parse(body)).toEqual(problem);
  });

  it("NEVER serializes log context, cause, or stack", () => {
    const err = new Internal("INTERNAL", "Something went wrong on our side.", {
      log: { query: "SELECT * FROM users WHERE id = $1", host: "db-3.internal" },
      cause: new TypeError("Cannot read properties of undefined"),
    });
    const { body } = renderProblem(err, silent);
    expect(body).not.toContain("SELECT");
    expect(body).not.toContain("internal.");
    expect(body).not.toContain("db-3");
    expect(body).not.toContain("TypeError");
    expect(body).not.toContain("at ");
    expect(JSON.parse(body)).not.toHaveProperty("log");
  });

  it("builds type from typeBase + kebab-cased code", () => {
    const { problem } = renderProblem(new NotFound("ORDER_NOT_FOUND"), {
      ...silent,
      typeBase: "https://errors.acme.com/",
    });
    expect(problem.type).toBe("https://errors.acme.com/order-not-found");
  });

  it("emits Retry-After from seconds and from a Date", () => {
    const seconds = renderProblem(new RateLimited(undefined, undefined, { retryAfter: 30 }), silent);
    expect(seconds.headers["Retry-After"]).toBe("30");

    const when = new Date(Date.now() + 60_000);
    const dated = renderProblem(new RateLimited(undefined, undefined, { retryAfter: when }), silent);
    expect(dated.headers["Retry-After"]).toBe(when.toUTCString());
  });

  it("carries field errors and public extensions, but extensions cannot clobber core members", () => {
    const { problem } = renderProblem(
      new ValidationFailed(undefined, "Payload failed validation.", {
        errors: [{ field: "qty", code: "too_small", message: "qty must be positive." }],
        extensions: { balance: 30, code: "SPOOFED" as never },
      }),
      silent,
    );
    expect(problem.errors).toEqual([{ field: "qty", code: "too_small", message: "qty must be positive." }]);
    expect(problem.balance).toBe(30);
    expect(problem.code).toBe("VALIDATION_FAILED");
  });

  it("emits the trace id under a configured traceHeader", () => {
    const { headers, problem } = renderProblem(new NotFound(), {
      ...silent,
      traceHeader: "X-Request-Id",
    });
    expect(headers["X-Request-Id"]).toBe(problem.traceId);
    expect(headers["X-Trace-Id"]).toBeUndefined();
  });

  it("invokes the logger with debug context off the wire", () => {
    const logger = vi.fn();
    renderProblem(new NotFound("X", "y", { log: { a: 1 } }), { logger });
    expect(logger).toHaveBeenCalledOnce();
    const event = logger.mock.calls[0]![0]!;
    expect(event.code).toBe("X");
    expect(event.log).toEqual({ a: 1 });
    expect(event.traceId).toMatch(/^[0-9a-f]{32}$/);
  });
});

/** Minimal synchronous ContextManager so getActiveSpan() works in tests. */
class SimpleContextManager implements ContextManager {
  private stack: Context[] = [];
  active(): Context {
    return this.stack[this.stack.length - 1] ?? ROOT_CONTEXT;
  }
  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    ctx: Context,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    this.stack.push(ctx);
    try {
      return fn.call(thisArg, ...args);
    } finally {
      this.stack.pop();
    }
  }
  bind<T>(_ctx: Context, target: T): T {
    return target;
  }
  enable(): this {
    return this;
  }
  disable(): this {
    this.stack = [];
    return this;
  }
}

describe("OTel span routing", () => {
  it("uses the active span's traceId and records code, status, and log attributes", () => {
    const attributes: Record<string, unknown> = {};
    const exceptions: unknown[] = [];
    const fakeSpan = {
      spanContext: () => ({ traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba902b7", traceFlags: 1 }),
      setAttribute(key: string, value: unknown) {
        attributes[key] = value;
        return this;
      },
      setAttributes() {
        return this;
      },
      recordException(err: unknown) {
        exceptions.push(err);
      },
      setStatus() {
        return this;
      },
      addEvent() {
        return this;
      },
      addLink() {
        return this;
      },
      addLinks() {
        return this;
      },
      updateName() {
        return this;
      },
      end() {},
      isRecording: () => true,
    } as unknown as Span;

    const manager = new SimpleContextManager();
    expect(context.setGlobalContextManager(manager)).toBe(true);
    try {
      const ctx = trace.setSpan(context.active(), fakeSpan);
      const rendered = manager.with(ctx, () =>
        renderProblem(
          new Internal("INTERNAL", "boom", { log: { replicaLagMs: 240, meta: { a: 1 } } }),
          silent,
        ),
      );
      expect(rendered.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
      expect(rendered.problem.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
      expect(attributes["boundary.error.code"]).toBe("INTERNAL");
      expect(attributes["boundary.error.status"]).toBe(500);
      expect(attributes["boundary.log.replicaLagMs"]).toBe(240);
      expect(attributes["boundary.log.meta"]).toBe('{"a":1}');
      expect(exceptions).toHaveLength(1);
    } finally {
      context.disable();
    }
  });
});
