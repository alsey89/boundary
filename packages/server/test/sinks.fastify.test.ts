import { afterAll, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { NotFound } from "@boundaryjs/server";
import { problemNotFound, problemSink } from "@boundaryjs/server/fastify";

const silent = { logger: () => {} };

const app = Fastify({ logger: false });
app.setErrorHandler(problemSink(silent));
app.setNotFoundHandler(problemNotFound(silent));
app.get("/orders/:id", async () => {
  throw new NotFound("ORDER_NOT_FOUND", "No such order.", { log: { shardKey: "orders-7" } });
});
app.get("/plain-throw", async () => {
  throw new Error("not an ApiError");
});

afterAll(() => app.close());

describe("fastify sink", () => {
  it("transforms a thrown ApiError into problem+json", async () => {
    const res = await app.inject({ method: "GET", url: "/orders/missing" });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toContain("application/problem+json");
    const body = res.json();
    expect(body.code).toBe("ORDER_NOT_FOUND");
    expect(res.headers["x-trace-id"]).toBe(body.traceId);
    expect(res.payload).not.toContain("shardKey");
  });

  it("re-throws non-ApiError to Fastify's default handler (pass-through)", async () => {
    const res = await app.inject({ method: "GET", url: "/plain-throw" });
    expect(res.statusCode).toBe(500);
    expect(res.headers["content-type"]).not.toBe("application/problem+json");
  });

  it("problemNotFound covers unmatched routes", async () => {
    const res = await app.inject({ method: "GET", url: "/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("NOT_FOUND");
  });
});
