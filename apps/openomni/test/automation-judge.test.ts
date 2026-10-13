import { expect, test } from "bun:test";
import { Core, Model } from "@openomni/agent";
import { Ingress } from "@openomni/protocol";
import { type Context, Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { automationJudge } from "../src/composition/automation-judge";
import { assistantMessage } from "./helpers/assistant-message";
import { runEffect } from "./helpers/effect";
import { observationService } from "../../../packages/agent/test/helpers/service-layers";

const event = Ingress.Input.parse({
  eventId: "event", surface: "discord", event: "message", author: { externalId: "user", isBot: false },
  dm: false, mentionsBot: false, body: "EVIDENCE", receivedAt: 100,
});
function judgeWith(run: Context.Service.Shape<typeof Model.Llm>["run"]) {
  return automationJudge({ provider: "test", id: "primary", fastId: "fast", apiKey: "secret" }, {
    now: () => 100, id: () => crypto.randomUUID(),
  }).pipe(
    Effect.provideService(Model.Llm, {
      run,
      resolveModel: (ref) => Effect.succeed({ id: ref.id, providerID: ref.provider, name: ref.id }),
    }),
    Effect.provideService(Core.ObservationSink, observationService({ publish: () => undefined })),
  );
}

test.each([["yes", "yes"], ["no", "no"], ["garbage", "unknown"], ["YES", "unknown"], ["yes no", "unknown"]] as const)(
  "judge parses %s as %s and uses bounded deterministic model arguments", async (text, verdict) => {
    const calls: Model.RunInput[] = [];
    const judge = await runEffect(judgeWith((input, sink) => Effect.sync(() => {
      calls.push(input);
      sink.onMessage(assistantMessage(input, { text }));
      return { type: "stop" as const };
    })));
    expect(await runEffect(judge("q".repeat(3000), { ...event, body: "b".repeat(20_000) }))).toBe(verdict);
    expect(calls[0]).toMatchObject({ model: { id: "fast" }, temperature: 0, maxTokens: 2, toolChoice: "none", tools: [] });
    const sent = calls[0]?.messages[0]?.parts[0];
    expect(sent?.type === "text" && sent.text.length <= 16_385).toBe(true);
  },
);

test("a bounded timeout cancels the exact running call and returns unknown", async () => {
  await runEffect(Effect.scoped(Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const cancelled = yield* Deferred.make<void>();
    const judge = yield* judgeWith(() =>
      Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() => Deferred.succeed(cancelled, undefined)),
      ));
    const fiber = yield* judge("ready?", event).pipe(Effect.forkScoped);
    yield* Deferred.await(entered);
    yield* TestClock.adjust("5 seconds");
    expect(yield* Fiber.join(fiber)).toBe("unknown");
    yield* Deferred.await(cancelled);
  })).pipe(Effect.provide(TestClock.layer())));
});

test("provider refusal and failure never become yes", async () => {
  const judge = await runEffect(judgeWith(() => Effect.succeed({ type: "aborted" as const })));
  expect(await runEffect(judge("ready?", event))).toBe("unknown");
});
