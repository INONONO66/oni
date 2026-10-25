import { expect, test } from "bun:test";
import { join } from "node:path";
import { MCLIENT, runConformance } from "./check-clients-conformance";

test("an absent client binary fails the run instead of building one", async () => {
  expect(await runConformance(join(import.meta.dir, "missing-mclient"))).toBe(1);
});

test("the prebuilt mclient conforms to the TypeScript machine host", async () => {
  expect(await runConformance(MCLIENT)).toBe(0);
}, 180_000);
