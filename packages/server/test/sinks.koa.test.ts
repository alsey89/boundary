import { afterAll, describe, expect, it } from "vitest";
import Koa from "koa";
import { createServer, type Server } from "node:http";
import { NotFound } from "@boundaryjs/server";
import { problemSink } from "@boundaryjs/server/koa";

const silent = { logger: () => {} };

const app = new Koa();
app.use(problemSink(silent));
app.use(async (ctx) => {
  if (ctx.path === "/missing") {
    throw new NotFound("ORDER_NOT_FOUND", "No such order.", { log: { shardKey: "orders-7" } });
  }
  if (ctx.path === "/plain-throw") {
    throw new Error("not an ApiError");
  }
  ctx.body = { ok: true };
});
// Keep Koa's default stderr dump quiet for the pass-through test.
app.on("error", () => {});
app.silent = true;

let server: Server;
const base = await new Promise<string>((resolve) => {
  server = createServer(app.callback()).listen(0, () => {
    const address = server.address();
    resolve(`http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`);
  });
});
afterAll(() => server.close());

describe("koa sink", () => {
  it("transforms a thrown ApiError into problem+json", async () => {
    const res = await fetch(`${base}/missing`);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    const body = await res.json();
    expect(body.code).toBe("ORDER_NOT_FOUND");
    expect(res.headers.get("x-trace-id")).toBe(body.traceId);
    expect(JSON.stringify(body)).not.toContain("shardKey");
  });

  it("re-throws non-ApiError to Koa's own handling (pass-through)", async () => {
    const res = await fetch(`${base}/plain-throw`);
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type") ?? "").not.toContain("problem+json");
  });

  it("leaves successful responses alone", async () => {
    const res = await fetch(`${base}/fine`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
