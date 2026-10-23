import { expect, test } from "bun:test";
import { join } from "node:path";
import { Core } from "@oni/agent";
const GenerationLayers = Core.GenerationLayers;
const SessionLayer = Core.SessionLayer;
import { Effect } from "effect";
import { z } from "zod";
import { gatewayRuntime, runAppEffect } from "../src/gateway";
const AppLedger = Core.Ledger;
import { auditBundle, composedHolder } from "./helpers/bundle-fixture";
import { eventSignal } from "./helpers/event-signal";
import { residentSuite } from "./helpers/resident-suite";
import { Bus } from "./helpers/bus";

const suite = residentSuite();
const Configured = z.object({ type: z.literal("configured"), generation: z.number(), openTurns: z.number(), acquisitions: z.number() });

test("G1 prerequisite: SIGKILL at committed configure rearms current and recorded older generations", async () => {
  const directory = suite.tempDir("generation-crash-");
  const catalogPath = join(directory, "catalog.sqlite");
  const sessionsDir = join(directory, "sessions");
  const auditPath = join(directory, "audit.jsonl");
  const committed = eventSignal<z.infer<typeof Configured>>("post-configure commit");
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "helpers/generation-crash-process.ts"), catalogPath, sessionsDir, auditPath], {
    stdout: "pipe", stderr: "pipe",
    ipc: (message: string) => committed.resolve(Configured.parse(message)),
  });
  const exited = child.exited;
  const stderr = new Response(child.stderr).text();
  const stdout = new Response(child.stdout).text();
  try {
    expect(await committed.promise).toEqual({ type: "configured", generation: 2, openTurns: 1, acquisitions: 2 });
    child.kill("SIGKILL");
    await exited;
    expect(child.signalCode).toBe("SIGKILL");
    expect(await stderr).toBe("");
    await stdout;
  } finally { if (child.exitCode === null) { child.kill("SIGKILL"); await exited; } }
  const audit = auditBundle(auditPath);
  const runtime = gatewayRuntime({ observations: Bus, catalogPath, sessionsDir, composed: composedHolder({ bundles: [audit.contract] }) });
  try {
    const snapshots = await runAppEffect(runtime, Effect.scoped(Effect.gen(function* () {
      const plane = yield* AppLedger;
      const kernel = plane.openKernel("crash-session");
      const generations = yield* GenerationLayers;
      yield* generations.initialize({ resident: [], child: [] });
      const current = kernel.latestGenerationFor("crash-session");
      const open = kernel.openTurnsPage("crash-session");
      expect(open).toHaveLength(1);
      const recorded = open[0];
      if (recorded === undefined) throw new Error("missing recorded open turn");
      const latest = yield* generations.capture({ sessionId: "crash-session", generation: current.generation });
      const previous = yield* generations.capture({ sessionId: "crash-session", generation: recorded.toolsGeneration });
      return [yield* latest.provide(SessionLayer), yield* previous.provide(SessionLayer)];
    })));
    expect(snapshots.map((layer) => layer.snapshot.generation)).toEqual([2, 1]);
    expect(snapshots[0]?.snapshot.systemValue).toContain("generation-two");
    expect(snapshots[1]?.snapshot.systemValue).not.toContain("generation-two");
    expect(audit.acquired).toHaveLength(2);
    console.log(JSON.stringify({ case: "G1-prerequisite", volatileScopes: "not_durable", reconstructedResources: "rearmed", generations: [2, 1] }));
  } finally { await runtime.dispose(); }
  expect(audit.closed.sort()).toEqual(audit.acquired.sort());
});
