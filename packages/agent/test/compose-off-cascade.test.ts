import { expect, test } from "bun:test";
import { Context } from "effect";
import { z } from "zod";
import { Journal, type PlainValue } from "@openomni/protocol";
import { configureAction } from "../src/core/store/fence";
import {
  Capability,
  defineBundle,
  Manifest,
  type SeamTag,
} from "../src/core/ports/capability";
import { runTestPromise } from "./helpers/isolated";
import { compose } from "../src/core/composition/compose";
import { CompactionSeam } from "../src/core/api";
import { compactionCapability } from "../src/bundle";

class SeamA extends Context.Service<SeamA, object>()("@openomni/agent/test/off/A") {}
class SeamB extends Context.Service<SeamB, object>()("@openomni/agent/test/off/B") {}
class SeamM extends Context.Service<SeamM, object>()("@openomni/agent/test/off/M") {}

const kind = {
  schema: z.object({}),
  version: 1 as const,
  reduce: (state: PlainValue) => state,
};

const capability = (name: string, seam: SeamTag, requires: readonly string[] = []) =>
  Capability.define({
    name,
    requires,
    kinds: { [name]: kind },
    verbs: {},
    seam,
  });

function manifest(off: readonly string[]) {
  return Manifest.define({
    capabilities: [capability("a", SeamA), capability("b", SeamB, ["a"])],
    bundles: [
      defineBundle({ name: "m", requires: [SeamB], provides: [SeamM] }),
      defineBundle({ name: "n", requires: [SeamM] }),
    ],
    off,
  });
}

test("off cascades transitively through requires with the root recorded as because", async () => {
  const generation = await runTestPromise(compose(manifest(["a"])));
  expect(generation.disabled).toEqual([
    { name: "a", because: "a" },
    { name: "b", because: "a" },
    { name: "m", because: "a" },
    { name: "n", because: "a" },
  ]);
  expect(generation.capabilities).toEqual([]);
  expect(generation.bundles).toEqual([]);
  // The off capability's kind is not registered: its rows stay opaque in the
  // fold and reject as deliver input (closed kind set).
  expect(Object.keys(generation.kinds)).toEqual([]);
  expect(generation.points).not.toContain("alarm.fired");
});

test("an off bundle cascades to its dependents but leaves capabilities on", async () => {
  const generation = await runTestPromise(compose(manifest(["m"])));
  expect(generation.disabled).toEqual([
    { name: "m", because: "m" },
    { name: "n", because: "m" },
  ]);
  expect(generation.capabilities).toEqual(["a", "b"]);
  expect(Object.keys(generation.kinds)).toEqual(["a", "b"]);
});

test("the off cascade changes the generation hash", async () => {
  const on = await runTestPromise(compose(manifest([])));
  const off = await runTestPromise(compose(manifest(["m"])));
  expect(on.disabled).toEqual([]);
  expect(on.hash).not.toBe(off.hash);
});

test("session.configure journals the cascade as disabled {name, because}", async () => {
  const generation = await runTestPromise(compose(manifest(["a"])));
  const action = configureAction({
    id: "cfg-1",
    sessionId: "s-1",
    parentId: null,
    operation: "create",
    snapshot: {
      generation: 1,
      revertTo: 0,
      tools: [],
      toolsHash: "none",
      bundles: [],
      systemPreset: "",
      systemBlocks: [],
      systemValue: "",
      systemHash: "none",
      policyGeneration: 0,
    },
    disabled: generation.disabled,
    at: 1,
  });
  const intent = z.looseObject({ disabled: z.array(z.object({ name: z.string(), because: z.string() })) }).parse(action.intent.value);
  expect(intent.disabled).toEqual([...generation.disabled]);
  const declaration = Journal.CORE_DECLARATIONS.find((entry) => entry.kind === "session.configure");
  if (declaration === undefined) throw new Error("session.configure declaration missing");
  const parsed = declaration.schema.safeParse({ intent: action.intent, effect: action.effect });
  expect(parsed.success).toBe(true);
  const malformed = declaration.schema.safeParse({
    intent: { encodingVersion: 1, value: { operation: "create", disabled: [{ name: "a" }] } },
    effect: action.effect,
  });
  expect(malformed.success).toBe(false);
});

test("the real compaction capability off cascades its typed record to seam dependents (#1307)", async () => {
  const definition = Manifest.define({
    capabilities: [compactionCapability()],
    bundles: [defineBundle({ name: "needs-compaction", requires: [CompactionSeam] })],
    off: ["compaction"],
  });
  const generation = await runTestPromise(compose(definition));
  expect(generation.disabled).toEqual([
    { name: "compaction", because: "compaction" },
    { name: "needs-compaction", because: "compaction" },
  ]);
  expect(generation.capabilities).toEqual([]);
  expect(generation.bundles).toEqual([]);
});
