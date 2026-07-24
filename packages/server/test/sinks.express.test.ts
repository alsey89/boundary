import { afterAll, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { NotFound, RateLimited } from "@boundaryjs/server";
import { problemNotFound, problemSink } from "@boundaryjs/server/express";

const silent = { logger: () => {} };

const app = express();
app.get("/orders/:id", (req) => {
  throw new NotFound("ORDER_NOT_FOUND", `No order ${req.params.id}.`, {
    log: { replicaLagMs: 240 },
  });
});
app.get("/limited", () => {
  throw new RateLimited(undefined, "Slow down.", { retryAfter: 30 });
});
app.get("/redirect", (_req, res) => {
  res.redirect(302, "/orders/x");
});
app.get("/plain-throw", () => {
  throw new Error("not an ApiError");
});
app.use(problemNotFound(silent));
app.use(problemSink({ ...silent, typeBase: "https://errors.acme.com/" }));

const servers: Server[] = [];
function listen(): Promise<string> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      servers.push(server);
      const address = server.address();
      resolve(`http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`);
    });
  });
}
afterAll(() => {
  for (const server of servers) server.close();
});

describe("express 5 sink", () => {
  it("transforms a thrown ApiError, including from async-throwing routes", async () => {
    const base = await listen();
    const res = await fetch(`${base}/orders/missing`);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    const body = await res.json();
    expect(body.code).toBe("ORDER_NOT_FOUND");
    expect(body.type).toBe("https://errors.acme.com/order-not-found");
    expect(res.headers.get("x-trace-id")).toBe(body.traceId);
    expect(JSON.stringify(body)).not.toContain("replicaLagMs");
  });

  it("emits Retry-After on 429", async () => {
    const base = await listen();
    const res = await fetch(`${base}/limited`);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("30");
  });

  it("passes redirects through untouched", async () => {
    const base = await listen();
    const res = await fetch(`${base}/redirect`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/orders/x");
    expect(res.headers.get("content-type") ?? "").not.toContain("problem+json");
  });

  it("forwards non-ApiError to Express's own handler (pass-through)", async () => {
    const base = await listen();
    const res = await fetch(`${base}/plain-throw`);
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type") ?? "").not.toContain("problem+json");
  });

  it("problemNotFound covers unmatched routes", async () => {
    const base = await listen();
    const res = await fetch(`${base}/no/such/route`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");
  });
});
