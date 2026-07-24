import { describe, expect, it, vi } from "vitest";
import { createClient, isApiError, ApiError } from "@boundaryjs/client";

function problemResponse(
  status: number,
  problem: Record<string, unknown>,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(problem), {
    status,
    headers: {
      "Content-Type": "application/problem+json",
      "X-Trace-Id": (problem.traceId as string) ?? "t".repeat(32),
      ...headers,
    },
  });
}

function fetchStub(...responses: Array<Response | Error>) {
  const queue = [...responses];
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = queue.shift();
    if (!next) throw new Error("fetch stub exhausted");
    if (next instanceof Error) throw next;
    return next;
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

describe("success paths", () => {
  it("parses JSON, joins baseUrl, and appends query", async () => {
    const { impl, calls } = fetchStub(Response.json({ id: "u_1" }));
    const api = createClient({ baseUrl: "/api", fetch: impl });
    const user = await api.get<{ id: string }>("/users/u_1", { query: { expand: "orders", page: 2 } });
    expect(user).toEqual({ id: "u_1" });
    expect(calls[0]!.url).toBe("/api/users/u_1?expand=orders&page=2");
  });

  it("returns undefined for 204 and serializes JSON bodies with content-type", async () => {
    const { impl, calls } = fetchStub(new Response(null, { status: 204 }));
    const api = createClient({ fetch: impl });
    const out = await api.post("/orders", { sku: "widget", qty: 2 });
    expect(out).toBeUndefined();
    expect(calls[0]!.init?.body).toBe(JSON.stringify({ sku: "widget", qty: 2 }));
    expect(new Headers(calls[0]!.init?.headers).get("content-type")).toBe("application/json");
  });

  it("evaluates a headers factory per request", async () => {
    const { impl, calls } = fetchStub(Response.json({}));
    const api = createClient({ fetch: impl, headers: async () => ({ Authorization: "Bearer tok" }) });
    await api.get("/me");
    expect(new Headers(calls[0]!.init?.headers).get("authorization")).toBe("Bearer tok");
  });
});

describe("error parsing", () => {
  it("surfaces problem+json fields on the thrown ApiError", async () => {
    const { impl } = fetchStub(
      problemResponse(404, {
        type: "https://errors.acme.com/order-not-found",
        title: "Order not found",
        status: 404,
        code: "ORDER_NOT_FOUND",
        detail: "No such order.",
        traceId: "a".repeat(32),
      }),
    );
    const api = createClient({ fetch: impl, policy: { "*": "silent" } });
    const error = await api.get("/orders/x").then(
      () => null,
      (e: unknown) => e,
    );
    expect(isApiError(error)).toBe(true);
    const apiError = error as ApiError;
    expect(apiError.code).toBe("ORDER_NOT_FOUND");
    expect(apiError.status).toBe(404);
    expect(apiError.detail).toBe("No such order.");
    expect(apiError.traceId).toBe("a".repeat(32));
    expect(apiError.message).toContain("ORDER_NOT_FOUND");
  });

  it("falls back to HTTP_<status> when the server doesn't speak problem+json", async () => {
    const { impl } = fetchStub(new Response("<h1>Bad Gateway</h1>", { status: 502, headers: { "Content-Type": "text/html" } }));
    const api = createClient({ fetch: impl, policy: { "*": "silent" } });
    await expect(api.get("/x")).rejects.toMatchObject({ code: "HTTP_502", status: 502 });
  });

  it("maps fetch rejection to NETWORK_ERROR with the cause attached", async () => {
    const boom = new TypeError("fetch failed");
    const { impl } = fetchStub(boom);
    const api = createClient({ fetch: impl, policy: { "*": "silent" } });
    await expect(api.get("/x")).rejects.toMatchObject({ code: "NETWORK_ERROR", status: 0, cause: boom });
  });
});

describe("policies", () => {
  const notFound = () => problemResponse(404, { status: 404, code: "USER_NOT_FOUND", title: "User not found" });

  it("report (the default) calls onReport, then rethrows", async () => {
    const onReport = vi.fn();
    const { impl } = fetchStub(notFound());
    const api = createClient({ fetch: impl, onReport });
    await expect(api.get("/users/x")).rejects.toMatchObject({ code: "USER_NOT_FOUND" });
    expect(onReport).toHaveBeenCalledOnce();
  });

  it("silent rethrows without the global side effect", async () => {
    const onReport = vi.fn();
    const { impl } = fetchStub(notFound());
    const api = createClient({ fetch: impl, onReport, policy: { USER_NOT_FOUND: "silent" } });
    await expect(api.get("/users/x")).rejects.toMatchObject({ code: "USER_NOT_FOUND" });
    expect(onReport).not.toHaveBeenCalled();
  });

  it("per-call policy overrides the client default for the same code", async () => {
    const onReport = vi.fn();
    const { impl } = fetchStub(notFound());
    const api = createClient({ fetch: impl, onReport, policy: { USER_NOT_FOUND: "report" } });
    await expect(
      api.get("/users/x", { policy: { USER_NOT_FOUND: "silent" } }),
    ).rejects.toMatchObject({ code: "USER_NOT_FOUND" });
    expect(onReport).not.toHaveBeenCalled();
  });

  it("retry honors Retry-After, then succeeds", async () => {
    const { impl, calls } = fetchStub(
      problemResponse(429, { status: 429, code: "RATE_LIMITED", title: "Rate limited" }, { "Retry-After": "0" }),
      Response.json({ ok: true }),
    );
    const api = createClient({ fetch: impl, policy: { RATE_LIMITED: "retry" } });
    await expect(api.get("/poll")).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(2);
  });

  it("retry gives up after configured attempts and falls back to report", async () => {
    const onReport = vi.fn();
    const limited = () =>
      problemResponse(429, { status: 429, code: "RATE_LIMITED", title: "Rate limited" }, { "Retry-After": "0" });
    const { impl, calls } = fetchStub(limited(), limited(), limited());
    const api = createClient({
      fetch: impl,
      onReport,
      policy: { RATE_LIMITED: "retry" },
      retry: { attempts: 3, baseDelayMs: 1 },
    });
    await expect(api.get("/poll")).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(calls).toHaveLength(3);
    expect(onReport).toHaveBeenCalledOnce();
  });

  it("reauthenticate invokes the handler and stays pending through the redirect grace period", async () => {
    const onReauthenticate = vi.fn();
    const { impl } = fetchStub(problemResponse(401, { status: 401, code: "UNAUTHENTICATED", title: "Unauthenticated" }));
    const api = createClient({ fetch: impl, onReauthenticate, policy: { UNAUTHENTICATED: "reauthenticate" } });
    const outcome = await Promise.race([
      api.get("/me").then(
        () => "settled",
        () => "settled",
      ),
      new Promise((resolve) => setTimeout(() => resolve("pending"), 50)),
    ]);
    expect(outcome).toBe("pending");
    expect(onReauthenticate).toHaveBeenCalledOnce();
  });

  it("reauthenticate rejects with the original error once the grace period elapses", async () => {
    const onReauthenticate = vi.fn();
    const { impl } = fetchStub(problemResponse(401, { status: 401, code: "UNAUTHENTICATED", title: "Unauthenticated" }));
    const api = createClient({
      fetch: impl,
      onReauthenticate,
      policy: { UNAUTHENTICATED: "reauthenticate" },
      reauthenticateGraceMs: 0,
    });
    await expect(api.get("/me")).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(onReauthenticate).toHaveBeenCalledOnce();
  });

  it("retry does not replay non-idempotent methods by default", async () => {
    const onReport = vi.fn();
    const limited = () =>
      problemResponse(429, { status: 429, code: "RATE_LIMITED", title: "Rate limited" }, { "Retry-After": "0" });
    const { impl, calls } = fetchStub(limited(), limited());
    const api = createClient({ fetch: impl, onReport, policy: { RATE_LIMITED: "retry" } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(api.post("/orders", { sku: "widget" })).rejects.toMatchObject({ code: "RATE_LIMITED" });
      expect(calls).toHaveLength(1);
      expect(onReport).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });

  it("retry replays a non-idempotent call marked idempotent: true", async () => {
    const limited = () =>
      problemResponse(429, { status: 429, code: "RATE_LIMITED", title: "Rate limited" }, { "Retry-After": "0" });
    const { impl, calls } = fetchStub(limited(), Response.json({ ok: true }));
    const api = createClient({ fetch: impl, policy: { RATE_LIMITED: "retry" } });
    await expect(api.post("/orders", { sku: "widget" }, { idempotent: true })).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(2);
  });

  it("reauthenticate without a handler warns and falls back to report", async () => {
    const onReport = vi.fn();
    const { impl } = fetchStub(problemResponse(401, { status: 401, code: "UNAUTHENTICATED", title: "Unauthenticated" }));
    const api = createClient({ fetch: impl, onReport, policy: { UNAUTHENTICATED: "reauthenticate" } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(api.get("/me")).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
      expect(onReport).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });
});

describe(".safe()", () => {
  it("returns ok results and error results without throwing", async () => {
    const { impl } = fetchStub(
      Response.json({ id: "u_1" }),
      problemResponse(404, { status: 404, code: "USER_NOT_FOUND", title: "User not found" }),
    );
    const api = createClient({ fetch: impl, policy: { "*": "silent" } });

    const hit = await api.get<{ id: string }>("/users/u_1").safe();
    expect(hit).toEqual({ ok: true, data: { id: "u_1" } });

    const miss = await api.get("/users/u_2").safe();
    expect(miss.ok).toBe(false);
    if (!miss.ok) expect(miss.error.code).toBe("USER_NOT_FOUND");
  });

  it("does not swallow non-Api errors", async () => {
    const { impl } = fetchStub(Response.json({}));
    const api = createClient({
      fetch: impl,
      headers: () => {
        throw new RangeError("programmer error");
      },
    });
    // A throwing headers factory is a bug in the caller's code, not an API
    // failure — safe() must not convert it into a Result.
    await expect(api.get("/x").safe()).rejects.toBeInstanceOf(RangeError);
  });
});
