import { afterEach, expect, test } from "bun:test";
import { BusEvent } from "@oni/protocol";
import { z } from "zod";
import { Bus } from "./observation";

afterEach(() => Bus.reset());

const event = BusEvent.define("helper.observation", z.object({ sessionId: z.string(), value: z.number() }));

test("fanout validates and transforms once before matching and delivery", async () => {
  let parses = 0;
  const transformed = BusEvent.define("helper.transformed", event.schema.transform((data) => {
    parses += 1;
    return { ...data, value: data.value + 1 };
  }));
  const received: number[] = [];
  for (let index = 0; index < 100; index += 1)
    Bus.subscribe(transformed, (data) => received.push(data.value), { match: { value: 2 } });
  Bus.subscribe(transformed, () => { throw new Error("nonmatching subscriber delivered"); }, { match: { sessionId: "other" } });
  Bus.publish(transformed, { sessionId: "session", value: 1 });
  await Bus.flush();
  expect(parses).toBe(1);
  expect(received).toEqual(Array.from({ length: 100 }, () => 2));
});

test("invalid publications reject synchronously without poisoning delivery", async () => {
  const received: number[] = [];
  Bus.subscribe(event, (data) => received.push(data.value));
  expect(() => Bus.publish(event, { sessionId: "session", value: Number.NaN })).toThrow(z.ZodError);
  Bus.publish(event, { sessionId: "session", value: 1 });
  await Bus.flush();
  expect(received).toEqual([1]);
});

test("reset cancels queued delivery and stale unsubscribe preserves the new generation", async () => {
  const received: number[] = [];
  const stop = Bus.subscribe(event, (data) => received.push(data.value));
  Bus.publish(event, { sessionId: "old", value: 1 });
  const oldDelivery = Bus.flush();
  Bus.reset();
  const stopCurrent = Bus.subscribe(event, (data) => received.push(data.value));
  stop();
  expect(Bus.listenerCount()).toBe(1);
  Bus.publish(event, { sessionId: "new", value: 2 });
  await Promise.all([oldDelivery, Bus.flush()]);
  expect(received).toEqual([2]);
  stopCurrent();
  expect(Bus.listenerCount()).toBe(0);
});

test("queued publication retains its subscriber snapshot", async () => {
  const received: number[] = [];
  const stop = Bus.subscribe(event, (data) => received.push(data.value));
  Bus.publish(event, { sessionId: "session", value: 1 });
  stop();
  Bus.subscribe(event, (data) => received.push(data.value * 10));
  await Bus.flush();
  expect(received).toEqual([1]);
});
