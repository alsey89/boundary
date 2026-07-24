"use strict";

/**
 * Webpack/Turbopack loader that wraps the HTTP-method exports of an App
 * Router route module with Boundary's error sink, by replacing the module
 * with a thin proxy:
 *
 *   import * as route from "./route.ts?__boundary_original__";
 *   export * from "./route.ts?__boundary_original__";   // config exports pass through
 *   export const GET = wrapRouteModule(route).GET;      // explicit exports shadow `export *`
 *
 * Runs as a `pre` loader, so detection happens on the untranspiled source
 * and the emitted proxy flows through Next's own SWC pipeline like any
 * other module. The `?__boundary_original__` query keeps the loader from
 * re-wrapping the original when the proxy imports it. The self-import is
 * relative (not this.resourcePath verbatim) because Turbopack does not
 * resolve absolute filesystem paths.
 */

const path = require("node:path");

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

// The rule in withBoundary() already scopes the loader to app/**/route.*,
// but the loader re-checks so it stays safe under bundlers whose rule
// matching is coarser (Turbopack rules are extension globs, not paths).
const ROUTE_FILE = /[\\/]app[\\/](?:.*[\\/])?route\.(?:ts|tsx|js|jsx|mjs)$/;

// Detection only — the emitted proxy still re-exports the untouched
// original. Without this, a commented-out `// export function GET` would
// make the proxy export `GET: undefined` and break the route.
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function exportsName(source, name) {
  return (
    // export async function GET / export const GET / export let GET
    new RegExp(`export\\s+(?:async\\s+)?(?:function|const|let|var|class)\\s+${name}\\b`).test(source) ||
    // export { GET }, export { handler as GET }
    new RegExp(`export\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`).test(source)
  );
}

module.exports = function boundaryLoader(source) {
  if (typeof this.resourceQuery === "string" && this.resourceQuery.includes("__boundary_original__")) {
    return source;
  }
  if (typeof this.resourcePath === "string" && !ROUTE_FILE.test(this.resourcePath)) {
    return source;
  }

  const detectable = stripComments(source);
  const methods = HTTP_METHODS.filter((m) => exportsName(detectable, m));
  if (methods.length === 0) return source;

  const options = (typeof this.getOptions === "function" && this.getOptions()) || {};
  const sinkOptions = {};
  if (typeof options.typeBase === "string") sinkOptions.typeBase = options.typeBase;

  const original = JSON.stringify(`./${path.basename(this.resourcePath)}?__boundary_original__`);
  return [
    `import * as __boundary_route from ${original};`,
    `export * from ${original};`,
    `import { wrapRouteModule as __boundary_wrap } from "@boundaryjs/next";`,
    `const __boundary_wrapped = __boundary_wrap(__boundary_route, ${JSON.stringify(sinkOptions)});`,
    ...methods.map((m) => `export const ${m} = __boundary_wrapped.${m};`),
  ].join("\n");
};
