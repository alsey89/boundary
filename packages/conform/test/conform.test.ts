import { afterAll, describe, expect, it } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import {
  Internal,
  NotFound,
  RateLimited,
  Unavailable,
  ValidationFailed,
} from "@boundaryjs/server";
import { problemNotFound, problemSink } from "@boundaryjs/server/express";
import { runConformance, scanForLeaks, type ConformConfig } from "boundary-conform";

const servers: Server[] = [];
afterAll(() => {
  for (const server of servers) server.close();
});

function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  return new Promise((resolve) => {
    const server = createServer(handler).listen(0, () => {
      servers.push(server);
      const address = server.address();
      resolve(`http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`);
    });
  });
}

function conformantApp() {
  const app = express();
  app.use(express.json());
  app.post("/orders", (req) => {
    if (typeof req.body?.sku !== "string") {
      throw new ValidationFailed(undefined, "Order payload failed validation.", {
        errors: [{ field: "sku", code: "required", message: "sku is required." }],
      });
    }
    throw new NotFound();
  });
  app.get("/rate-limited", () => {
    throw new RateLimited(undefined, "Slow down.", { retryAfter: 30 });
  });
  app.get("/unavailable", () => {
    throw new Unavailable(undefined, "Down for maintenance.", { retryAfter: new Date(Date.now() + 60_000) });
  });
  app.get("/old-path", (_req, res) => res.redirect(302, "/new-path"));
  app.get("/boom", () => {
    throw new Internal(undefined, "Something went wrong on our side.", {
      log: { query: "SELECT * FROM orders WHERE id = $1" },
    });
  });
  app.use(problemNotFound({ logger: () => {} }));
  app.use(problemSink({ logger: () => {}, typeBase: "https://errors.example.com/" }));
  return app;
}

const fullConfig: ConformConfig = {
  probes: {
    validation: { method: "POST", path: "/orders", body: {} },
    rateLimited: { path: "/rate-limited" },
    unavailable: { path: "/unavailable" },
    redirect: { path: "/old-path" },
    errors: [{ path: "/boom" }],
  },
};

describe("runConformance against a conformant server", () => {
  it("passes every check", async () => {
    const base = await listen(conformantApp());
    const report = await runConformance(base, fullConfig);
    const failures = report.results.filter((r) => r.status === "fail");
    expect(failures, JSON.stringify(failures, null, 2)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.skipped).toBe(0);
    expect(report.results.map((r) => r.id)).toEqual([
      "not-found-problem",
      "validation-errors",
      "retry-after",
      "redirect-passthrough",
      "trace-correlation",
      "leak-scan",
    ]);
  });

  it("skips probe-dependent checks when unconfigured, and still checks 404 + traces + leaks", async () => {
    const base = await listen(conformantApp());
    const report = await runConformance(base);
    const byId = Object.fromEntries(report.results.map((r) => [r.id, r.status]));
    expect(byId["not-found-problem"]).toBe("pass");
    expect(byId["validation-errors"]).toBe("skip");
    expect(byId["retry-after"]).toBe("skip");
    expect(byId["redirect-passthrough"]).toBe("skip");
    expect(byId["trace-correlation"]).toBe("pass");
    expect(byId["leak-scan"]).toBe("pass");
    expect(report.ok).toBe(true);
  });
});

describe("runConformance against a broken server", () => {
  it("fails the right checks", async () => {
    const base = await listen((req, res) => {
      if (req.url === "/boom") {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end(
          `TypeError: Cannot read properties of undefined (reading 'rows')\n` +
            `    at handler (/home/deploy/app/src/orders.ts:42:11)\n` +
            `    at /home/deploy/app/node_modules/express/lib/router.js:5:9\n`,
        );
        return;
      }
      res.writeHead(404, { "Content-Type": "text/html" });
      res.end("<html><body>Cannot GET</body></html>");
    });
    const report = await runConformance(base, { probes: { errors: [{ path: "/boom" }] } });
    const byId = Object.fromEntries(report.results.map((r) => [r.id, r]));
    expect(byId["not-found-problem"]!.status).toBe("fail");
    expect(byId["trace-correlation"]!.status).toBe("fail");
    expect(byId["leak-scan"]!.status).toBe("fail");
    const leakDetails = byId["leak-scan"]!.details!.join("\n");
    expect(leakDetails).toContain("stack-trace");
    expect(leakDetails).toContain("filesystem-path");
    expect(report.ok).toBe(false);
  });

  it("flags an unstable 404 code", async () => {
    let n = 0;
    const base = await listen((_req, res) => {
      n += 1;
      res.writeHead(404, { "Content-Type": "application/problem+json", "X-Trace-Id": "f".repeat(32) });
      res.end(
        JSON.stringify({
          type: "about:blank",
          title: "Not found",
          status: 404,
          code: `NOT_FOUND_${n}`,
          traceId: "f".repeat(32),
        }),
      );
    });
    const report = await runConformance(base);
    const notFound = report.results.find((r) => r.id === "not-found-problem")!;
    expect(notFound.status).toBe("fail");
    expect(notFound.details!.join("\n")).toContain("stable");
  });
});

describe("leak scanner", () => {
  it("catches the classics and honors the allow list", () => {
    expect(scanForLeaks("at handler (/srv/api/index.js:10:3)").length).toBeGreaterThan(0);
    expect(scanForLeaks("SELECT id FROM users WHERE email = ?").length).toBeGreaterThan(0);
    expect(scanForLeaks("connect ECONNREFUSED 10.0.3.7:5432").length).toBeGreaterThan(0);
    expect(scanForLeaks("db-3.internal refused the connection").length).toBeGreaterThan(0);
    expect(scanForLeaks("NODE_ENV was production").length).toBeGreaterThan(0);
    expect(scanForLeaks("No such order.")).toEqual([]);
    expect(scanForLeaks("The field select_from is invalid")).toEqual([]);
    const allowed = scanForLeaks("visit docs.internal for help", [/docs\.internal/]);
    expect(allowed).toEqual([]);
  });
});
