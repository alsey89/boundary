/**
 * boundary-conform — black-box conformance checks for the Boundary error
 * contract. Language-agnostic by construction: it only speaks HTTP.
 */
import { scanForLeaks, type LeakHit } from "./leaks.js";

export { LEAK_PATTERNS, scanForLeaks } from "./leaks.js";
export type { LeakHit, LeakPattern } from "./leaks.js";

/** One request the suite should make to provoke a specific failure. */
export interface ProbeRequest {
  method?: string;
  path: string;
  /** JSON-serialized as the request body when present. */
  body?: unknown;
  headers?: Record<string, string>;
}

export interface ConformConfig {
  probes?: {
    /** Overrides the default random-path 404 probe. */
    notFound?: ProbeRequest;
    /** A request that must fail validation with 422 + errors[]. */
    validation?: ProbeRequest;
    /** A request that must return 429. */
    rateLimited?: ProbeRequest;
    /** A request that must return 503. */
    unavailable?: ProbeRequest;
    /** A request your framework answers with a redirect (3xx). */
    redirect?: ProbeRequest;
    /** Extra error-producing requests to include in the leak scan. */
    errors?: ProbeRequest[];
  };
  /** Regex sources; leak-scan matches that also match one of these are ignored. */
  leakAllow?: string[];
  /**
   * Response header the trace-correlation check reads. Default
   * "X-Trace-Id". Set it only if the server is configured with a
   * non-default `traceHeader`.
   */
  traceHeader?: string;
}

export interface CheckResult {
  id: string;
  title: string;
  status: "pass" | "fail" | "skip";
  details?: string[];
}

export interface ConformReport {
  baseUrl: string;
  results: CheckResult[];
  passed: number;
  failed: number;
  skipped: number;
  ok: boolean;
}

interface Observation {
  label: string;
  method: string;
  path: string;
  status: number;
  contentType: string;
  headers: Headers;
  bodyText: string;
  problem?: Record<string, unknown>;
}

const PROBLEM_TYPE = "application/problem+json";

function isProblemContentType(contentType: string): boolean {
  return contentType.toLowerCase().split(";")[0]!.trim() === PROBLEM_TYPE;
}

function parseRetryAfter(value: string): boolean {
  if (/^\d+$/.test(value.trim())) return true;
  return !Number.isNaN(Date.parse(value));
}

function randomPath(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  let suffix = "";
  for (const b of bytes) suffix += b.toString(16).padStart(2, "0");
  return `/__boundary_conform__/${suffix}`;
}

export async function runConformance(
  baseUrl: string,
  config: ConformConfig = {},
  options: { fetch?: typeof fetch } = {},
): Promise<ConformReport> {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const base = baseUrl.replace(/\/+$/, "");
  const results: CheckResult[] = [];
  const observations: Observation[] = [];

  async function probe(label: string, req: ProbeRequest, redirect: RequestRedirect = "follow"): Promise<Observation> {
    const method = (req.method ?? "GET").toUpperCase();
    const headers = new Headers(req.headers ?? {});
    const init: RequestInit = { method, headers, redirect };
    if (req.body !== undefined) {
      if (!headers.has("content-type")) headers.set("Content-Type", "application/json");
      init.body = JSON.stringify(req.body);
    }
    const response = await fetchImpl(base + req.path, init);
    const bodyText = await response.text();
    let problem: Record<string, unknown> | undefined;
    try {
      const parsed: unknown = JSON.parse(bodyText);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        problem = parsed as Record<string, unknown>;
      }
    } catch {
      // not JSON — fine, checks assert on content-type explicitly
    }
    const obs: Observation = {
      label,
      method,
      path: req.path,
      status: response.status,
      contentType: response.headers.get("content-type") ?? "",
      headers: response.headers,
      bodyText,
      problem,
    };
    observations.push(obs);
    return obs;
  }

  /** Assert the RFC 9457 + Boundary shape of one error observation. */
  function problemShapeIssues(obs: Observation, expectedStatus?: number): string[] {
    const issues: string[] = [];
    const where = `${obs.method} ${obs.path}`;
    if (expectedStatus !== undefined && obs.status !== expectedStatus) {
      issues.push(`${where}: expected status ${expectedStatus}, got ${obs.status}`);
    }
    if (!isProblemContentType(obs.contentType)) {
      issues.push(`${where}: Content-Type is ${JSON.stringify(obs.contentType)}, expected ${PROBLEM_TYPE}`);
      return issues;
    }
    const p = obs.problem;
    if (!p) {
      issues.push(`${where}: body is not a JSON object`);
      return issues;
    }
    if (typeof p.type !== "string" || p.type.length === 0) issues.push(`${where}: missing "type" member`);
    if (typeof p.title !== "string" || p.title.length === 0) issues.push(`${where}: missing "title" member`);
    if (p.status !== obs.status) issues.push(`${where}: body "status" (${String(p.status)}) != HTTP status (${obs.status})`);
    if (typeof p.code !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(p.code)) {
      issues.push(`${where}: "code" must be a stable SCREAMING_SNAKE string, got ${JSON.stringify(p.code)}`);
    }
    return issues;
  }

  // ── 404 emits application/problem+json with a stable code ──────────────
  const notFoundProbe = config.probes?.notFound ?? { method: "GET", path: randomPath() };
  try {
    const first = await probe("not-found", notFoundProbe);
    const second = await probe("not-found (repeat)", notFoundProbe);
    const issues = [...problemShapeIssues(first, 404), ...problemShapeIssues(second, 404)];
    if (issues.length === 0 && first.problem!.code !== second.problem!.code) {
      issues.push(
        `code is not stable across identical requests: ${JSON.stringify(first.problem!.code)} vs ${JSON.stringify(second.problem!.code)}`,
      );
    }
    results.push({
      id: "not-found-problem",
      title: "404 emits application/problem+json with a stable code",
      status: issues.length === 0 ? "pass" : "fail",
      details: issues.length > 0 ? issues : undefined,
    });
  } catch (error) {
    results.push({
      id: "not-found-problem",
      title: "404 emits application/problem+json with a stable code",
      status: "fail",
      details: [`request failed: ${error instanceof Error ? error.message : String(error)}`],
    });
  }

  // ── 422 carries field-level errors[] ────────────────────────────────────
  if (config.probes?.validation) {
    try {
      const obs = await probe("validation", config.probes.validation);
      const issues = problemShapeIssues(obs, 422);
      const errors = obs.problem?.errors;
      if (!Array.isArray(errors) || errors.length === 0) {
        issues.push(`body "errors" must be a non-empty array of field errors`);
      } else {
        for (const [i, entry] of errors.entries()) {
          const e = entry as Record<string, unknown>;
          if (typeof e?.field !== "string" || typeof e?.message !== "string") {
            issues.push(`errors[${i}] must carry string "field" and "message"`);
          }
        }
      }
      results.push({
        id: "validation-errors",
        title: "422 carries field-level errors[]",
        status: issues.length === 0 ? "pass" : "fail",
        details: issues.length > 0 ? issues : undefined,
      });
    } catch (error) {
      results.push({
        id: "validation-errors",
        title: "422 carries field-level errors[]",
        status: "fail",
        details: [`request failed: ${error instanceof Error ? error.message : String(error)}`],
      });
    }
  } else {
    results.push({
      id: "validation-errors",
      title: "422 carries field-level errors[]",
      status: "skip",
      details: ["no probes.validation configured"],
    });
  }

  // ── Retry-After present on 429 and 503 ──────────────────────────────────
  const retryProbes: Array<[string, ProbeRequest | undefined, number]> = [
    ["429", config.probes?.rateLimited, 429],
    ["503", config.probes?.unavailable, 503],
  ];
  if (retryProbes.every(([, p]) => !p)) {
    results.push({
      id: "retry-after",
      title: "Retry-After present on 429 and 503",
      status: "skip",
      details: ["no probes.rateLimited / probes.unavailable configured"],
    });
  } else {
    const issues: string[] = [];
    for (const [label, probeReq, expectedStatus] of retryProbes) {
      if (!probeReq) continue;
      try {
        const obs = await probe(`retry-after ${label}`, probeReq);
        issues.push(...problemShapeIssues(obs, expectedStatus));
        const retryAfter = obs.headers.get("retry-after");
        if (!retryAfter) {
          issues.push(`${obs.method} ${obs.path}: no Retry-After header on ${expectedStatus}`);
        } else if (!parseRetryAfter(retryAfter)) {
          issues.push(`${obs.method} ${obs.path}: Retry-After ${JSON.stringify(retryAfter)} is neither delta-seconds nor an HTTP-date`);
        }
      } catch (error) {
        issues.push(`${label} probe failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    results.push({
      id: "retry-after",
      title: "Retry-After present on 429 and 503",
      status: issues.length === 0 ? "pass" : "fail",
      details: issues.length > 0 ? issues : undefined,
    });
  }

  // ── framework redirect() passes through untouched ───────────────────────
  if (config.probes?.redirect) {
    try {
      const obs = await probe("redirect", config.probes.redirect, "manual");
      const issues: string[] = [];
      if (![301, 302, 303, 307, 308].includes(obs.status)) {
        issues.push(`expected a 3xx redirect, got ${obs.status}`);
      }
      if (!obs.headers.get("location")) issues.push("no Location header on redirect");
      if (isProblemContentType(obs.contentType)) {
        issues.push("redirect was converted to problem+json — redirects must pass through the sink untouched");
      }
      results.push({
        id: "redirect-passthrough",
        title: "framework redirect() passes through untouched",
        status: issues.length === 0 ? "pass" : "fail",
        details: issues.length > 0 ? issues : undefined,
      });
    } catch (error) {
      results.push({
        id: "redirect-passthrough",
        title: "framework redirect() passes through untouched",
        status: "fail",
        details: [`request failed: ${error instanceof Error ? error.message : String(error)}`],
      });
    }
  } else {
    results.push({
      id: "redirect-passthrough",
      title: "framework redirect() passes through untouched",
      status: "skip",
      details: ["no probes.redirect configured"],
    });
  }

  // ── extra error probes, captured for trace + leak checks ────────────────
  for (const [i, extra] of (config.probes?.errors ?? []).entries()) {
    try {
      await probe(`errors[${i}]`, extra);
    } catch (error) {
      results.push({
        id: `extra-error-${i}`,
        title: `error probe ${extra.method ?? "GET"} ${extra.path}`,
        status: "fail",
        details: [`request failed: ${error instanceof Error ? error.message : String(error)}`],
      });
    }
  }

  // ── traceId in header and body match ────────────────────────────────────
  {
    const traceHeader = config.traceHeader ?? "X-Trace-Id";
    const problems = observations.filter((o) => isProblemContentType(o.contentType) && o.problem);
    const issues: string[] = [];
    if (problems.length === 0) {
      issues.push("no problem+json responses observed to check");
    }
    for (const obs of problems) {
      const where = `${obs.method} ${obs.path}`;
      const headerId = obs.headers.get(traceHeader);
      const bodyId = obs.problem!.traceId;
      if (!headerId) issues.push(`${where}: no ${traceHeader} header`);
      if (typeof bodyId !== "string" || bodyId.length === 0) issues.push(`${where}: no traceId in body`);
      if (headerId && typeof bodyId === "string" && headerId !== bodyId) {
        issues.push(`${where}: header ${traceHeader} (${headerId}) != body traceId (${bodyId})`);
      }
    }
    results.push({
      id: "trace-correlation",
      title: "traceId in header and body match",
      status: issues.length === 0 ? "pass" : "fail",
      details: issues.length > 0 ? issues : undefined,
    });
  }

  // ── no stack trace, SQL, or hostname in any error body ──────────────────
  {
    const allow = (config.leakAllow ?? []).map((source) => new RegExp(source));
    const errorBodies = observations.filter((o) => o.status >= 400);
    const issues: string[] = [];
    for (const obs of errorBodies) {
      const hits: LeakHit[] = scanForLeaks(obs.bodyText, allow);
      for (const hit of hits) {
        issues.push(`${obs.method} ${obs.path}: ${hit.description} (${hit.patternId}): …${hit.snippet}…`);
      }
    }
    results.push({
      id: "leak-scan",
      title: "no stack trace, SQL, or hostname in any error body — any NODE_ENV",
      status: issues.length === 0 ? "pass" : "fail",
      details: issues.length > 0 ? issues : undefined,
    });
  }

  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.filter((r) => r.status === "fail").length;
  const skipped = results.filter((r) => r.status === "skip").length;
  return { baseUrl: base, results, passed, failed, skipped, ok: failed === 0 };
}
