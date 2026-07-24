import { describe, expect, it } from "vitest";
import {
  ApiError,
  BadRequest,
  isApiError,
  NotFound,
  RateLimited,
  Unauthenticated,
  ValidationFailed,
  humanizeCode,
  kebabCode,
} from "@boundaryjs/server";

describe("ApiError", () => {
  it("carries status, code, and a humanized default title", () => {
    const err = new ApiError(418, "TEAPOT_BUSY", "The teapot is busy.");
    expect(err.status).toBe(418);
    expect(err.code).toBe("TEAPOT_BUSY");
    expect(err.title).toBe("Teapot busy");
    expect(err.detail).toBe("The teapot is busy.");
    expect(err.message).toContain("The teapot is busy.");
  });

  it("is a real Error with a working cause chain", () => {
    const cause = new TypeError("boom");
    const err = new NotFound("ORDER_NOT_FOUND", "No such order.", { cause });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.cause).toBe(cause);
    expect(err.name).toBe("NotFound");
  });

  it("subclasses pin the status and provide default codes", () => {
    expect(new NotFound().status).toBe(404);
    expect(new NotFound().code).toBe("NOT_FOUND");
    expect(new Unauthenticated().code).toBe("UNAUTHENTICATED");
    expect(new BadRequest("MALFORMED_CURSOR").code).toBe("MALFORMED_CURSOR");
    expect(new ValidationFailed().status).toBe(422);
    expect(new RateLimited(undefined, undefined, { retryAfter: 30 }).retryAfter).toBe(30);
  });

  it("isApiError recognizes instances and cross-copy marked objects", () => {
    expect(isApiError(new NotFound())).toBe(true);
    expect(isApiError(new Error("nope"))).toBe(false);
    expect(isApiError(null)).toBe(false);
    expect(isApiError({ [Symbol.for("boundary.ApiError")]: true })).toBe(true);
  });
});

describe("code helpers", () => {
  it("humanizes SCREAMING_SNAKE codes", () => {
    expect(humanizeCode("ORDER_NOT_FOUND")).toBe("Order not found");
    expect(humanizeCode("RATE_LIMITED")).toBe("Rate limited");
  });

  it("kebab-cases codes for type URIs", () => {
    expect(kebabCode("ORDER_NOT_FOUND")).toBe("order-not-found");
  });
});
