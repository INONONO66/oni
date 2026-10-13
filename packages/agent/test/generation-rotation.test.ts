import { expect, test } from "bun:test";
import { Context, Deferred, Effect, Fiber } from "effect";
import { z } from "zod";
import type { PlainValue } from "@openomni/protocol";
import { Capability, defineBundle, Manifest, type BundleTool, type SeamTag } from "../src/core/capability";
import { compose } from "../src/core/compose";
import { composedManifest, type ComposedManifest, type SessionRunnerInput } from "../src/core/run";
import { session } from "../src/testing/registry";
import { isolated, isolatedLedger, runTestPromise } from "./helpers/isolated";
import { seedPolicy } from "./helpers/seed-policy";
import { sessionTree } from "./helpers/session-tree";
import { allowConfigure, isolatedRuntime, withSessionServices, type SessionFixture } from "./helpers/session-services";

/**
 * Generation rotation: a manifest change recomputes the generation from EMPTY
 * state via `compose` (never patching the previous one); the in-flight turn
 * finishes on the generation it captured at turn start; each session appends
 * `session.configure{operation: "compose"}` at its NEXT turn start and only then adopts the new tables.
 */

class SeamA extends Context.Service<SeamA, object>()("@openomni/agent/test/rotation/A") {}

const alpha = Capability.define({ name: "alpha", requires: [], verbs: {}, seam: SeamA as SeamTag });

const echoTool: BundleTool = {
  name: "echo",
  description: "echo",
  category: "query",
  input: z.object({}),
  output: z.string(),
  visibility: { model: ["resident"], cell: [] },
  execute: async () => "ok",
  render: (_input: PlainValue, output: PlainValue) => String(output),
  idempotent: true,
};
const monitor = defineBundle({ name: "m", requires: [SeamA], tools: [echoTool] });

const manifestOn = Manifest.define({ capabilities: [alpha], bundles: [monitor], off: [] });
const manifestOff = Manifest.define({ capabilities: [alpha], bundles: [monitor], off: ["m"] });

function fixture(composed: () => ComposedManifest | undefined): SessionFixture {
  let sequence = 0;
  return {
    authorizeConfigure: allowConfigure,
    observations: { publish: () => undefined, subscribe: () => () => undefined },
    clock: () => 20,
    entropy: () => `rot-${++sequence}`,
    processId: "rotation",
    composed: { current: composed },
    ...isolatedRuntime(),
  };
}

const bounded = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.timeout("2 seconds"));

const ConfigureIntentValue = z.looseObject({
  operation: z.string(),
  disabled: z.array(z.object({ name: z.string(), because: z.string() }).strict()).optional(),
});

test("recompute is from empty state: compose is deterministic per manifest and rollback is compose with the previous manifest", async () => {
  const first = await runTestPromise(compose(manifestOn));
  const again = await runTestPromise(compose(manifestOn));
  const off = await runTestPromise(compose(manifestOff));
  expect(again.hash).toBe(first.hash);
  expect(off.hash).not.toBe(first.hash);
  // Rollback = compose with the previous manifest, not a patch of the next one.
  const rolledBack = await runTestPromise(compose(manifestOn));
  expect(rolledBack.hash).toBe(first.hash);
  // The adoption face preserves the bundle's idempotent declaration.
  const adoption = composedManifest(first);
  expect(adoption.tools).toEqual([
    { name: "echo", inputSchema: { type: "object", properties: {} }, category: "query", idempotent: true },
  ]);
  expect(composedManifest(off).tools).toEqual([]);
  expect(composedManifest(off).disabled).toEqual([{ name: "m", because: "m" }]);
});

test("in-flight turn keeps its captured generation; the next turn start appends session.configure and adopts", () =>
  isolated(
    Effect.gen(function* () {
      seedPolicy();
      const generationOn = yield* compose(manifestOn);
      const generationOff = yield* compose(manifestOff);
      let current = composedManifest(generationOn);
      const runtime = fixture(() => current);
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const inputs: SessionRunnerInput[] = [];
      const handle = yield* withSessionServices(
        session(
          {
            id: "S",
            role: "resident",
            runner: (input) =>
              Effect.gen(function* () {
                inputs.push(input);
                if (inputs.length === 1) {
                  yield* Deferred.succeed(entered, undefined);
                  yield* Deferred.await(release);
                }
                return { kind: "result", text: "done" };
              }),
          },
          runtime,
        ),
        runtime,
      );
      const kernel = isolatedLedger().kernel;
      const running = yield* Effect.forkScoped(handle.prompt("first"));
      yield* bounded(Deferred.await(entered));
      // Turn 1 adopted the composed manifest at its start: one session.configure.
      const adopted = kernel.latestGenerationFor("S");
      expect(adopted.manifestHash).toBe(generationOn.hash);
      expect(adopted.tools.map((tool) => tool.name)).toEqual(["echo"]);
      expect(adopted.tools[0]?.idempotent).toBe(true);
      expect(inputs[0]?.toolsGeneration).toBe(adopted.generation);
      // The manifest changes while the turn runs: nothing is appended mid-turn.
      current = composedManifest(generationOff);
      expect(kernel.latestGenerationFor("S").manifestHash).toBe(generationOn.hash);
      yield* Deferred.succeed(release, undefined);
      yield* bounded(Fiber.join(running));
      // The in-flight turn finished on the generation it captured.
      expect(inputs[0]?.toolsGeneration).toBe(adopted.generation);
      // The next turn start appends session.configure and only then adopts.
      yield* handle.prompt("second");
      const next = kernel.latestGenerationFor("S");
      expect(next.manifestHash).toBe(generationOff.hash);
      expect(next.generation).toBe(adopted.generation + 1);
      expect(next.revertTo).toBe(adopted.generation);
      expect(next.tools).toEqual([]);
      expect(inputs[1]?.toolsGeneration).toBe(next.generation);
      // The adoption rows ride the one journal writer with the off cascade recorded.
      const configures = sessionTree(kernel, "S").filter((action) => action.kind === "session.configure");
      expect(configures).toHaveLength(3);
      const [, firstAdoption, secondAdoption] = configures;
      if (firstAdoption === undefined || secondAdoption === undefined) return yield* Effect.die("missing adoption row");
      expect(ConfigureIntentValue.parse(firstAdoption.intent.value)).toMatchObject({ operation: "compose", disabled: [] });
      expect(ConfigureIntentValue.parse(secondAdoption.intent.value)).toMatchObject({
        operation: "compose",
        disabled: [{ name: "m", because: "m" }],
      });
      // An unchanged manifest appends nothing at the following turn start.
      yield* handle.prompt("third");
      expect(sessionTree(kernel, "S").filter((action) => action.kind === "session.configure")).toHaveLength(3);
      expect(inputs[2]?.toolsGeneration).toBe(next.generation);
    }),
  ));
