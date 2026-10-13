import { expect, test } from "bun:test";
import type { ToolExecutionContext } from "@openomni/protocol";
import type { BundlePort } from "../src/bundles/provision/bundles";
import type { ProvisionPort } from "../src/bundles/provision/channels";
import { executeProvision } from "../src/bundles/provision/execution";

function portWith(bundles: BundlePort): ProvisionPort {
  const partial: Pick<ProvisionPort, "bundles"> = { bundles };
  return partial as ProvisionPort;
}

test("provision dispatches bundle_enable and bundle_disable to the bundle port and tags the op", async () => {
  let off: readonly string[] = ["cron"];
  const sets: (readonly string[])[] = [];
  const port = portWith({
    names: () => ["monitor", "cron"],
    off: () => off,
    set: async (next) => {
      sets.push(next);
      off = next;
    },
  });
  const execute = executeProvision(port, () => 0);
  const context = {} as ToolExecutionContext;
  const disabled = await execute({ operation: { op: "bundle_disable", args: { name: "monitor" } } }, context);
  expect(disabled).toEqual({ op: "bundle_disable", name: "monitor", action: "disabled", off: ["cron", "monitor"] });
  const enabled = await execute({ operation: { op: "bundle_enable", args: { name: "cron" } } }, context);
  expect(enabled).toEqual({ op: "bundle_enable", name: "cron", action: "enabled", off: ["monitor"] });
  expect(sets).toEqual([["cron", "monitor"], ["monitor"]]);
});

test("without a composed port every bundle op is the one typed refusal", async () => {
  const execute = executeProvision(undefined, () => 0);
  const context = {} as ToolExecutionContext;
  await expect(execute({ operation: { op: "bundle_disable", args: { name: "monitor" } } }, context)).rejects.toThrow(
    "provision refused: provisioning is not composed",
  );
});
