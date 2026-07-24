import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { NotFound, problemNotFound, problemSink } from "@boundaryjs/server";

const silent = { logger: () => {} };

function makeApp() {
  const app = new Hono();
  app.onError(problemSink(silent));
  app.notFound(problemNotFound(silent));
  app.get("/orders/:id", (c) => {
    if (c.req.param("id") !== "ord_1") {
      throw new NotFound("ORDER_NOT_FOUND", "No such order.", {
        log: { shardKey: "orders-7", replicaLagMs: 240 },
      });
    }
    return c.json({ id: "ord_1" });
  });
  app.get("/plain-throw", () => {
    throw new Error("not an ApiError");
  });
  app.get("/http-exception", () => {
    throw new HTTPException(403, { message: "framework says no" });
  });
  return app;
}

describe("hono sink", () => {
  it("turns a thrown ApiError into problem+json with trace correlation", async () => {
    const res = await makeApp().request("/orders/missing");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    const body = await res.json();
    expect(body).toMatchObject({
      status: 404,
      code: "ORDER_NOT_FOUND",
      detail: "No such order.",
      title: "Order not found",
    });
    expect(res.headers.get("x-trace-id")).toBe(body.traceId);
    expect(JSON.stringify(body)).not.toContain("shardKey");
  });

  it("leaves successful routes alone", async () => {
    const res = await makeApp().request("/orders/ord_1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "ord_1" });
  });

  it("re-raises non-ApiError throws untouched (pass-through)", async () => {
    // Hono surfaces a rethrow from onError synchronously; wrap so both
    // sync throws and async rejections land in `rejects`.
    await expect(async () => makeApp().request("/plain-throw")).rejects.toThrow("not an ApiError");
    await expect(async () => makeApp().request("/http-exception")).rejects.toBeInstanceOf(HTTPException);
  });

  it("problemNotFound speaks the contract for unmatched routes", async () => {
    const res = await makeApp().request("/nope");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");
  });
});
