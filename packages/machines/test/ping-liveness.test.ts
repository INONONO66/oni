import { expect, test } from "bun:test";
import { PingLiveness } from "../src/ping-liveness";

test("a valid reply after five seconds extends the peer deadline", () => {
  const pings = new PingLiveness();
  pings.attach("peer", 0);
  expect(pings.begin("peer")).toBe(true);
  expect(pings.begin("peer")).toBe(false);
  pings.finish("peer", 11_000, true);
  expect(pings.expired("peer", 15_000)).toBe(false);
  expect(pings.expired("peer", 26_000)).toBe(true);
});

test("a reply at the silence deadline does not revive the peer", () => {
  const pings = new PingLiveness();
  pings.attach("peer", 0);
  expect(pings.begin("peer")).toBe(true);
  pings.finish("peer", 15_000, true);
  expect(pings.expired("peer", 15_000)).toBe(true);
});
