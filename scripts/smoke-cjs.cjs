"use strict";

// Proves the CJS builds load under require() — the path legacy Express and
// Nest apps take. Run after `npm run build`.
const assert = require("node:assert");

const server = require("@boundaryjs/server");
assert.strictEqual(typeof server.ApiError, "function");
assert.strictEqual(typeof server.problemSink, "function");
assert.strictEqual(typeof server.renderProblem, "function");

for (const subpath of ["hono", "express", "fastify", "koa"]) {
  const sink = require(`@boundaryjs/server/${subpath}`);
  assert.strictEqual(typeof sink.problemSink, "function", subpath);
}
const nest = require("@boundaryjs/server/nest");
assert.strictEqual(typeof nest.BoundaryProblemFilter, "function");

const client = require("@boundaryjs/client");
assert.strictEqual(typeof client.createClient, "function");
assert.strictEqual(typeof client.isApiError, "function");

const conform = require("boundary-conform");
assert.strictEqual(typeof conform.runConformance, "function");

const next = require("@boundaryjs/next");
assert.strictEqual(typeof next.withBoundary, "function");
assert.strictEqual(typeof next.wrapRouteHandler, "function");

// The ESM and CJS builds are distinct classes; the shared Symbol.for marker
// is what keeps isApiError working across them. Verify that actually holds.
import("@boundaryjs/server").then((esm) => {
  const error = new esm.NotFound();
  assert.strictEqual(server.isApiError(error), true, "cross-build isApiError");
  console.log("CJS smoke test: all packages load under require(); cross-build identity holds");
});
