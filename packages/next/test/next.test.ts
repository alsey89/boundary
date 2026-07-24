import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { NotFound } from "@boundaryjs/server";
import { withBoundary, wrapRouteHandler, wrapRouteModule } from "@boundaryjs/next";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const loader = require("@boundaryjs/next/loader") as (this: unknown, source: string) => string;

describe("wrapRouteHandler", () => {
  it("turns a thrown ApiError into a problem+json Response", async () => {
    const GET = wrapRouteHandler(
      async () => {
        throw new NotFound("ORDER_NOT_FOUND", "No such order.", { log: { shardKey: "orders-7" } });
      },
      { logger: () => {} },
    );
    const res = (await GET()) as Response;
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    const body = await res.json();
    expect(body.code).toBe("ORDER_NOT_FOUND");
    expect(res.headers.get("x-trace-id")).toBe(body.traceId);
    expect(JSON.stringify(body)).not.toContain("shardKey");
  });

  it("re-raises non-ApiError untouched — Next's redirect()/notFound() control flow survives", async () => {
    const redirectError = Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;push;/login;307" });
    const GET = wrapRouteHandler(async () => {
      throw redirectError;
    });
    await expect(GET()).rejects.toBe(redirectError);
  });

  it("passes successful responses through", async () => {
    const GET = wrapRouteHandler(async () => Response.json({ ok: true }));
    const res = (await GET()) as Response;
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("wrapRouteModule", () => {
  it("wraps only HTTP-method exports", async () => {
    const mod = {
      GET: async () => {
        throw new NotFound();
      },
      dynamic: "force-dynamic",
      helper: () => 42,
    };
    const wrapped = wrapRouteModule(mod, { logger: () => {} });
    expect(wrapped.dynamic).toBe("force-dynamic");
    expect(wrapped.helper).toBe(mod.helper);
    const res = (await wrapped.GET()) as unknown as Response;
    expect(res.status).toBe(404);
  });
});

describe("loader", () => {
  function run(source: string, resourceQuery = "", options: Record<string, unknown> = {}) {
    return loader.call(
      { resourcePath: "/proj/app/api/orders/route.ts", resourceQuery, getOptions: () => options },
      source,
    );
  }

  it("proxies a route module and shadows its method exports", () => {
    const out = run(
      `import { NotFound } from '@boundaryjs/server'\n` +
        `export const dynamic = 'force-dynamic'\n` +
        `export async function GET() { throw new NotFound() }\n` +
        `export const POST = async () => Response.json({})\n`,
      "",
      { typeBase: "https://errors.acme.com/" },
    );
    expect(out).toContain(`"./route.ts?__boundary_original__"`);
    expect(out).toContain("export * from");
    expect(out).toContain('{"typeBase":"https://errors.acme.com/"}');
    expect(out).toContain("export const GET = __boundary_wrapped.GET;");
    expect(out).toContain("export const POST = __boundary_wrapped.POST;");
    expect(out).not.toContain("__boundary_wrapped.DELETE");
  });

  it("detects re-export lists like `export { handler as GET }`", () => {
    const out = run(`const handler = async () => new Response()\nexport { handler as GET }\n`);
    expect(out).toContain("export const GET = __boundary_wrapped.GET;");
  });

  it("leaves modules without handler exports untouched", () => {
    const source = `export const helper = 1\n`;
    expect(run(source)).toBe(source);
  });

  it("leaves the original (queried) module untouched to avoid double-wrapping", () => {
    const source = `export async function GET() {}\n`;
    expect(run(source, "?__boundary_original__")).toBe(source);
  });

  it("ignores handler exports that only appear in comments", () => {
    const source =
      `// export function GET() {} — removed, this route is POST-only\n` +
      `/* export const DELETE = () => {} */\n` +
      `export async function POST() { return Response.json({}) }\n`;
    const out = run(source);
    expect(out).toContain("export const POST = __boundary_wrapped.POST;");
    expect(out).not.toContain("__boundary_wrapped.GET");
    expect(out).not.toContain("__boundary_wrapped.DELETE");
  });

  it("leaves non-route files untouched even when the rule matches too broadly", () => {
    const source = `export async function GET() {}\n`;
    const out = loader.call(
      { resourcePath: "/proj/lib/handlers/route-helpers.ts", resourceQuery: "", getOptions: () => ({}) },
      source,
    );
    expect(out).toBe(source);
  });
});

describe("withBoundary", () => {
  it("prepends the loader rule and preserves a user webpack function", () => {
    let userCalled = false;
    const config = withBoundary(
      {
        webpack(cfg: { module?: { rules?: unknown[] } }) {
          userCalled = true;
          return cfg;
        },
      },
      { typeBase: "https://errors.acme.com/" },
    );
    const webpackConfig: { module?: { rules?: unknown[] } } = { module: { rules: [] } };
    const result = config.webpack!(webpackConfig, {});
    expect(userCalled).toBe(true);
    const rule = (result.module!.rules! as Array<Record<string, unknown>>)[0]!;
    expect(String(rule.test)).toContain("route");
    expect(rule.enforce).toBe("pre");
    const use = (rule.use as Array<{ loader: string; options: { typeBase?: string } }>)[0]!;
    expect(use.loader).toBe("@boundaryjs/next/loader");
    expect(use.options.typeBase).toBe("https://errors.acme.com/");
  });

  it("registers a turbopack rule alongside the webpack one, preserving user rules", () => {
    const config = withBoundary(
      { turbopack: { rules: { "*.svg": { loaders: ["@svgr/webpack"] } } } },
      { typeBase: "https://errors.acme.com/" },
    );
    const rules = config.turbopack!.rules as Record<
      string,
      { loaders: Array<{ loader: string; options: Record<string, string> }> }
    >;
    expect(rules["*.svg"]).toBeDefined();
    const rule = rules["**/app/**/route.{ts,tsx,js,jsx,mjs}"]!;
    expect(rule.loaders[0]!.loader).toBe("@boundaryjs/next/loader");
    expect(rule.loaders[0]!.options).toEqual({ typeBase: "https://errors.acme.com/" });
  });

  it("omits undefined typeBase from loader options so they stay turbopack-serializable", () => {
    const config = withBoundary();
    const rules = config.turbopack!.rules as Record<
      string,
      { loaders: Array<{ loader: string; options: Record<string, string> }> }
    >;
    expect(rules["**/app/**/route.{ts,tsx,js,jsx,mjs}"]!.loaders[0]!.options).toEqual({});
  });
});
