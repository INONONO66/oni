import { expect, test } from "bun:test";
import { ChannelsFailure } from "@oni/channels";
import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { automationClock } from "../src/composition/automation-clock";
import { runEffect } from "./helpers/effect";

test("the scoped automation clock advances without ingress and reports failures", async () => {
  await runEffect(Effect.scoped(Effect.gen(function* () {
    const first = yield* Deferred.make<void>();
    const next = yield* Deferred.make<void>();
    const advances: number[] = [];
    const errors: string[] = [];
    let now = 0;
    const fiber = yield* automationClock({
      advance: (at) => Effect.gen(function* () {
        advances.push(at ?? -1);
        if (advances.length === 1) {
          yield* Deferred.succeed(first, undefined);
          return yield* Effect.fail(new ChannelsFailure({ operation: "fixture", cause: "failure" }));
        }
        yield* Deferred.succeed(next, undefined);
      }),
    }, () => now, (error) => errors.push(error._tag)).pipe(Effect.forkScoped);
    yield* Deferred.await(first);
    now = 10_000;
    yield* TestClock.adjust("1 second");
    yield* Deferred.await(next);
    expect(advances).toEqual([0, 10_000]);
    expect(errors).toEqual(["ChannelsFailure"]);
    yield* Fiber.interrupt(fiber);
    yield* TestClock.adjust("1 second");
    expect(advances).toHaveLength(2);
  })).pipe(Effect.provide(TestClock.layer())));
});
