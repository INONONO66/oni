import { expect, test } from "bun:test";
import { ClockSamples, capturedAt, clockSample } from "../src/clock-samples";

test("minimum RTT sample maps client capture into host wall time", () => {
  const history = new ClockSamples();
  const slow = clockSample({ status: "alive", receivedAtUs: 1_000_000, sentAtUs: 1_000_200 }, 2000, 2040);
  const fast = clockSample({ status: "alive", receivedAtUs: 2_000_000, sentAtUs: 2_000_100 }, 3000, 3004);
  expect(slow).toEqual({ clockOffsetMs: 1019.9, rttMs: 40 });
  expect(fast).toEqual({ clockOffsetMs: 1001.95, rttMs: 4 });
  if (slow === undefined || fast === undefined) throw new Error("valid samples required");
  history.add(slow);
  history.add(fast);
  expect(history.best()).toEqual(fast);
  expect(capturedAt(2_500_000, fast.clockOffsetMs)).toBe(3501.95);
});

test("untimed and reversed ping replies cannot produce clock offsets", () => {
  expect(clockSample({ status: "alive" }, 100, 101)).toBeUndefined();
  expect(clockSample({ status: "alive", receivedAtUs: 200, sentAtUs: 100 }, 100, 101)).toBeUndefined();
  expect(clockSample({ status: "alive", receivedAtUs: 100, sentAtUs: 200 }, 102, 101)).toBeUndefined();
  expect(new ClockSamples().best()).toBeUndefined();
});

test("bounded history forgets an old minimum RTT", () => {
  const history = new ClockSamples();
  history.add({ clockOffsetMs: 100, rttMs: 1 });
  for (let i = 0; i < 8; i++) history.add({ clockOffsetMs: i, rttMs: 2 + i });
  expect(history.best()).toEqual({ clockOffsetMs: 0, rttMs: 2 });
});
