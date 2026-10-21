import { expect, test } from "bun:test";
import { Cause, Context, Effect, Exit } from "effect";
import { z } from "zod";
import { canonicalDigest, type PlainValue, type PointId } from "@oni/protocol";
import {
  Capability,
  defineBundle,
  Manifest,
  type BundleContract,
  type BundleGateRow,
  type CapabilityDefinition,
  type PortTag,
} from "../src/core/ports/capability";
import { runTestExit, runTestPromise } from "./helpers/isolated";
import { compose, COMPOSE_REJECTION_CODES, ComposeRefused } from "../src/core/composition/compose";

class SeamA extends Context.Service<SeamA, object>()("@oni/agent/test/compose/A") {}
class SeamB extends Context.Service<SeamB, object>()("@oni/agent/test/compose/B") {}
class SeamGhost extends Context.Service<SeamGhost, object>()("@oni/agent/test/compose/Ghost") {}

const kind = {
  schema: z.object({}),
  version: 1 as const,
  reduce: (state: PlainValue) => state,
};

function capability(
  name: string,
  port: PortTag,
  overrides: {
    requires?: readonly string[];
    kinds?: Readonly<Record<string, typeof kind>>;
    points?: readonly PointId[];
    handlers?: Readonly<Record<string, object>>;
  } = {},
): CapabilityDefinition {
  return Capability.define({
    name,
    requires: overrides.requires ?? [],
    kinds: overrides.kinds,
    points: overrides.points,
    handlers: overrides.handlers,
    verbs: {},
    port,
  });
}

const row = (id: string, on: PointId, ref?: string): BundleGateRow => ({
  id,
  on,
  when: {},
  do: "gate",
  how: ref === undefined ? { verdict: "allow" } : { ref },
  order: 1,
});

async function rejectionOf(manifest: Parameters<typeof compose>[0]): Promise<ComposeRefused> {
  const refused = await runTestPromise(Effect.flip(compose(manifest)));
  expect(refused).toBeInstanceOf(ComposeRefused);
  return refused;
}

test("the compose rejection set is closed at exactly six codes", () => {
  expect(COMPOSE_REJECTION_CODES).toEqual([
    "requires_cycle",
    "duplicate",
    "product_declares_kind",
    "seam_missing",
    "unknown_handler",
    "unknown_point",
  ]);
});

test("requires_cycle: mutually requiring capabilities reject", async () => {
  const manifest = Manifest.define({
    capabilities: [
      capability("a", SeamA, { requires: ["b"] }),
      capability("b", SeamB, { requires: ["a"] }),
    ],
    bundles: [],
  });
  expect((await rejectionOf(manifest)).code).toBe("requires_cycle");
});

test("requires_cycle: bundles providing each other's requires reject", async () => {
  const manifest = Manifest.define({
    capabilities: [],
    bundles: [
      defineBundle({ name: "m", requires: [SeamA], provides: [SeamB] }),
      defineBundle({ name: "n", requires: [SeamB], provides: [SeamA] }),
    ],
  });
  expect((await rejectionOf(manifest)).code).toBe("requires_cycle");
});

test("duplicate: a colliding kind, point, tool or row id rejects", async () => {
  const kinds = await rejectionOf(
    Manifest.define({
      capabilities: [
        capability("a", SeamA, { kinds: { probe: kind } }),
        capability("b", SeamB, { kinds: { probe: kind } }),
      ],
      bundles: [],
    }),
  );
  expect(kinds.code).toBe("duplicate");
  const points = await rejectionOf(
    Manifest.define({
      capabilities: [
        capability("a", SeamA, { points: ["alarm.fired"] }),
        capability("b", SeamB, { points: ["alarm.fired"] }),
      ],
      bundles: [],
    }),
  );
  expect(points.code).toBe("duplicate");
  const rows = await rejectionOf(
    Manifest.define({
      capabilities: [capability("a", SeamA, { points: ["alarm.fired"] })],
      bundles: [
        defineBundle({ name: "m", requires: [SeamA], rows: [row("m/x#1", "alarm.fired")] }),
        defineBundle({ name: "n", requires: [SeamA], rows: [row("m/x#1", "alarm.fired")] }),
      ],
    }),
  );
  expect(rows.code).toBe("duplicate");
  const ports = await rejectionOf(
    Manifest.define({
      capabilities: [capability("a", SeamA), capability("b", SeamA)],
      bundles: [],
    }),
  );
  expect(ports).toMatchObject({ code: "duplicate", name: "b", detail: `port ${SeamA.key}` });
});

test("product_declares_kind: a bundle carrying a capability-owned table rejects", async () => {
  const smuggled = {
    ...defineBundle({ name: "m", requires: [] }),
    kinds: { probe: kind },
  } as BundleContract;
  const refused = await rejectionOf(Manifest.define({ capabilities: [], bundles: [smuggled] }));
  expect(refused.code).toBe("product_declares_kind");
  expect(refused.name).toBe("m");
});

test("seam_missing: an unknown seam rejects — it is not a deactivation", async () => {
  const missingCapability = await rejectionOf(
    Manifest.define({
      capabilities: [capability("a", SeamA, { requires: ["ghost"] })],
      bundles: [],
    }),
  );
  expect(missingCapability.code).toBe("seam_missing");
  const missingBundleSeam = await rejectionOf(
    Manifest.define({
      capabilities: [capability("a", SeamA)],
      bundles: [defineBundle({ name: "m", requires: [SeamGhost] })],
    }),
  );
  expect(missingBundleSeam.code).toBe("seam_missing");
  expect(missingBundleSeam.detail).toBe("@oni/agent/test/compose/Ghost");
});

test("unknown_handler: a row referencing an unregistered how.ref rejects", async () => {
  const refused = await rejectionOf(
    Manifest.define({
      capabilities: [capability("a", SeamA, { handlers: { "a/known": {} } })],
      bundles: [
        defineBundle({ name: "m", requires: [SeamA], rows: [row("m/x#1", "turn.pre", "a/ghost")] }),
      ],
    }),
  );
  expect(refused.code).toBe("unknown_handler");
  expect(refused.detail).toBe("a/ghost");
});

test("unknown_point: a row on an off or absent capability's point rejects", async () => {
  const absent = await rejectionOf(
    Manifest.define({
      capabilities: [],
      bundles: [defineBundle({ name: "m", requires: [], rows: [row("m/x#1", "alarm.fired")] })],
    }),
  );
  expect(absent.code).toBe("unknown_point");
  const off = await rejectionOf(
    Manifest.define({
      capabilities: [capability("a", SeamA, { points: ["alarm.fired"] })],
      bundles: [defineBundle({ name: "m", requires: [], rows: [row("m/x#1", "alarm.fired")] })],
      off: ["a"],
    }),
  );
  expect(off.code).toBe("unknown_point");
});

test("a valid manifest composes one generation with merged tables and a stable hash", async () => {
  const manifest = Manifest.define({
    capabilities: [
      capability("a", SeamA, { points: ["alarm.fired"], kinds: { probe: kind }, handlers: { "a/guard": {} } }),
      capability("b", SeamB, { requires: ["a"] }),
    ],
    bundles: [
      defineBundle({
        name: "m",
        requires: [SeamA, SeamB],
        rows: [row("m/x#1", "alarm.fired", "a/guard"), row("m/y#1", "turn.pre")],
      }),
    ],
  });
  const generation = await runTestPromise(compose(manifest));
  expect(generation.capabilities).toEqual(["a", "b"]);
  expect(generation.bundles).toEqual(["m"]);
  expect(Object.keys(generation.kinds)).toEqual(["probe"]);
  expect(generation.points).toContain("alarm.fired");
  expect(generation.points).toContain("turn.pre");
  expect(generation.handlers.has("a/guard")).toBe(true);
  expect(generation.rows.map((entry) => entry.id)).toEqual(["m/x#1", "m/y#1"]);
  expect(generation.disabled).toEqual([]);
  const again = await runTestPromise(compose(manifest));
  expect(again.hash).toBe(generation.hash);
});

test("port API names preserve the recorded manifest hash preimage", async () => {
  const generation = await runTestPromise(compose(Manifest.define({
    capabilities: [capability("a", SeamA)],
    bundles: [],
  })));
  expect(generation.hash).toBe(canonicalDigest({
    capabilities: [{
      name: "a",
      requires: [],
      seam: SeamA.key,
      kinds: [],
      inputs: [],
      points: [],
      purposes: [],
      handlers: [],
    }],
    bundles: [],
    off: [],
    disabled: [],
  }));
});

const bundleTool = (name: string) => ({
  name,
  description: name,
  category: "query" as const,
  input: z.object({}),
  output: z.string(),
  visibility: { model: ["resident" as const], cell: [] },
  execute: async () => name,
  render: (_input: PlainValue, output: PlainValue) => String(output),
});

test("requires_cycle: a self-requiring capability and a self-providing bundle reject", async () => {
  const selfCapability = await rejectionOf(
    Manifest.define({ capabilities: [capability("a", SeamA, { requires: ["a"] })], bundles: [] }),
  );
  expect(selfCapability.code).toBe("requires_cycle");
  const selfBundle = await rejectionOf(
    Manifest.define({
      capabilities: [],
      bundles: [defineBundle({ name: "m", requires: [SeamA], provides: [SeamA] })],
    }),
  );
  expect(selfBundle.code).toBe("requires_cycle");
});

test("duplicate: a tool name colliding across bundles rejects", async () => {
  const refused = await rejectionOf(
    Manifest.define({
      capabilities: [],
      bundles: [
        defineBundle({ name: "m", requires: [], tools: [bundleTool("probe__read")] }),
        defineBundle({ name: "n", requires: [], tools: [bundleTool("probe__read")] }),
      ],
    }),
  );
  expect(refused.code).toBe("duplicate");
  expect(refused.name).toBe("n");
  expect(refused.detail).toBe("tool probe__read");
});

test("duplicate: purposes and handlers collide across declarations — capability vs capability and bundle vs capability", async () => {
  const purposeHandler = { handler: true };
  const capabilityPurposes = await rejectionOf(
    Manifest.define({
      capabilities: [
        Capability.define({ name: "a", requires: [], purposes: { "probe.hit": purposeHandler }, verbs: {}, port: SeamA }),
        Capability.define({ name: "b", requires: [], purposes: { "probe.hit": purposeHandler }, verbs: {}, port: SeamB }),
      ],
      bundles: [],
    }),
  );
  expect(capabilityPurposes.code).toBe("duplicate");
  expect(capabilityPurposes.detail).toBe("purpose probe.hit");
  const bundlePurpose = await rejectionOf(
    Manifest.define({
      capabilities: [
        Capability.define({ name: "a", requires: [], purposes: { "probe.hit": purposeHandler }, verbs: {}, port: SeamA }),
      ],
      bundles: [defineBundle({ name: "m", requires: [SeamA], purposes: { "probe.hit": purposeHandler } })],
    }),
  );
  expect(bundlePurpose.code).toBe("duplicate");
  expect(bundlePurpose.name).toBe("m");
  const handlerCollision = await rejectionOf(
    Manifest.define({
      capabilities: [capability("a", SeamA, { handlers: { "a/guard": {} } })],
      bundles: [defineBundle({ name: "m", requires: [SeamA], handlers: { "a/guard": {} } })],
    }),
  );
  expect(handlerCollision.code).toBe("duplicate");
  expect(handlerCollision.detail).toBe("handler a/guard");
});

test("composition preserves install order across bundles: tools and rows merge in manifest order", async () => {
  const manifest = Manifest.define({
    capabilities: [capability("a", SeamA, { points: ["alarm.fired"] })],
    bundles: [
      defineBundle({
        name: "zeta",
        requires: [SeamA],
        tools: [bundleTool("zeta__one")],
        rows: [row("zeta/x#1", "alarm.fired")],
      }),
      defineBundle({
        name: "alpha",
        requires: [SeamA],
        tools: [bundleTool("alpha__one")],
        rows: [row("alpha/x#1", "alarm.fired")],
      }),
    ],
  });
  const generation = await runTestPromise(compose(manifest));
  // Install order, not lexical order: the manifest's declaration sequence IS
  // the composition order for bundles, their tool faces and their gate rows.
  expect(generation.bundles).toEqual(["zeta", "alpha"]);
  expect(generation.tools.map((tool) => tool.name)).toEqual(["zeta__one", "alpha__one"]);
  expect(generation.rows.map((entry) => entry.id)).toEqual(["zeta/x#1", "alpha/x#1"]);
});

test("a defect inside compose stays a defect: only ComposeRefused crosses as the typed failure", async () => {
  const exit = await runTestExit(compose({} as ReturnType<typeof Manifest.define>));
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) throw new Error("unreachable");
  expect(Cause.hasFails(exit.cause)).toBe(false);
  expect(Cause.hasDies(exit.cause)).toBe(true);
  expect(Cause.squash(exit.cause)).toBeInstanceOf(TypeError);
});
