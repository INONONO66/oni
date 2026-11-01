import { expect, test } from "bun:test";
import { frameLatency } from "../src/frame-latency";

test("frame latencies use exact nearest-rank percentiles and count sequence gaps", () => {
  const frames = Array.from({ length: 100 }, (_, index) => ({
    seq: index < 50 ? index : index + 2,
    capturedAt: 1000 + index * 10,
    displayAt: 1000 + index * 10 + index + 1,
    ...(index === 50 ? { reconnectedAt: 1000 + index * 10 } : {}),
  }));
  expect(frameLatency(frames)).toEqual({
    frames: 100, p50: 50, p95: 95, p99: 99,
    reconnectFirstFreshFrameMs: 51, dropped: 2,
  });
});

test("empty frame set has no fabricated latency", () => {
  expect(frameLatency([])).toEqual({
    frames: 0, p50: null, p95: null, p99: null,
    reconnectFirstFreshFrameMs: null, dropped: 0,
  });
});

test("reconnect waits for the first newly captured frame", () => {
  expect(frameLatency([
    { seq: 1, capturedAt: 90, displayAt: 110, reconnectedAt: 100 },
    { seq: 2, capturedAt: 105, displayAt: 140 },
  ]).reconnectFirstFreshFrameMs).toBe(40);
});
