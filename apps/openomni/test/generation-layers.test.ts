import { APPROVAL_POLICY } from "../src/composition/policy";
import { expect, test } from "bun:test";
import { Core, Bundle, Testing } from "@openomni/agent";
const AgentFailure = Core.AgentFailure;
const GenerationLayers = Core.GenerationLayers;
const ObservationSink = Core.ObservationSink;
const SessionLayer = Core.SessionLayer;
const session = Testing.session;
import { Effect, Layer } from "effect";
import { z } from "zod";
import { seedKernelPolicyRows } from "../src/composition/policy";
import { composedPointTable } from "../src/composition/point-table";
import type { PolicyRow } from "@openomni/protocol";
import { acquireAppResource, gatewayRuntime, runAppEffect } from "../src/gateway";
import { composedHolder } from "./helpers/bundle-fixture";
import { allowConfigure } from "./helpers/generation-services";
import { configureAuthority } from "../src/composition/generation-layers";
import { AppLedger } from "../src/composition/cluster-runtime";
import { Bus } from "./helpers/bus";

test("AppLive retains distinct same-number session generations", async () => {
  const runtime = gatewayRuntime({ composed: composedHolder(), observations: Bus });
  try {
    const values = await runAppEffect(runtime, Effect.scoped(Effect.gen(function* () {
      const generations = yield* GenerationLayers;
      const plane = yield* AppLedger;
      const policyGeneration = seedKernelPolicyRows(plane.catalog.policies);
      yield* generations.initialize({ resident: [], child: [] });
      for (const id of ["first", "second"]) yield* plane.openKernel(id).materialize({
        id, parentId: null, role: "resident", tools: [], system: { preset: id, blocks: [] },
        policyGeneration, actionId: `${id}-create`, at: 1,
      });
      const first = yield* generations.capture({ sessionId: "first", generation: 1 });
      const again = yield* generations.capture({ sessionId: "first", generation: 1 });
      const second = yield* generations.capture({ sessionId: "second", generation: 1 });
      const a = yield* first.provide(SessionLayer);
      const b = yield* again.provide(SessionLayer);
      const c = yield* second.provide(SessionLayer);
      return { a, b, c };
    })));
    expect(values.a).toBe(values.b);
    expect(values.c).not.toBe(values.a);
    expect([values.a.snapshot.systemValue, values.c.snapshot.systemValue]).toEqual(["first", "second"]);
  } finally { await runtime.dispose(); }
});

test("generation composition rejects use before initialization and duplicate initialization", async () => {
  const runtime = gatewayRuntime({ composed: composedHolder(), observations: Bus });
  try {
    await runAppEffect(runtime, Effect.scoped(Effect.gen(function* () {
      const generations = yield* GenerationLayers;
      const plane = yield* AppLedger;
      const policyGeneration = seedKernelPolicyRows(plane.catalog.policies);
      yield* plane.openKernel("init").materialize({ id: "init", parentId: null, role: "resident", tools: [],
        system: { preset: "", blocks: [] }, policyGeneration, actionId: "init-create", at: 1 });
      expect(yield* Effect.flip(generations.capture({ sessionId: "init", generation: 1 }))).toMatchObject({ operation: "generation.initialize", cause: "not_initialized" });
      yield* generations.initialize({ resident: [], child: [] });
      expect(yield* Effect.flip(generations.initialize({ resident: [], child: [] }))).toMatchObject({ operation: "generation.initialize", cause: "already_initialized" });
      expect(yield* Effect.flip(generations.capture({ sessionId: "init", generation: 99 }))).toMatchObject({ _tag: "GenerationUnavailable", generation: 99 });
    })));
  } finally { await runtime.dispose(); }
});

test("concurrent captures and hibernation reuse one owner; failed candidate acquisition and commit unwind without publication", async () => {
  const probe = { name: "probe.event", schema: z.object({ acquisition: z.number() }) };
  const acquired: number[] = [];
  const closed: number[] = [];
  const delivered: number[] = [];
  let fail = false;
  const live = Layer.effectDiscard(Effect.gen(function* () {
    const sink = yield* ObservationSink;
    const id = yield* Effect.acquireRelease(Effect.sync(() => {
      const id = acquired.length + 1;
      acquired.push(id);
      const unsubscribe = sink.subscribe(probe, (event) => delivered.push(event.acquisition));
      sink.publish(probe, { acquisition: id });
      return { id, unsubscribe };
    }), ({ id, unsubscribe }) => Effect.sync(() => { unsubscribe(); closed.push(id); }));
    if (fail) return yield* new AgentFailure({ operation: "fixture.acquire", cause: String(id.id) });
  }));
  const definition = Bundle.define({ name: "probe", requires: [], layer: live });
  const runtime = gatewayRuntime({ observations: Bus, composed: composedHolder({ bundles: [definition] }) });
  try {
    const handle = await acquireAppResource(runtime, Effect.gen(function* () {
      yield* (yield* GenerationLayers).initialize({ resident: [], child: [] });
      const plane = yield* AppLedger;
      seedKernelPolicyRows(plane.catalog.policies);
      return yield* session({ id: "owners", role: "resident", bundles: ["probe"], runner: () => Effect.succeed({ kind: "result", text: "done" }) }, { approvalPolicy: APPROVAL_POLICY, authorizeConfigure: allowConfigure, openKernel: plane.openKernel, listSessions: plane.listSessions });
    }));
    const values = await runAppEffect(runtime, Effect.scoped(Effect.gen(function* () {
      const generations = yield* GenerationLayers;
      const captures = yield* Effect.all([generations.capture({ sessionId: handle.id, generation: 1 }), generations.capture({ sessionId: handle.id, generation: 1 })], { concurrency: "unbounded" });
      return yield* Effect.all(captures.map((capture) => capture.provide(SessionLayer)));
    })));
    expect(values[0]).toBe(values[1]);
    expect(acquired).toEqual([1]);
    await runAppEffect(runtime, handle.prompt("hibernate"));
    await runAppEffect(runtime, handle.prompt("rewake"));
    expect(acquired).toEqual([1]);
    fail = true;
    await expect(runAppEffect(runtime, handle.system.blocks.set([{ id: "two", source: "fixture", content: "candidate" }]))).rejects.toMatchObject({ _tag: "AgentFailure", operation: "fixture.acquire" });
    fail = false;
    expect(closed).toEqual([2]);
    const generationOf = (id: string) =>
      runAppEffect(runtime, Effect.map(AppLedger, (plane) => plane.openKernel(id).latestGenerationFor(id)));
    expect((await generationOf(handle.id)).generation).toBe(1);
    await runAppEffect(runtime, Effect.gen(function* () {
      const generations = yield* GenerationLayers;
      const plane = yield* AppLedger;
      const before = plane.openKernel(handle.id).latestGenerationFor(handle.id);
      const failure = new AgentFailure({ operation: "fixture.commit", cause: "refused" });
      expect(yield* Effect.flip(generations.configure({ sessionId: handle.id, generation: 2 }, { ...before, generation: 2 }, Effect.fail(failure)))).toBe(failure);
      expect(yield* Effect.flip(generations.configure({ sessionId: handle.id, generation: 3 }, before, Effect.void))).toMatchObject({ operation: "generation.configure" });
    }));
    expect(closed).toEqual([2, 3]);
    expect(delivered).toEqual([]);
    expect(await runAppEffect(runtime, handle.system.blocks.set([{ id: "two", source: "fixture", content: "committed" }]))).toMatchObject({ generation: 2 });
    expect(acquired).toEqual([1, 2, 3, 4]);
  } finally { await runtime.dispose(); }
  expect(closed.sort()).toEqual(acquired.sort());
});

test("a capability omitted from the composition removes its points: tool rows fail closed; composed, they govern (#1251 r3)", async () => {
  const reduced = Core.KERNEL_CAPABILITY_POINTS.filter((capability) => capability.bundle !== "tool");
  const denyWrites: Omit<PolicyRow.Row, "generation"> = {
    name: "no-writes", kind: "tool", phase: "pre", priority: 1_000,
    match: { encodingVersion: 1, value: { op: "write" } },
    verdict: { encodingVersion: 1, value: { type: "deny", reason: "frozen" } },
  };
  const governed: Omit<PolicyRow.Row, "generation">[] = [
    {
      name: "compaction", kind: "compaction", phase: "pre", priority: 1_000,
      match: { encodingVersion: 1, value: {} },
      verdict: { encodingVersion: 1, value: { type: "allow" } },
    },
    denyWrites,
  ];
  const withoutTool = gatewayRuntime({ composed: composedHolder(), observations: Bus, capabilities: reduced });
  try {
    await runAppEffect(withoutTool, Effect.scoped(Effect.gen(function* () {
      const generations = yield* GenerationLayers;
      const plane = yield* AppLedger;
      // Boot fails closed: the kernel seed itself carries tool rows and this
      // composition registers no tool points.
      let seedError: Error | undefined;
      try {
        seedKernelPolicyRows(plane.catalog.policies, [], composedPointTable(reduced));
      } catch (error) {
        seedError = error instanceof Error ? error : new Error(String(error));
      }
      expect(Core.GateComposeError.isInstance(seedError) ? seedError.data : seedError)
        .toMatchObject({ code: "unknown_point", point: "tool.pre" });
      // A generation written elsewhere still fails closed at capture.
      const generation = plane.catalog.policies.appendGeneration(() => governed);
      yield* generations.initialize({ resident: [], child: [] });
      yield* plane.openKernel("no-tools").materialize({
        id: "no-tools", parentId: null, role: "resident", tools: [], system: { preset: "", blocks: [] },
        policyGeneration: generation, actionId: "no-tools-create", at: 1,
      });
      const failure = yield* Effect.flip(Effect.gen(function* () {
        const captured = yield* generations.capture({ sessionId: "no-tools", generation: 1 });
        return yield* captured.provide(SessionLayer);
      }));
      expect(failure).toMatchObject({ _tag: "AgentFailure", operation: "generation.policy" });
      expect(String(failure)).toContain("unknown_point");
    })));
  } finally { await withoutTool.dispose(); }

  // The same rows govern once the tool capability is composed.
  const composed = gatewayRuntime({ composed: composedHolder(), observations: Bus });
  try {
    await runAppEffect(composed, Effect.scoped(Effect.gen(function* () {
      const generations = yield* GenerationLayers;
      const plane = yield* AppLedger;
      seedKernelPolicyRows(plane.catalog.policies);
      const generation = plane.catalog.policies.appendGeneration((current) => [
        ...current.map(({ generation: _generation, ...rest }) => rest),
        denyWrites,
      ]);
      yield* generations.initialize({ resident: [], child: [] });
      yield* plane.openKernel("tooled").materialize({
        id: "tooled", parentId: null, role: "resident", tools: [], system: { preset: "", blocks: [] },
        policyGeneration: generation, actionId: "tooled-create", at: 1,
      });
      const captured = yield* generations.capture({ sessionId: "tooled", generation: 1 });
      const { policy } = yield* captured.provide(SessionLayer);
      expect(policy.evaluate({ kind: "tool", phase: "pre", op: "write", value: { text: "x" } }))
        .toMatchObject({ verdict: "deny", reason: "frozen" });
    })));
  } finally { await composed.dispose(); }
});

test("a generation carrying a row outside the composition's point table fails closed at capture (#1251 r2)", async () => {
  const runtime = gatewayRuntime({ composed: composedHolder(), observations: Bus });
  try {
    await runAppEffect(runtime, Effect.scoped(Effect.gen(function* () {
      const generations = yield* GenerationLayers;
      const plane = yield* AppLedger;
      seedKernelPolicyRows(plane.catalog.policies);
      // A later generation smuggles in a row no registered point can own:
      // the generation Layer compiles against the composition's table and
      // must fail closed instead of defaulting capabilities present.
      const orphaned = plane.catalog.policies.appendGeneration((current) => [
        ...current.map(({ generation: _generation, ...rest }) => rest),
        {
          name: "orphan", kind: "fold.checkpoint", phase: "pre", priority: 1,
          match: { encodingVersion: 1, value: {} },
          verdict: { encodingVersion: 1, value: { type: "allow" } },
        },
      ]);
      yield* generations.initialize({ resident: [], child: [] });
      yield* plane.openKernel("orphaned").materialize({
        id: "orphaned", parentId: null, role: "resident", tools: [], system: { preset: "", blocks: [] },
        policyGeneration: orphaned, actionId: "orphaned-create", at: 1,
      });
      const failure = yield* Effect.flip(Effect.gen(function* () {
        const captured = yield* generations.capture({ sessionId: "orphaned", generation: 1 });
        return yield* captured.provide(SessionLayer);
      }));
      expect(failure).toMatchObject({ _tag: "AgentFailure", operation: "generation.policy" });
      // `fold.checkpoint` projects onto no registered point in ANY shipped
      // composition: the registry itself refuses it.
      expect(String(failure)).toContain("unknown_point");
    })));
  } finally { await runtime.dispose(); }
});

for (const verdict of ["require_approval", "deny"] as const) {
  test(`configureAuthority refuses session.configure when the pinned pre-policy yields ${verdict}`, async () => {
    const runtime = gatewayRuntime({ composed: composedHolder(), observations: Bus });
    try {
      const decisions = await runAppEffect(runtime, Effect.scoped(Effect.gen(function* () {
        const generations = yield* GenerationLayers;
        const plane = yield* AppLedger;
        const policyGeneration = seedKernelPolicyRows(plane.catalog.policies, [{
          name: `configure-${verdict}`, kind: "session.configure", phase: "pre", priority: 1_000,
          match: { encodingVersion: 1, value: { sessionId: "guarded" } },
          verdict: { encodingVersion: 1, value: verdict === "deny" ? { type: "deny", reason: "pinned" } : { type: "require_approval", reason: "pinned" } },
        }]);
        yield* generations.initialize({ resident: [], child: [] });
        for (const id of ["guarded", "open"]) yield* plane.openKernel(id).materialize({
          id, parentId: null, role: "resident", tools: [], system: { preset: id, blocks: [] },
          policyGeneration, actionId: `${id}-create`, at: 1,
        });
        const authority = configureAuthority(generations, plane.openKernel);
        return {
          guarded: yield* authority({ sessionId: "guarded", role: "resident", operation: "tools.add", generation: 1 }),
          open: yield* authority({ sessionId: "open", role: "resident", operation: "tools.add", generation: 1 }),
        };
      })));
      expect(decisions).toEqual({ guarded: false, open: true });
    } finally { await runtime.dispose(); }
  });
}

test("a composed bundle handler exposing apply registers as a transformer and one exposing decide as a guard (#1258)", async () => {
  const shaper = Bundle.define({
    name: "shaper",
    requires: [],
    handlers: {
      "shaper/mask": { apply: () => ({ text: "masked" }) },
      "shaper/gate": { decide: () => ({ verdict: "deny" as const, payload: { reason: "shaped" } }) },
    },
  });
  const runtime = gatewayRuntime({ observations: Bus, composed: composedHolder({ bundles: [shaper] }) });
  try {
    await runAppEffect(runtime, Effect.scoped(Effect.gen(function* () {
      const generations = yield* GenerationLayers;
      const plane = yield* AppLedger;
      // Rows referencing the bundle's handlers compile only when the capture
      // registered them: `apply` into transformers, `decide` into guards.
      const policyGeneration = seedKernelPolicyRows(plane.catalog.policies, [
        {
          name: "mask-writes", kind: "tool", phase: "pre", priority: 1_000,
          match: { encodingVersion: 1, value: { op: "write" } },
          verdict: { encodingVersion: 1, value: { type: "transform", ref: "shaper/mask", config: { fields: ["text"] } } },
        },
        {
          name: "gate-fetches", kind: "tool", phase: "pre", priority: 1_000,
          match: { encodingVersion: 1, value: { op: "fetch" } },
          verdict: { encodingVersion: 1, value: { type: "consult", ref: "shaper/gate" } },
        },
      ]);
      yield* generations.initialize({ resident: [], child: [] });
      yield* plane.openKernel("shaped").materialize({
        id: "shaped", parentId: null, role: "resident", tools: [], system: { preset: "", blocks: [] },
        policyGeneration, actionId: "shaped-create", at: 1,
      });
      const captured = yield* generations.capture({ sessionId: "shaped", generation: 1 });
      const { policy } = yield* captured.provide(SessionLayer);
      expect(policy.evaluate({ kind: "tool", phase: "pre", op: "write", value: { text: "secret" } }))
        .toMatchObject({ verdict: "transform", ref: "shaper/mask", value: { text: "masked" } });
      expect(policy.evaluate({ kind: "tool", phase: "pre", op: "fetch", value: {} }))
        .toMatchObject({ verdict: "deny", reason: "shaped" });
    })));
  } finally { await runtime.dispose(); }
});
