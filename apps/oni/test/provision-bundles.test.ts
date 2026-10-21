import { expect, test } from "bun:test";
import { executeBundleDisable, executeBundleEnable, type BundlePort } from "../src/bundles/provision/bundles";

function portOf(initialOff: readonly string[], composeError?: string) {
  const sets: (readonly string[])[] = [];
  let off = initialOff;
  const port: BundlePort = {
    names: () => ["monitor", "cron"],
    off: () => off,
    set: async (next) => {
      sets.push(next);
      if (composeError !== undefined) throw new Error(composeError);
      off = next;
    },
  };
  return { port, sets, off: () => off };
}

test("bundle_disable adds the name to the off-list exactly once and reports the full list", async () => {
  const { port, off } = portOf(["cron"]);
  const result = await executeBundleDisable(port)({ name: "monitor" });
  expect(result).toEqual({ name: "monitor", action: "disabled", off: ["cron", "monitor"] });
  // Idempotent: disabling again recomposes with the identical off-list.
  const again = await executeBundleDisable(port)({ name: "monitor" });
  expect(again.off).toEqual(["cron", "monitor"]);
  expect(off()).toEqual(["cron", "monitor"]);
});

test("bundle_enable removes the name and leaves other off entries alone", async () => {
  const { port, off } = portOf(["cron", "monitor"]);
  const result = await executeBundleEnable(port)({ name: "monitor" });
  expect(result).toEqual({ name: "monitor", action: "enabled", off: ["cron"] });
  expect(off()).toEqual(["cron"]);
});

test("an undeclared bundle name refuses without composing", async () => {
  const { port, sets } = portOf([]);
  await expect(executeBundleDisable(port)({ name: "ghost" })).rejects.toThrow(
    "bundle ghost is not declared",
  );
  expect(sets).toEqual([]);
});

test("a compose refusal propagates as the tool refusal and the off-list is unchanged", async () => {
  const { port, off } = portOf([], "compose refused: seam_missing");
  await expect(executeBundleDisable(port)({ name: "monitor" })).rejects.toThrow(
    "compose refused: seam_missing",
  );
  expect(off()).toEqual([]);
});
