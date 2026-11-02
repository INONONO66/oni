import { expect, test } from "bun:test";
import type { FailureClass } from "../../src/port";
import { decide, type Decision } from "../../src/router/decide";
import { classifyFailure } from "../../src/classify";
import { AuthResolutionError, ModelResolutionError } from "../../src/errors";
import { sdkError } from "../helpers/retry";

const rows: readonly {
  readonly name: string;
  readonly failure: FailureClass;
  readonly hint?: number;
  readonly expected: Decision;
}[] = [
  { name: "abort", failure: { kind: "aborted" }, expected: { action: "abort" } },
  { name: "overflow", failure: { kind: "overflow" }, expected: { action: "surface" } },
  ...[401, 403].map((status) => ({
    name: `auth ${status}`,
    failure: { kind: "terminal", reason: "validation_error", providerReason: "non_retryable", status } as const,
    expected: { action: "swap_credential", block: "auth" } as const,
  })),
  ...[400, 422].map((status) => ({
    name: `validation ${status}`,
    failure: { kind: "terminal", reason: "validation_error", providerReason: "non_retryable", status } as const,
    expected: { action: "surface" } as const,
  })),
  { name: "content policy", failure: { kind: "terminal", reason: "validation_error", providerReason: "content_policy" },
    expected: { action: "surface", pin: "refusal" } },
  { name: "billing", failure: { kind: "terminal", reason: "validation_error", providerReason: "billing" },
    expected: { action: "swap_credential", block: "billing" } },
  ...(["rate_limit", "overloaded"] as const).flatMap((providerReason) => [undefined, 0, 2000, 2001].map((hint) => ({
    name: `${providerReason} hint ${hint}`,
    failure: { kind: "retryable", reason: "transient_error", providerReason, instant: false } as const,
    hint,
    expected: hint !== undefined && hint <= 2000 ? { action: "surface" } as const
      : { action: "swap_credential", block: "rate_limit" } as const,
  }))),
  { name: "timeout", failure: { kind: "retryable", reason: "timeout", providerReason: "server_error", instant: false },
    expected: { action: "swap_credential", block: "transient" } },
  { name: "network", failure: { kind: "retryable", reason: "transient_error", providerReason: "server_error", instant: true },
    expected: { action: "swap_credential", block: "transient" } },
  { name: "server 5xx", failure: { kind: "retryable", reason: "transient_error", providerReason: "server_error", instant: false },
    expected: { action: "surface" } },
  { name: "retryable validation", failure: { kind: "retryable", reason: "validation_error", providerReason: "validation_error", instant: true },
    expected: { action: "surface" } },
  { name: "route 404", failure: { kind: "terminal", reason: "validation_error", providerReason: "non_retryable", status: 404 },
    expected: { action: "swap_model" } },
  { name: "proxy down", failure: { kind: "terminal", reason: "transient_error", providerReason: "non_retryable", detail: "unavailable" },
    expected: { action: "swap_model" } },
  { name: "terminal", failure: { kind: "terminal", reason: "transient_error", providerReason: "non_retryable" },
    expected: { action: "surface" } },
];

test.each([...rows])("$name before output uses its routing action", ({ failure, hint, expected }) => {
  expect(decide(failure, "pre_request", hint)).toEqual(expected);
});

test.each([...rows])("$name after output never swaps", ({ failure, hint }) => {
  expect(decide(failure, "streaming", hint)).toEqual({ action: failure.kind === "aborted" ? "abort" : "surface" });
});

test.each([
  { message: "monthly usage limit", statusCode: 429, isRetryable: true, block: "billing" },
  { message: '{"type":"error","error":{"type":"too_many_requests"}}', statusCode: 429, isRetryable: true, block: "rate_limit" },
  { message: "content_policy_violation", statusCode: 400, isRetryable: false, pin: "refusal" },
])("classifies provider aliases at the existing boundary: $message", ({ block, pin, ...input }) => {
  const decision = decide(classifyFailure({ error: sdkError(input) }), "pre_request");
  expect(decision).toEqual(block ? { action: "swap_credential", block } : { action: "surface", pin });
});

test.each(["ECONNREFUSED", "ENOTFOUND", "ECONNRESET", "ETIMEDOUT"])("classifies nested transport code %s", (code) => {
  const error = new Error("request failed", { cause: Object.assign(new Error("connection"), { code }) });
  expect(decide(classifyFailure({ error }), "pre_request").action)
    .toBe(code === "ECONNREFUSED" || code === "ENOTFOUND" ? "swap_model" : "swap_credential");
});

test("typed resolution failures join the same classification path", () => {
  expect(decide(classifyFailure({ error: new AuthResolutionError({
    message: "missing", provider: "direct", reason: "missing_auth",
  }) }), "pre_request")).toEqual({ action: "swap_credential", block: "auth" });
  expect(decide(classifyFailure({ error: new ModelResolutionError({
    message: "missing", provider: "direct", model: "x", reason: "model_not_found",
  }) }), "pre_request")).toEqual({ action: "swap_model" });
});

test.each([400, 401, 403, 404, 422])("status %s outranks a provider retry flag", (statusCode) => {
  const failure = classifyFailure({ error: sdkError({ message: "refused", statusCode, isRetryable: true }) });
  expect(failure).toMatchObject({ kind: "terminal", providerReason: "non_retryable", status: statusCode });
});
