import { expect, test } from "bun:test";
import { closed, lease, open } from "../../src/router/circuit";

test("opens double to the cap under an injected clock", () => {
  let now = 1000;
  let state = closed;
  const delays: number[] = [];
  for (let index = 0; index < 8; index += 1) {
    state = open(state, now);
    delays.push(state.openUntil - now);
    now = state.openUntil;
  }
  expect(delays).toEqual([60_000, 120_000, 240_000, 480_000, 960_000, 1_800_000, 1_800_000, 1_800_000]);
});

test("retry-after is a floor and a usage reset replaces cooldown", () => {
  expect(open(closed, 1000, { hintMs: 2_000_000 }).openUntil).toBe(2_001_000);
  expect(open(closed, 1000, { hintMs: 1 }).openUntil).toBe(61_000);
  expect(open(closed, 1000, { hintMs: 2_000_000, resetAt: 5000 }).openUntil).toBe(5000);
});

test("expiry grants one half-open lease and success closes the circuit", () => {
  const state = open(closed, 1000);
  expect(lease(state, 60_999)).toBeUndefined();
  const probe = lease(state, 61_000);
  if (probe === undefined) throw new Error("missing half-open lease");
  expect(probe.halfOpenLeased).toBe(true);
  expect(lease(probe, 61_000)).toBeUndefined();
  expect(open(probe, 61_000).openUntil).toBe(181_000);
  expect(lease(closed, 61_000)).toEqual({ consecutiveOpens: 0, openUntil: 0, halfOpenLeased: false });
});
