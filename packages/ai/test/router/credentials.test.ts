import { expect, test } from "bun:test";
import { block, lease, ready } from "../../src/router/credentials";
import { order, touch } from "../../src/router/pin";
import { candidates, reference } from "../../src/router/chain";

test("auth blocks and leases exactly one reprobe after cooldown", () => {
  const state = block("auth", 1000);
  expect(lease(state, 60_999)).toBeUndefined();
  const probe = lease(state, 61_000);
  if (probe === undefined) throw new Error("missing auth probe");
  expect(lease(probe, 61_000)).toBeUndefined();
  expect(lease(ready, 61_000)).toBe(ready);
});

test("usage exhaustion cools until reset while a sibling remains usable", () => {
  const state = block("billing", 1000, 900_000);
  expect(state.blockedUntil).toBe(901_000);
  expect(lease(state, 900_999)).toBeUndefined();
  expect(lease(ready, 1000)).toBe(ready);
  expect(lease(state, 901_000)?.probing).toBe(true);
});

test("a transient blip imposes no delay on a sibling", () => {
  expect(lease(ready, 1000)).toBe(ready);
  expect(block("transient", 1000, 50_000).blockedUntil).toBe(1000);
});

test("chains default to the requested model and category rows take precedence", () => {
  const rows = [
    { primary: "proxy/x", selectors: ["proxy/x", "direct/x"] },
    { category: "chat", selectors: ["direct/x", "direct/x", "backup/x"], nearestFallback: "small" },
  ];
  expect(candidates([], "proxy/x")).toMatchObject({ selectors: ["proxy/x"], configured: false });
  expect(candidates(rows, "proxy/x").selectors).toEqual(["proxy/x", "direct/x"]);
  expect(candidates(rows, "proxy/x", "chat")).toMatchObject({
    selectors: ["direct/x", "backup/x"], nearestFallback: "small", configured: true,
  });
  expect(reference("proxy/org/model")).toEqual({ provider: "proxy", id: "org/model" });
});

test.each([undefined, "refusal", "billing"] as const)("affinity %s preserves continuation and reverts recoverable originals at a new turn", (reason) => {
  const selectors = ["proxy/x", "direct/x"];
  const pin = touch(undefined, { primary: "proxy/x", candidate: "direct/x", turn: "one", credential: "slot", reason });
  expect(order(selectors, pin, { primary: "proxy/x", turn: "one" })).toEqual(["direct/x", "proxy/x"]);
  expect(order(selectors, pin, { primary: "proxy/x", turn: "two" }))
    .toEqual(reason === "billing" ? ["direct/x", "proxy/x"] : selectors);
  expect(order(selectors, pin, { primary: "another/x", turn: "one" })).toBe(selectors);
});
