import { expect, test } from "bun:test";
import { Deferred, Effect } from "effect";
import { Auth, ModelUnavailable } from "../../src";
import { usePrivateCatalog } from "../helpers/catalog";
import { runEffect } from "../helpers/native";
import { apiError } from "../helpers/retry";
import { connectionRefused, failed, harness, success } from "./fixtures";

usePrivateCatalog();

const auths = ["one", "two", "three"].map((key) => ({ type: "api" as const, key }));
const pool = {
  chains: [{ primary: "proxy/x", selectors: ["proxy/x"] }],
  credentials: auths.map((auth) => ({ provider: "proxy", auth })),
};

test("auth failure rotates to a sibling and successful credentials retain affinity", async () => {
  const h = harness(pool);
  const denied = apiError({ message: "denied", statusCode: 401, isRetryable: false });
  const outcome = await h.run((request) => h.calls === 1 ? failed(denied) : success(request));
  const second = `proxy:${Auth.reference({ type: "api", key: "two" }).fingerprint}`;
  expect(outcome).toMatchObject({ type: "stop", routing: { attempts: [
    { action: "try" }, { action: "swap_credential" }, { credential: second, action: "try" }, { action: "selected" },
  ] } });
  expect(await h.run(success)).toMatchObject({ routing: { attempts: [
    { credential: second, action: "try" }, { credential: second, action: "selected" },
  ] } });
  h.advance(60_000);
  h.input.trace.sessionId = "another-session";
  expect(await h.run(success)).toMatchObject({ routing: { attempts: [
    { credential: `proxy:${Auth.reference({ type: "api", key: "one" }).fingerprint}`, action: "try" },
    { action: "selected" },
  ] } });
});

test("usage reset determines reopening rather than the circuit base cooldown", async () => {
  const h = harness(pool);
  const exhausted = apiError({ message: "monthly usage limit", statusCode: 429, isRetryable: true,
    responseHeaders: { "retry-after-ms": "9000" } });
  await expect(h.run(() => failed(exhausted))).rejects.toMatchObject({ _tag: "ModelUnavailable", openUntil: 9000 });
  expect(h.calls).toBe(3);
  h.advance(8999);
  await expect(h.run(success)).rejects.toBeInstanceOf(ModelUnavailable);
  expect(h.calls).toBe(3);
  h.advance(1);
  expect(await h.run(success)).toMatchObject({ type: "stop" });
});

test("transport blips try only one sibling before surfacing", async () => {
  const h = harness(pool);
  const reset = Object.assign(new Error("reset"), { code: "ECONNRESET" });
  expect(await h.run(() => failed(reset))).toMatchObject({ type: "error", routing: { attempts: [
    { action: "try" }, { action: "swap_credential" }, { action: "try" }, { action: "surface" },
  ] } });
  expect(h.calls).toBe(2);
});

test("short rate-limit hints surface without consuming another credential", async () => {
  const h = harness(pool);
  const limited = apiError({ message: "limited", statusCode: 429, isRetryable: true,
    responseHeaders: { "retry-after-ms": "2000" } });
  expect(await h.run(() => failed(limited))).toMatchObject({ type: "error" });
  expect(h.calls).toBe(1);
});

test("only one concurrent call obtains an expired circuit probe", async () => {
  const h = harness();
  await expect(h.run(() => failed(connectionRefused()))).rejects.toBeInstanceOf(ModelUnavailable);
  h.advance(60_000);
  const entered = await runEffect(Deferred.make<void>());
  const release = await runEffect(Deferred.make<void>());
  const first = h.run((request) => Effect.gen(function* () {
    yield* Deferred.succeed(entered, undefined);
    yield* Deferred.await(release);
    return yield* success(request);
  }));
  await runEffect(Deferred.await(entered));
  try {
    const second = await h.run(() => failed(connectionRefused())).catch((error: ModelUnavailable) => error);
    expect(second).toMatchObject({ _tag: "ModelUnavailable", routing: { attempts: [
      { candidate: "proxy/x", action: "skip_circuit" },
      { candidate: "direct/x", action: "try" },
      { candidate: "direct/x", action: "swap_model" },
    ] } });
  } finally {
    await runEffect(Deferred.succeed(release, undefined));
  }
  expect(await first).toMatchObject({ type: "stop", routing: { selected: "proxy/x" } });
});

test("an older call cannot release a newer half-open circuit probe", async () => {
  const h = harness({ chains: [{ primary: "proxy/x", selectors: ["proxy/x"] }],
    credentials: [{ provider: "proxy", auth: { type: "api", key: "one" } }] });
  const oldEntered = await runEffect(Deferred.make<void>());
  const oldRelease = await runEffect(Deferred.make<void>());
  const controller = new AbortController();
  h.input.signal = controller.signal;
  const old = h.run((request) => Effect.gen(function* () {
    yield* Deferred.succeed(oldEntered, undefined);
    yield* Deferred.await(oldRelease);
    return yield* success(request);
  }));
  await runEffect(Deferred.await(oldEntered));
  h.input.signal = undefined;
  await expect(h.run(() => failed(connectionRefused()))).rejects.toBeInstanceOf(ModelUnavailable);
  h.advance(60_000);
  const probeEntered = await runEffect(Deferred.make<void>());
  const probeRelease = await runEffect(Deferred.make<void>());
  const probe = h.run((request) => Effect.gen(function* () {
    yield* Deferred.succeed(probeEntered, undefined);
    yield* Deferred.await(probeRelease);
    return yield* success(request);
  }));
  await runEffect(Deferred.await(probeEntered));
  controller.abort();
  await runEffect(Deferred.succeed(oldRelease, undefined));
  expect(await old).toMatchObject({ type: "aborted" });
  try {
    await expect(h.run(success)).rejects.toBeInstanceOf(ModelUnavailable);
    expect(h.calls).toBe(3);
  } finally {
    await runEffect(Deferred.succeed(probeRelease, undefined));
    await probe;
  }
});

test("an older call cannot release another selector's credential re-probe", async () => {
  const h = harness({ chains: [
    { primary: "proxy/x", selectors: ["proxy/x"] },
    { primary: "proxy/y", selectors: ["proxy/y"] },
  ], credentials: [{ provider: "proxy", auth: { type: "api", key: "one" } }] });
  const oldEntered = await runEffect(Deferred.make<void>());
  const oldRelease = await runEffect(Deferred.make<void>());
  const controller = new AbortController();
  h.input.signal = controller.signal;
  const old = h.run((request) => Effect.gen(function* () {
    yield* Deferred.succeed(oldEntered, undefined);
    yield* Deferred.await(oldRelease);
    return yield* success(request);
  }));
  await runEffect(Deferred.await(oldEntered));
  h.input.signal = undefined;
  h.input.model = { id: "y", providerID: "proxy", name: "y" };
  await expect(h.run(() => failed(apiError({ message: "denied", statusCode: 401, isRetryable: false }))))
    .rejects.toBeInstanceOf(ModelUnavailable);
  h.advance(60_000);
  h.input.model = { id: "x", providerID: "proxy", name: "x" };
  const probeEntered = await runEffect(Deferred.make<void>());
  const probeRelease = await runEffect(Deferred.make<void>());
  const probe = h.run((request) => Effect.gen(function* () {
    yield* Deferred.succeed(probeEntered, undefined);
    yield* Deferred.await(probeRelease);
    return yield* success(request);
  }));
  await runEffect(Deferred.await(probeEntered));
  controller.abort();
  await runEffect(Deferred.succeed(oldRelease, undefined));
  expect(await old).toMatchObject({ type: "aborted" });
  try {
    await expect(h.run(success)).rejects.toBeInstanceOf(ModelUnavailable);
    expect(h.calls).toBe(3);
  } finally {
    await runEffect(Deferred.succeed(probeRelease, undefined));
    await probe;
  }
});

test("a failed half-open server probe reopens with the next cooldown", async () => {
  const h = harness({ chains: [{ primary: "proxy/x", selectors: ["proxy/x"] }],
    credentials: [{ provider: "proxy", auth: { type: "api", key: "one" } }] });
  await expect(h.run(() => failed(connectionRefused()))).rejects.toBeInstanceOf(ModelUnavailable);
  h.advance(60_000);
  const unavailable = apiError({ message: "unavailable", statusCode: 503, isRetryable: true });
  expect(await h.run(() => failed(unavailable))).toMatchObject({ type: "error" });
  await expect(h.run(success)).rejects.toMatchObject({ _tag: "ModelUnavailable", openUntil: 180_000 });
  expect(h.calls).toBe(2);
});

test("shared blocked credential supplies the earliest usable candidate deadline", async () => {
  const h = harness({ chains: [{ primary: "proxy/x", selectors: ["proxy/x", "proxy/y"] }],
    credentials: [{ provider: "proxy", auth: { type: "api", key: "one" } }] });
  const billed = apiError({ message: "monthly usage limit", statusCode: 429, isRetryable: true,
    responseHeaders: { "retry-after-ms": "900000" } });
  await expect(h.run(() => failed(billed))).rejects.toMatchObject({
    _tag: "ModelUnavailable", openUntil: 900_000,
  });
  expect(h.calls).toBe(1);
});

test.each([undefined, "60000"])("billing fallback pin with reset %s restores only recoverable originals", async (reset) => {
  const h = harness();
  const exhausted = apiError({ message: "billing required", statusCode: 402, isRetryable: false,
    ...(reset === undefined ? {} : { responseHeaders: { "retry-after-ms": reset } }),
  });
  await h.run((request) => h.calls === 1 ? failed(exhausted) : success(request));
  h.advance(60_000);
  h.input.trace.runId = "next-turn";
  expect(await h.run(success)).toMatchObject({ routing: { selected: reset === undefined ? "direct/x" : "proxy/x" } });
});
