import express from "express";
import {
  Internal,
  NotFound,
  RateLimited,
  Unavailable,
  ValidationFailed,
} from "@boundaryjs/server";
import { problemNotFound, problemSink } from "@boundaryjs/server/express";

const ORDERS = new Map([["ord_1001", { id: "ord_1001", sku: "widget", qty: 2 }]]);

export function createApp() {
  const app = express();
  app.use(express.json());

  app.get("/orders/:id", (req, res) => {
    const order = ORDERS.get(req.params.id);
    if (!order) {
      throw new NotFound("ORDER_NOT_FOUND", "No such order.", {
        log: { shardKey: "orders-7", replicaLagMs: 240 },
      });
    }
    res.json(order);
  });

  app.post("/orders", (req, res) => {
    const errors = [];
    if (typeof req.body?.sku !== "string") {
      errors.push({ field: "sku", code: "required", message: "sku is required." });
    }
    if (!Number.isInteger(req.body?.qty) || req.body.qty < 1) {
      errors.push({ field: "qty", code: "too_small", message: "qty must be a positive integer." });
    }
    if (errors.length > 0) {
      throw new ValidationFailed("VALIDATION_FAILED", "Order payload failed validation.", { errors });
    }
    const order = { id: `ord_${ORDERS.size + 1000}`, sku: req.body.sku, qty: req.body.qty };
    ORDERS.set(order.id, order);
    res.status(201).json(order);
  });

  app.get("/rate-limited", () => {
    throw new RateLimited(undefined, "Too many requests. Slow down.", { retryAfter: 30 });
  });

  app.get("/unavailable", () => {
    throw new Unavailable(undefined, "Down for maintenance.", { retryAfter: 120 });
  });

  // A framework redirect must pass through the sink untouched.
  app.get("/old-path", (_req, res) => {
    res.redirect(302, "/orders/ord_1001");
  });

  // Debug context goes to the span/log record. NEVER the wire.
  app.get("/boom", () => {
    throw new Internal(undefined, "Something went wrong on our side.", {
      log: { query: "SELECT * FROM orders WHERE id = $1", host: "db-3.internal" },
      cause: new TypeError("Cannot read properties of undefined (reading 'rows')"),
    });
  });

  app.use(problemNotFound());
  app.use(problemSink({ typeBase: "https://errors.example.com/" }));
  return app;
}
