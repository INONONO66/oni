import { expect, test } from "bun:test";
import { Manifest } from "../src/core/capability";
import { compose } from "../src/core/compose";
import { ActionSeam, actionCapability } from "../src/plugins/action";
import { hookCapability } from "../src/plugins/hook";
import { runTestPromise } from "./helpers/isolated";

/**
 * Action plugin: the capability lives in `plugins/action` and the hook
 * capability's `requires: ["action"]` resolves it by NAME at compose — so
 * `off: ["action"]` cascades `hook` off with `action` recorded as the root.
 */

const manifest = (off: readonly string[]) =>
  Manifest.define({ capabilities: [actionCapability(), hookCapability()], bundles: [], off });

test('off: ["action"] cascades hook off with action as the root because; no input registers', async () => {
  const generation = await runTestPromise(compose(manifest(["action"])));
  expect(generation.disabled).toEqual([
    { name: "action", because: "action" },
    { name: "hook", because: "action" },
  ]);
  expect(generation.inputs).toEqual([]);
  expect(Object.keys(generation.kinds)).toEqual([]);
});

test("composed on, the plugin owns the action kind, input, point and seam", async () => {
  const generation = await runTestPromise(compose(manifest([])));
  expect(generation.disabled).toEqual([]);
  expect(generation.inputs).toEqual(["action"]);
  expect(generation.points).toContain("action.pre");
  expect(Object.keys(generation.kinds)).toEqual(["action"]);
  const capability = actionCapability();
  expect(capability.seam).toBe(ActionSeam);
  expect(ActionSeam.key).toBe("@openomni/action/Action");
});
