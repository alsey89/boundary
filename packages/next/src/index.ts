import { isApiError, renderProblem, type SinkOptions } from "@boundaryjs/server";

export type { SinkOptions } from "@boundaryjs/server";

let globalOptions: SinkOptions = {};

/**
 * Set process-wide sink options (typeBase, logger) used by wrapped route
 * handlers that weren't given explicit options. Call it once from
 * `instrumentation.ts` — the build-time transform can only carry
 * serializable options, so a custom logger has to come in here.
 */
export function configureBoundary(options: SinkOptions): void {
  globalOptions = options;
}

type RouteHandler = (...args: never[]) => unknown;

/**
 * Wrap one App Router route handler. Next.js has no error sink —
 * middleware runs before routing and can't catch a throw — so the wrapper
 * IS the sink: ApiError becomes problem+json; everything else, including
 * Next's own redirect()/notFound() control-flow throws, is re-raised
 * untouched.
 */
export function wrapRouteHandler<H extends RouteHandler>(handler: H, options?: SinkOptions): H {
  const wrapped = async function (this: unknown, ...args: unknown[]): Promise<unknown> {
    try {
      return await (handler as unknown as (...a: unknown[]) => unknown).apply(this, args);
    } catch (error) {
      if (!isApiError(error)) throw error;
      const { status, headers, body } = renderProblem(error, options ?? globalOptions);
      return new Response(body, { status, headers });
    }
  };
  Object.defineProperty(wrapped, "name", { value: handler.name, configurable: true });
  return wrapped as unknown as H;
}

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;

/**
 * Wrap every HTTP-method export of a route module. Non-handler exports
 * (dynamic, revalidate, runtime, …) pass through untouched. This is what
 * the build-time transform calls; it's also usable by hand.
 */
export function wrapRouteModule<M extends Record<string, unknown>>(mod: M, options?: SinkOptions): M {
  const out: Record<string, unknown> = { ...mod };
  for (const method of HTTP_METHODS) {
    const handler = mod[method];
    if (typeof handler === "function") {
      out[method] = wrapRouteHandler(handler as RouteHandler, options);
    }
  }
  return out as M;
}

/** The serializable subset of SinkOptions the build transform can carry. */
export interface WithBoundaryOptions {
  typeBase?: string;
}

interface WebpackRule {
  [key: string]: unknown;
}
interface WebpackConfig {
  module?: { rules?: WebpackRule[] };
  [key: string]: unknown;
}
interface TurbopackConfig {
  rules?: Record<string, unknown>;
  [key: string]: unknown;
}
interface NextConfigLike {
  webpack?: (config: WebpackConfig, context: unknown) => WebpackConfig;
  turbopack?: TurbopackConfig;
  [key: string]: unknown;
}

/** Both bundlers get the same loader; the loader itself re-checks the path. */
const ROUTE_GLOB = "**/app/**/route.{ts,tsx,js,jsx,mjs}";
const LOADER = "@boundaryjs/next/loader";

/**
 * next.config wrapper. Injects a loader that wraps the exported handlers
 * of every `app/**\/route.{ts,js}` at build time (the same technique
 * Sentry's SDK uses), so plain handlers get the error contract with no
 * wrapper code in your source. Registered for both bundlers: a webpack
 * rule and a `turbopack.rules` entry, so it works under `next build` and
 * `next build --turbopack` alike.
 *
 *   // next.config.mjs
 *   import { withBoundary } from '@boundaryjs/next'
 *   export default withBoundary({ ...yourConfig }, { typeBase: 'https://errors.acme.com/' })
 */
export function withBoundary<C extends NextConfigLike>(
  nextConfig: C = {} as C,
  boundaryOptions: WithBoundaryOptions = {},
): C {
  // Turbopack requires loader options to be serializable; don't carry an
  // explicit `typeBase: undefined`.
  const loaderOptions: Record<string, string> = {};
  if (boundaryOptions.typeBase !== undefined) loaderOptions.typeBase = boundaryOptions.typeBase;

  return {
    ...nextConfig,
    turbopack: {
      ...nextConfig.turbopack,
      rules: {
        ...nextConfig.turbopack?.rules,
        [ROUTE_GLOB]: {
          loaders: [{ loader: LOADER, options: loaderOptions }],
        },
      },
    },
    webpack(config: WebpackConfig, context: unknown): WebpackConfig {
      const resolved =
        typeof nextConfig.webpack === "function" ? nextConfig.webpack(config, context) : config;
      resolved.module ??= { rules: [] };
      resolved.module.rules ??= [];
      resolved.module.rules.unshift({
        test: /[\\/]route\.(?:ts|tsx|js|jsx|mjs)$/,
        include: /[\\/]app[\\/]/,
        enforce: "pre",
        resourceQuery: { not: [/__boundary_original__/] },
        use: [
          {
            // A bare specifier, not require.resolve: webpack's loader
            // resolution handles the "./loader" export, and avoiding
            // import.meta keeps this module compilable to CJS for
            // next.config.js users.
            loader: LOADER,
            options: loaderOptions,
          },
        ],
      });
      return resolved;
    },
  };
}
