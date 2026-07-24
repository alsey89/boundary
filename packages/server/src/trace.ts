import { trace, SpanStatusCode, type AttributeValue } from "@opentelemetry/api";
import type { ApiError } from "./error.js";

const INVALID_TRACE_ID = "0".repeat(32);

/** Random, W3C-valid 128-bit trace id for when no OTel SDK is wired up. */
export function randomTraceId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  if (out === INVALID_TRACE_ID) return randomTraceId();
  return out;
}

function toAttributeValue(value: unknown): AttributeValue {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Route an ApiError's identity and debug context to the active OTel span.
 * Returns the trace id to correlate the response with — the active span's
 * if one exists, otherwise a fresh random id (so header/body correlation
 * with the emitted log record still holds without an OTel SDK).
 */
export function recordToSpan(error: ApiError): string {
  const span = trace.getActiveSpan();
  if (!span) return randomTraceId();

  const spanContext = span.spanContext();
  span.setAttribute("boundary.error.code", error.code);
  span.setAttribute("boundary.error.status", error.status);
  if (error.log) {
    for (const [key, value] of Object.entries(error.log)) {
      span.setAttribute(`boundary.log.${key}`, toAttributeValue(value));
    }
  }
  if (error.status >= 500) {
    span.recordException(error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.code });
  }

  const traceId = spanContext.traceId;
  return traceId && traceId !== INVALID_TRACE_ID ? traceId : randomTraceId();
}
