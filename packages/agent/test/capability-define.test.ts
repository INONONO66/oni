import { expect, test } from "bun:test";
import { Context, Effect } from "effect";
import { z } from "zod";
import type { AnyToolDefinition, PlainValue } from "@openomni/protocol";
import {
  Capability,
  defineBundle,
  DefineRefused,
  Manifest,
  port,
  type CapabilityInput,
} from "../src/core/ports/capability";
import { AlarmPort } from "../src/core/ports/alarm";

class TestSeam extends Context.Service<TestSeam, { readonly ping: () => string }>()(
  "@openomni/agent/test/capability/Seam",
) {}

const toolDefinition = (name: string): AnyToolDefinition => ({
  name,
  description: name,
  category: "query",
  input: z.object({}),
  output: z.string(),
  visibility: { model: ["resident"], cell: [] },
  execute: async () => name,
  render: (_input: PlainValue, output: PlainValue) => String(output),
});

const kind = {
  schema: z.object({}),
  version: 1 as const,
  reduce: (state: PlainValue, _row: PlainValue) => state,
};

function defineTestCapability(overrides: Partial<CapabilityInput> = {}) {
  return Capability.define({
    name: "probe",
    requires: ["alarm"],
    kinds: { probe: kind },
    inputs: ["probe"],
    points: ["action.pre"],
    purposes: { "probe.hit": () => Effect.void },
    handlers: { "probe/guard": () => Effect.void },
    verbs: { ping: () => "pong" } as object,
    port: TestSeam,
    ...overrides,
  });
}

test("Capability.define freezes the declaration with every owned table", () => {
  const defined = defineTestCapability();
  expect(defined.contract).toBe("capability");
  expect(defined.name).toBe("probe");
  expect(defined.requires).toEqual(["alarm"]);
  expect(Object.keys(defined.kinds)).toEqual(["probe"]);
  expect(defined.inputs).toEqual(["probe"]);
  expect(defined.points).toEqual(["action.pre"]);
  expect(Object.keys(defined.purposes)).toEqual(["probe.hit"]);
  expect(Object.keys(defined.handlers)).toEqual(["probe/guard"]);
  expect(defined.port).toBe(TestSeam);
  expect(Object.isFrozen(defined)).toBe(true);
  expect(Object.isFrozen(defined.points)).toBe(true);
  expect(Object.isFrozen(defined.kinds)).toBe(true);
});

test("a capability declaring model tools refuses typed at define time", () => {
  expect(() =>
    Capability.define({
      name: "probe",
      requires: [],
      verbs: {},
      port: TestSeam,
      // @ts-expect-error model tools are bundle-owned
      tools: [toolDefinition("probe__read")],
    }),
  ).toThrow(DefineRefused);
  try {
    Capability.define({
      name: "probe",
      requires: [],
      verbs: {},
      port: TestSeam,
      // @ts-expect-error model tools are bundle-owned
      tools: [toolDefinition("probe__read")],
    });
    throw new Error("unreachable");
  } catch (refusal) {
    expect(refusal).toBeInstanceOf(DefineRefused);
    expect((refusal as DefineRefused).code).toBe("capability_declares_tools");
  }
});

test("malformed names and duplicate declarations refuse typed", () => {
  expect(() => defineTestCapability({ name: "Bad Name" })).toThrow(DefineRefused);
  try {
    defineTestCapability({ requires: ["alarm", "alarm"] });
    throw new Error("unreachable");
  } catch (refusal) {
    expect((refusal as DefineRefused).code).toBe("duplicate");
  }
  try {
    defineTestCapability({ points: ["action.pre", "action.pre"] });
    throw new Error("unreachable");
  } catch (refusal) {
    expect((refusal as DefineRefused).code).toBe("duplicate");
  }
});

test("a seam key outside the @openomni/<owner>/ law refuses namespace at construction and at define", () => {
  expect(() => port("alarm")).toThrow(DefineRefused);
  try {
    port("@acme/agent/Seam");
    throw new Error("unreachable");
  } catch (refusal) {
    expect((refusal as DefineRefused).code).toBe("namespace");
  }
  const other = port("@openomni/agent/test/capability/Other");
  expect(Object.isFrozen(other)).toBe(true);
  expect(other.key).toBe("@openomni/agent/test/capability/Other");
  try {
    defineTestCapability({ port: { key: "nope" } });
    throw new Error("unreachable");
  } catch (refusal) {
    expect((refusal as DefineRefused).code).toBe("namespace");
  }
  try {
    defineBundle({ name: "m", requires: [{ key: "nope" }] });
    throw new Error("unreachable");
  } catch (refusal) {
    expect((refusal as DefineRefused).code).toBe("namespace");
  }
});

test("Bundle.define preserves the idempotent tool declaration and freezes the contract", () => {
  const defined = defineBundle({
    name: "monitor",
    requires: [AlarmPort],
    tools: [{ ...toolDefinition("monitor__watch"), idempotent: true }],
    rows: [
      {
        id: "monitor/alarm.fired#1",
        on: "alarm.fired",
        when: {},
        do: "gate",
        how: { verdict: "allow" },
        order: 1,
      },
    ],
  });
  expect(defined.contract).toBe("bundle");
  expect(defined.tools[0]?.idempotent).toBe(true);
  expect(defined.rows[0]?.on).toBe("alarm.fired");
  expect(defined.provides).toEqual([]);
  expect(Object.isFrozen(defined)).toBe(true);
  expect(Object.isFrozen(defined.tools)).toBe(true);
});

test("Bundle.define refuses duplicate tool names and malformed bundle names typed", () => {
  try {
    defineBundle({
      name: "monitor",
      requires: [],
      tools: [toolDefinition("monitor__watch"), toolDefinition("monitor__watch")],
    });
    throw new Error("unreachable");
  } catch (refusal) {
    expect(refusal).toBeInstanceOf(DefineRefused);
    expect((refusal as DefineRefused).code).toBe("duplicate");
  }
  expect(() => defineBundle({ name: "Monitor", requires: [] })).toThrow(DefineRefused);
});

test("Manifest.define refuses an off name nothing declares, typed, never a silent no-op", () => {
  const alarm = Capability.define({ name: "alarm", requires: [], verbs: {}, port: AlarmPort });
  try {
    Manifest.define({ capabilities: [alarm], bundles: [], off: ["alarms"] });
    throw new Error("unreachable");
  } catch (refusal) {
    expect(refusal).toBeInstanceOf(DefineRefused);
    expect((refusal as DefineRefused).code).toBe("unknown");
    expect((refusal as DefineRefused).detail).toBe("alarms");
  }
  expect(Manifest.define({ capabilities: [alarm], bundles: [], off: ["alarm"] }).off).toEqual(["alarm"]);
});

test("Manifest.define is plain frozen data and refuses colliding names", () => {
  const capability = defineTestCapability();
  const bundle = defineBundle({ name: "monitor", requires: [TestSeam] });
  const manifest = Manifest.define({
    capabilities: [capability],
    bundles: [bundle],
    off: ["monitor"],
  });
  expect(manifest.capabilities).toEqual([capability]);
  expect(manifest.bundles).toEqual([bundle]);
  expect(manifest.off).toEqual(["monitor"]);
  expect(Object.isFrozen(manifest)).toBe(true);
  expect(() =>
    Manifest.define({
      capabilities: [capability],
      bundles: [defineBundle({ name: "probe", requires: [] })],
    }),
  ).toThrow(DefineRefused);
  expect(Manifest.define({ capabilities: [], bundles: [] }).off).toEqual([]);
});
