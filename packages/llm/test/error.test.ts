
import { describe, expect, test } from "bun:test";
import { Effect, Result } from "effect";
import { coerceApiError, decodeLlmFailure } from "../src/error";
import { LlmOperationFailure, ModelCatalogError } from "../src/errors";
import { apiError, sdkError } from "./helpers/retry";
import { runSyncEffect } from "./helpers/native";

describe("provider failure decoder", () => {
  test("unwraps a tagged provider failure to its SDK cause", () => {
    const error = apiError({ message: "boom", isRetryable: true });
    expect(coerceApiError(error)).toBe(error.cause);
    expect(runSyncEffect(Effect.result(error))).toEqual(Result.fail(error));
  });
  test("returns the SDK error itself with its provider facts intact", () => {
    const failure = sdkError({ message: "sdk fixture", isRetryable: true, statusCode: 529, responseHeaders: { "retry-after-ms": "1200" }, responseBody: '{"type":"error"}' });
    const coerced = coerceApiError(failure);
    expect(coerced).toBe(failure);
    expect(coerced).toMatchObject({ message: "sdk fixture", isRetryable: true, statusCode: 529, responseHeaders: { "retry-after-ms": "1200" }, responseBody: '{"type":"error"}' });
  });
  test.each([
    new Error("plain"),
    "string error",
    null,
    { message: "missing retry flag" },
    Object.assign(new Error("x"), { name: "AI_APICallError", isRetryable: true }),
  ])("declines values that are not SDK APICallErrors: %j", (value) => {
    expect(coerceApiError(value)).toBeUndefined();
  });
  test("provider facts live on the SDK cause, never copied onto the wrapper", () => {
    const facts = { statusCode: 500, isRetryable: true, responseHeaders: { "content-type": "application/json" }, responseBody: '{"error":"internal"}' };
    const error = apiError({ message: "API request failed", ...facts });
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("API request failed");
    expect(error.cause).toMatchObject(facts);
    for (const key of Object.keys(facts)) expect(Reflect.has(error, key)).toBe(false);
    expect("data" in error).toBe(false);
  });
  test("minimal fields have no invented provider metadata", () => {
    const error = apiError({ message: "API error", isRetryable: false });
    expect(error.cause.isRetryable).toBe(false);
    for (const key of ["statusCode", "responseHeaders", "responseBody", "metadata"]) expect(Reflect.has(error, key)).toBe(false);
  });
  test.each([null, false, 42, "diagnostic", { malformed: true }])("unrepresentable failures preserve a string cause: %j", (value) => {
    const error = decodeLlmFailure("provider.decode")(value);
    expect(error).toBeInstanceOf(LlmOperationFailure);
    expect(error.cause).toBe(String(value));
  });
});

describe("ModelCatalogError.fromThrown", () => {
  // A revoked Proxy throws on `instanceof` and on `String()`, so the thrown value
  // itself is unrepresentable; the refusal still carries a bounded diagnostic.
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  test.each([
    ["an Error", new Error("disk full"), "Error: disk full"],
    ["a string", "ENOENT", "Error: ENOENT"],
    ["a revoked Proxy", revoked.proxy, "Error: sink threw an unrepresentable object"],
  ])("renders %s as one typed cache refusal", (_case, thrown, message) => {
    const error = ModelCatalogError.fromThrown("cache", "/tmp/models.json", thrown);
    expect(error._tag).toBe("ModelCatalogError");
    expect(error.source).toBe("cache");
    expect(error.path).toBe("/tmp/models.json");
    expect(error.cause).toBeInstanceOf(Error);
    expect(error.message).toBe(message);
  });
});
