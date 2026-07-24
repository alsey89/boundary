/**
 * @boundaryjs/client — a fetch wrapper for RFC 9457 APIs.
 *
 * Errors throw; that's what integrates with the ecosystem (React Query
 * retries, error boundaries catch, unhandled failures are loud). Failure
 * policy is set per call site and defaulted per code. Where failure is an
 * expected outcome, `.safe()` opts into a Result.
 */

/** Cross-copy identity marker, so isApiError survives duplicated packages. */
export const API_ERROR_MARKER = Symbol.for("boundary.client.ApiError");

/** One field-level validation failure from the problem body's errors[]. */
export interface FieldError {
  field: string;
  code?: string;
  message: string;
}

/** The raw problem+json body, when the server sent one. */
export interface Problem {
  type?: string;
  title?: string;
  status?: number;
  code?: string;
  detail?: string;
  instance?: string;
  traceId?: string;
  errors?: FieldError[];
  [extension: string]: unknown;
}

export class ApiError extends Error {
  readonly [API_ERROR_MARKER] = true;

  /** The only field you should branch on. `HTTP_<status>` when the server
   * didn't speak problem+json, `NETWORK_ERROR` when the request never
   * completed. */
  readonly code: string;
  /** HTTP status; 0 for network failures. */
  readonly status: number;
  readonly title?: string;
  readonly detail?: string;
  readonly type?: string;
  /** Correlate with server-side telemetry; from body or X-Trace-Id header. */
  readonly traceId?: string;
  readonly errors?: FieldError[];
  /** The parsed problem body, if the response carried one. */
  readonly problem?: Problem;
  /** Retry-After, parsed to milliseconds-from-now, if the server sent it. */
  readonly retryAfterMs?: number;
  readonly response?: Response;

  constructor(init: {
    code: string;
    status: number;
    title?: string;
    detail?: string;
    type?: string;
    traceId?: string;
    errors?: FieldError[];
    problem?: Problem;
    retryAfterMs?: number;
    response?: Response;
    cause?: unknown;
  }) {
    const label = init.detail ?? init.title ?? "Request failed";
    super(`${init.code} (${init.status}): ${label}`, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = "ApiError";
    this.code = init.code;
    this.status = init.status;
    this.title = init.title;
    this.detail = init.detail;
    this.type = init.type;
    this.traceId = init.traceId;
    this.errors = init.errors;
    this.problem = init.problem;
    this.retryAfterMs = init.retryAfterMs;
    this.response = init.response;
  }
}

export function isApiError(value: unknown): value is ApiError {
  if (value instanceof ApiError) return true;
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[API_ERROR_MARKER] === true
  );
}

/**
 * Four policies, deliberately few:
 * - `silent`         rethrow only; no global side effects. The call site handles it.
 * - `report`         onReport (toast + telemetry), then rethrow. The default.
 * - `retry`          honors Retry-After, capped backoff; report+rethrow when exhausted.
 * - `reauthenticate` onReauthenticate (clear session, redirect). Does not rethrow —
 *                    the returned promise never settles, because the page is leaving.
 */
export type Policy = "silent" | "report" | "retry" | "reauthenticate";

/** Map error `code` -> policy. `'*'` is the fallback for unmatched codes. */
export type PolicyMap = Partial<Record<string, Policy>>;

export interface RetryOptions {
  /** Total attempts, including the first. Default 3. */
  attempts?: number;
  /** First backoff delay when no Retry-After header. Default 250ms. */
  baseDelayMs?: number;
  /** Cap for any single delay, Retry-After included. Default 30s. */
  maxDelayMs?: number;
}

export interface ClientOptions {
  /** Prefix for relative paths, e.g. "/api" or "https://api.acme.com". */
  baseUrl?: string;
  /** Default failure policy per error code. `'*'` catches the rest. */
  policy?: PolicyMap;
  /** Global failure side effect: toast, telemetry. Runs for `report`. */
  onReport?: (error: ApiError) => void;
  /** Session teardown + redirect. Required for `reauthenticate` to engage. */
  onReauthenticate?: (error: ApiError) => void | Promise<void>;
  /**
   * How long a `reauthenticate`d call stays pending after onReauthenticate
   * resolves before rejecting with the original error. In a browser the
   * redirect unloads the page first, so no error UI flashes; if navigation
   * never happens (tests, SSR, a failed redirect) the error surfaces
   * instead of hanging forever. Default 10s. `Infinity` restores the
   * never-settle behavior.
   */
  reauthenticateGraceMs?: number;
  retry?: RetryOptions;
  /** Static headers, or a (possibly async) factory evaluated per attempt. */
  headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);
  /** Custom fetch (tests, polyfills). Defaults to globalThis.fetch. */
  fetch?: typeof fetch;
}

export interface RequestOptions {
  /** Per-call policy overrides. Checked before the client-level map. */
  policy?: PolicyMap;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | null | undefined>;
  signal?: AbortSignal;
  /**
   * Declares this call safe to retry. The `retry` policy only re-sends
   * idempotent methods (GET, HEAD, PUT, DELETE, OPTIONS) on its own —
   * replaying a POST can double-submit, since the first attempt may have
   * reached the server even when the response didn't arrive. Set this on
   * calls that are idempotent by construction (e.g. carrying an
   * Idempotency-Key header).
   */
  idempotent?: boolean;
}

export type SafeResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: ApiError };

/** A Promise that can opt into Result-style handling for expected failures. */
export type ApiPromise<T> = Promise<T> & {
  safe(): Promise<SafeResult<T>>;
};

export interface BoundaryClient {
  request<T = unknown>(method: string, path: string, body?: unknown, options?: RequestOptions): ApiPromise<T>;
  get<T = unknown>(path: string, options?: RequestOptions): ApiPromise<T>;
  delete<T = unknown>(path: string, options?: RequestOptions): ApiPromise<T>;
  head<T = unknown>(path: string, options?: RequestOptions): ApiPromise<T>;
  post<T = unknown>(path: string, body?: unknown, options?: RequestOptions): ApiPromise<T>;
  put<T = unknown>(path: string, body?: unknown, options?: RequestOptions): ApiPromise<T>;
  patch<T = unknown>(path: string, body?: unknown, options?: RequestOptions): ApiPromise<T>;
}

const NO_BODY = Symbol("boundary.noBody");

function joinUrl(baseUrl: string | undefined, path: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) || !baseUrl) return path;
  return baseUrl.replace(/\/+$/, "") + (path.startsWith("/") ? path : `/${path}`);
}

function appendQuery(url: string, query: RequestOptions["query"]): string {
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    params.append(key, String(value));
  }
  const qs = params.toString();
  if (!qs) return url;
  return url + (url.includes("?") ? "&" : "?") + qs;
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - Date.now());
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(abortError(signal!));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

function looksLikeProblem(value: unknown): value is Problem {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function errorFromResponse(response: Response): Promise<ApiError> {
  const contentType = response.headers.get("content-type") ?? "";
  let problem: Problem | undefined;
  if (/\bjson\b/i.test(contentType)) {
    try {
      const parsed: unknown = await response.clone().json();
      if (looksLikeProblem(parsed)) problem = parsed;
    } catch {
      // Malformed body; fall through to the status-only error.
    }
  }
  const isProblemJson = contentType.toLowerCase().includes("application/problem+json");
  const code =
    (isProblemJson || typeof problem?.code === "string") && typeof problem?.code === "string"
      ? problem.code
      : `HTTP_${response.status}`;
  return new ApiError({
    code,
    status: response.status,
    title: typeof problem?.title === "string" ? problem.title : undefined,
    detail: typeof problem?.detail === "string" ? problem.detail : undefined,
    type: typeof problem?.type === "string" ? problem.type : undefined,
    traceId:
      (typeof problem?.traceId === "string" ? problem.traceId : undefined) ??
      response.headers.get("x-trace-id") ??
      undefined,
    errors: Array.isArray(problem?.errors) ? (problem.errors as FieldError[]) : undefined,
    problem,
    retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
    response,
  });
}

async function parseSuccess<T>(response: Response): Promise<T> {
  if (response.status === 204 || response.status === 205 || response.status === 304) {
    return undefined as T;
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (/\bjson\b/i.test(contentType)) return (await response.json()) as T;
  if (response.body === null) return undefined as T;
  const text = await response.text();
  return (text === "" ? undefined : text) as T;
}

function resolvePolicy(code: string, perCall?: PolicyMap, defaults?: PolicyMap): Policy {
  return perCall?.[code] ?? perCall?.["*"] ?? defaults?.[code] ?? defaults?.["*"] ?? "report";
}

const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "PUT", "DELETE", "OPTIONS"]);

let warnedNoReauthenticate = false;
let warnedNonIdempotentRetry = false;

export function createClient(clientOptions: ClientOptions = {}): BoundaryClient {
  const fetchImpl = clientOptions.fetch ?? globalThis.fetch.bind(globalThis);
  const retryConfig = {
    attempts: clientOptions.retry?.attempts ?? 3,
    baseDelayMs: clientOptions.retry?.baseDelayMs ?? 250,
    maxDelayMs: clientOptions.retry?.maxDelayMs ?? 30_000,
  };

  async function attempt(method: string, path: string, body: unknown, options: RequestOptions): Promise<{ ok: true; response: Response } | { ok: false; error: ApiError }> {
    const url = appendQuery(joinUrl(clientOptions.baseUrl, path), options.query);
    const baseHeaders =
      typeof clientOptions.headers === "function"
        ? await clientOptions.headers()
        : (clientOptions.headers ?? {});
    const headers = new Headers({ Accept: "application/json, application/problem+json" });
    for (const [name, value] of Object.entries(baseHeaders)) headers.set(name, value);
    for (const [name, value] of Object.entries(options.headers ?? {})) headers.set(name, value);

    const init: RequestInit = { method, headers, signal: options.signal ?? null };
    if (body !== NO_BODY) {
      if (
        typeof body === "string" ||
        body instanceof Blob ||
        body instanceof ArrayBuffer ||
        body instanceof FormData ||
        body instanceof URLSearchParams ||
        ArrayBuffer.isView(body)
      ) {
        init.body = body as BodyInit;
      } else {
        if (!headers.has("content-type")) headers.set("Content-Type", "application/json");
        init.body = JSON.stringify(body);
      }
    }

    let response: Response;
    try {
      response = await fetchImpl(url, init);
    } catch (cause) {
      if (options.signal?.aborted) throw cause;
      return {
        ok: false,
        error: new ApiError({
          code: "NETWORK_ERROR",
          status: 0,
          detail: cause instanceof Error ? cause.message : "Request failed before a response arrived",
          cause,
        }),
      };
    }
    if (response.ok) return { ok: true, response };
    return { ok: false, error: await errorFromResponse(response) };
  }

  async function execute<T>(method: string, path: string, body: unknown, options: RequestOptions): Promise<T> {
    let attemptsUsed = 0;
    for (;;) {
      attemptsUsed += 1;
      const result = await attempt(method, path, body, options);
      if (result.ok) return parseSuccess<T>(result.response);

      const error = result.error;
      let policy = resolvePolicy(error.code, options.policy, clientOptions.policy);

      if (policy === "retry" && !IDEMPOTENT_METHODS.has(method) && options.idempotent !== true) {
        // Replaying a POST/PATCH can double-submit: the first attempt may
        // have reached the server even when the response didn't.
        if (!warnedNonIdempotentRetry) {
          warnedNonIdempotentRetry = true;
          console.warn(
            `[boundary] policy 'retry' matched a ${method} request; not retrying because ${method} is not idempotent. Pass \`idempotent: true\` on calls that are safe to replay.`,
          );
        }
        policy = "report";
      }

      if (policy === "retry" && attemptsUsed < retryConfig.attempts) {
        const backoff = retryConfig.baseDelayMs * 2 ** (attemptsUsed - 1);
        const jittered = backoff * (0.5 + Math.random() * 0.5);
        const delay = Math.min(error.retryAfterMs ?? jittered, retryConfig.maxDelayMs);
        await sleep(delay, options.signal);
        continue;
      }
      if (policy === "retry") policy = "report"; // retries exhausted

      if (policy === "reauthenticate") {
        if (clientOptions.onReauthenticate) {
          await clientOptions.onReauthenticate(error);
          // The session is being torn down and the page is (normally)
          // navigating away. Staying pending through the grace period keeps
          // error boundaries and toasts from flashing during the redirect;
          // rejecting afterwards keeps tests, SSR, and failed redirects
          // from hanging forever.
          const graceMs = clientOptions.reauthenticateGraceMs ?? 10_000;
          if (!Number.isFinite(graceMs)) return new Promise<T>(() => {});
          await sleep(graceMs, options.signal);
          throw error;
        }
        if (!warnedNoReauthenticate) {
          warnedNoReauthenticate = true;
          console.warn(
            "[boundary] policy 'reauthenticate' matched but no onReauthenticate handler is configured; falling back to 'report'.",
          );
        }
        policy = "report";
      }

      if (policy === "report") {
        try {
          clientOptions.onReport?.(error);
        } catch {
          // A broken toast must not mask the real failure.
        }
      }
      throw error;
    }
  }

  function toApiPromise<T>(run: () => Promise<T>): ApiPromise<T> {
    const promise = run() as ApiPromise<T>;
    promise.safe = () =>
      promise.then(
        (data): SafeResult<T> => ({ ok: true, data }),
        (error): SafeResult<T> => {
          if (isApiError(error)) return { ok: false, error };
          throw error;
        },
      );
    return promise;
  }

  const request = <T>(method: string, path: string, body: unknown = NO_BODY, options: RequestOptions = {}) =>
    toApiPromise<T>(() => execute<T>(method.toUpperCase(), path, body, options));

  return {
    request: <T>(method: string, path: string, body: unknown = NO_BODY, options?: RequestOptions) =>
      request<T>(method, path, body, options),
    get: <T>(path: string, options?: RequestOptions) => request<T>("GET", path, NO_BODY, options),
    delete: <T>(path: string, options?: RequestOptions) => request<T>("DELETE", path, NO_BODY, options),
    head: <T>(path: string, options?: RequestOptions) => request<T>("HEAD", path, NO_BODY, options),
    post: <T>(path: string, body?: unknown, options?: RequestOptions) => request<T>("POST", path, body, options),
    put: <T>(path: string, body?: unknown, options?: RequestOptions) => request<T>("PUT", path, body, options),
    patch: <T>(path: string, body?: unknown, options?: RequestOptions) => request<T>("PATCH", path, body, options),
  };
}
