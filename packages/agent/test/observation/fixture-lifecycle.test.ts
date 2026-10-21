import { describe, expect, it } from "bun:test";
import { BusEvent } from "@oni/protocol";
import { z } from "zod";
import { testBus } from "../helpers/isolated";

const TestEvent = BusEvent.define(
  "test.fixture.lifecycle",
  z.object({ sessionId: z.string(), value: z.number() }),
);

describe("test bus fixture lifecycle", () => {
  it("each fixture owns its own Scope: closing one releases its bus while a sibling keeps delivering", async () => {
    const closed = testBus();
    const live = testBus();
    const seenClosed: number[] = [];
    const seenLive: number[] = [];
    const closedFirst = Promise.withResolvers<void>();
    const liveSecond = Promise.withResolvers<void>();
    closed.subscribe(TestEvent, (data) => {
      seenClosed.push(data.value);
      closedFirst.resolve();
    });
    live.subscribe(TestEvent, (data) => {
      seenLive.push(data.value);
      if (data.value === 2) liveSecond.resolve();
    });
    closed.publish(TestEvent, { sessionId: "session-1", value: 1 });
    live.publish(TestEvent, { sessionId: "session-1", value: 1 });
    await closedFirst.promise;
    // Closing the fixture's Scope shuts its PubSub down and interrupts its
    // drains before the next publish — a post-close publish cannot enqueue,
    // so event 2 never reaches the closed fixture; the sibling is untouched.
    closed.close();
    closed.publish(TestEvent, { sessionId: "session-1", value: 2 });
    live.publish(TestEvent, { sessionId: "session-1", value: 2 });
    await liveSecond.promise;
    expect(seenClosed).toEqual([1]);
    expect(seenLive).toEqual([1, 2]);
    live.close();
  });
});
