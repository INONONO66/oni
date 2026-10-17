/**
 * Boundary refusals are typed replies, never defects: a malformed `Deliver`/`Resolve` body, a registered kind
 * carrying no control op, and a failed activation each reach the caller as a tagged error with a code.
 */
import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { Effect } from "effect";
import { SessionEntity } from "../../src/core/session/entity";
import { FenceRefused } from "../../src/core/store/errors";
import {
  clusterTempDir,
  readChain,
  runCluster,
  sendDeliver,
  sendPrompt,
  sendResolve,
  sessionFileFor,
} from "../helpers/cluster-runtime";
import { seedSessionWithOpenRequest } from "../helpers/seed-request";

const { dir, sessionsDir, catalogFile } = clusterTempDir("a5-typed-refusals-");
const options = { sessionsDir, catalogFile };

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const rawDeliver = (sessionId: string, body: string, source: string) =>
  Effect.gen(function* () {
    const makeClient = yield* SessionEntity.client;
    return yield* makeClient(sessionId).Deliver({ kind: "prompt", body, source, idempotencyKey: `${body}|${source}` });
  });

test("a malformed Deliver body or source is refused `malformed_body` with zero new facts", async () => {
  const sessionId = "malformed-deliver";
  const file = sessionFileFor(sessionsDir, sessionId);
  const { body, source, before, after } = await runCluster(options, Effect.gen(function* () {
    yield* sendPrompt(sessionId, "seed", "seed");
    const before = readChain(file, sessionId).length;
    const body = yield* rawDeliver(sessionId, "{not json", "{}").pipe(Effect.flip);
    const source = yield* rawDeliver(sessionId, JSON.stringify({ content: "x" }), "{not json").pipe(Effect.flip);
    return { body, source, before, after: readChain(file, sessionId).length };
  }));
  expect(body).toMatchObject({ _tag: "DeliverRefused", code: "malformed_body" });
  expect(source).toMatchObject({ _tag: "DeliverRefused", code: "malformed_body" });
  expect(after).toBe(before);
});

test("a registered non-prompt kind without a control op is refused `malformed_body`", async () => {
  const sessionId = "registered-no-control";
  const refusal = await runCluster(
    { ...options, inputRegistrations: ["prompt", "signal", "webhook"] },
    sendDeliver(sessionId, { kind: "webhook", idempotencyKey: "w1", content: "payload" }).pipe(Effect.flip),
  );
  expect(refusal).toMatchObject({ _tag: "DeliverRefused", code: "malformed_body" });
});

test("a malformed Resolve payload is refused `malformed_body` and the request stays open", async () => {
  const sessionId = "malformed-resolve";
  await seedSessionWithOpenRequest({ sessionsDir, catalogFile, sessionId, requestId: "req-open" });
  const before = readChain(sessionFileFor(sessionsDir, sessionId), sessionId).length;
  const { resolved, cancelled } = await runCluster(options, Effect.gen(function* () {
    const resolved = yield* sendResolve(sessionId, {
      requestId: "req-open", outcome: "resolved", payload: "{not json", inputId: "bad-1",
    }).pipe(Effect.flip);
    const cancelled = yield* sendResolve(sessionId, {
      requestId: "req-open", outcome: "cancelled", payload: JSON.stringify({ kind: "nobody" }), inputId: "bad-2",
    }).pipe(Effect.flip);
    return { resolved, cancelled };
  }));
  expect(resolved).toMatchObject({ _tag: "ResolveRefused", code: "malformed_body" });
  expect(cancelled).toMatchObject({ _tag: "ResolveRefused", code: "malformed_body" });
  expect(readChain(sessionFileFor(sessionsDir, sessionId), sessionId).length).toBe(before);
});

test("a failed activation refuses every request `activation` and is built exactly once", async () => {
  let builds = 0;
  const ready = Effect.suspend(() => {
    builds += 1;
    return Effect.die(new Error("activation poison"));
  });
  const { first, second } = await runCluster({ ...options, ready }, Effect.gen(function* () {
    // The cap is a failure guard: an unbounded rebuild loop never replies.
    const first = yield* sendPrompt("poisoned", "p1", "hello").pipe(Effect.flip, Effect.timeout("10 seconds"));
    const second = yield* sendPrompt("poisoned", "p2", "again").pipe(Effect.flip, Effect.timeout("10 seconds"));
    return { first, second };
  }));
  expect(first).toMatchObject({ _tag: "AdmissionFailure", code: "activation" });
  expect(second).toMatchObject({ _tag: "AdmissionFailure", code: "activation" });
  expect(builds).toBe(1);
});

test("a FenceRefused activation re-raises: the rebuild adopts the session and no request is refused", async () => {
  let builds = 0;
  const ready = Effect.suspend(() => {
    builds += 1;
    return builds === 1
      ? Effect.die(new FenceRefused({ sessionId: "fenced", reason: "stale", holder: "later", fence: 2, expiresAt: null }))
      : Effect.void;
  });
  const reply = await runCluster({ ...options, ready }, sendPrompt("fenced", "f1", "hello"));
  expect(reply.existed).toBe(false);
  expect(builds).toBe(2);
});
