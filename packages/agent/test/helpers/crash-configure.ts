import { writeSync } from "node:fs";
import { LedgerAction, SessionGeneration } from "@openomni/protocol";
import { Effect } from "effect";
import { z } from "zod";
import { sessionTree } from "./session-tree";
import { AgentFailure, type SessionError } from "../../src/core/ports/failure";
import { closeSessions } from "../../src/core/session/run";
import { session } from "../../src/testing/registry";
import { reactivateSession } from "./wake-session";
import type { SessionRunnerInput } from "../../src/core/session/run";
import { GenerationLayers, SessionLayer } from "../../src/core/ports/ports";
import { isolated, isolatedLedger } from "./isolated";
import { openCrashStores } from "./crash-stores";
import { commitReceivedMessage } from "./ingress";
import { seedPolicy } from "./seed-policy";
import { awaitCrashStart, holdCrashBarrier } from "./crash-channel";
import { uniqueEntropy } from "./time";
import { allowConfigure, isolatedRuntime, type SessionFixture, withSessionServices } from "./session-services";

export const configureCrashPoint = "session_configure_commit_before_hibernate";
const sessionId = "configure-crash-session";
export const configureCutProof = z.object({
  crashPoint: z.literal(configureCrashPoint), snapshot: SessionGeneration.Snapshot,
  actions: z.array(LedgerAction.Node), hibernations: z.number(),
}).strict();
export const configureRecoveryProof = z.object({
  before: z.array(LedgerAction.Node), idle: z.array(LedgerAction.Node),
  after: z.array(LedgerAction.Node), repeated: z.array(LedgerAction.Node),
  snapshot: SessionGeneration.Snapshot, captured: z.array(SessionGeneration.Snapshot),
  configureCalls: z.number(), runnerGenerations: z.array(z.number()),
}).strict();

function cut() {
  return Effect.gen(function* () {
    let hibernations = 0;
    const runtime: SessionFixture = {
      ...isolatedRuntime(),
      authorizeConfigure: allowConfigure, observations: { publish: () => undefined }, clock: () => 100,
      entropy: uniqueEntropy("configure"),
      onHibernate: () => Effect.sync(() => { hibernations += 1; }),
    };
    return yield* withSessionServices(Effect.gen(function* () {
      const generations = yield* GenerationLayers;
      const handle = yield* session({ id: sessionId, role: "resident",
        runner: () => Effect.die("configure must not enter a runner"),
      }, runtime).pipe(Effect.provideService(GenerationLayers, {
        ...generations,
        configure: <A>(id: SessionGeneration.Id, snapshot: SessionGeneration.Snapshot, commit: Effect.Effect<A, SessionError>) =>
          generations.configure(id, snapshot, commit).pipe(Effect.tap(() => Effect.sync(() =>
            holdCrashBarrier(JSON.stringify(configureCutProof.parse({
              crashPoint: configureCrashPoint, snapshot: isolatedLedger().kernel.latestGenerationFor(sessionId),
              actions: sessionTree(isolatedLedger().kernel, sessionId), hibernations,
            }))),
          ))),
      }));
      hibernations = 0;
      return yield* handle.system.blocks.set([{ id: "G1", source: "test", content: "G1_GENERATION_SENTINEL" }]);
    }), runtime);
  });
}

function recover() {
  return Effect.gen(function* () {
    const kernel = isolatedLedger().kernel;
    const before = sessionTree(kernel, sessionId);
    const snapshot = kernel.latestGenerationFor(sessionId);
    const captured: SessionGeneration.Snapshot[] = [];
    const runnerGenerations: number[] = [];
    let configureCalls = 0;
    const runtime: SessionFixture = {
      ...isolatedRuntime(),
      observations: { publish: () => undefined }, clock: () => 100_000,
      entropy: uniqueEntropy("recover"),
      authorizeConfigure: () => Effect.suspend(() => {
        configureCalls += 1;
        return Effect.fail(new AgentFailure({ operation: "configure.recovery", cause: "unexpected_reexecution" }));
      }),
    };
    const runner = (input: SessionRunnerInput) => Effect.gen(function* () {
      captured.push((yield* SessionLayer).snapshot);
      runnerGenerations.push(input.toolsGeneration);
      return { kind: "result" as const, text: "G1_RESULT" };
    });
    try {
      yield* withSessionServices(reactivateSession(sessionId, runner, runtime), runtime);
      const idle = sessionTree(kernel, sessionId);
      yield* commitReceivedMessage(kernel, {
        id: "G1_PROBE", sessionId, kind: "prompt", content: "G1_PROBE", createdAt: 100_000,
        origin: { encodingVersion: 1, value: {} }, parentActionId: null,
      });
      yield* withSessionServices(reactivateSession(sessionId, runner, runtime), runtime);
      const after = sessionTree(kernel, sessionId);
      yield* withSessionServices(reactivateSession(sessionId, runner, runtime), runtime);
      return configureRecoveryProof.parse({ before, idle, after, repeated: sessionTree(kernel, sessionId),
        snapshot, captured, configureCalls, runnerGenerations });
    } finally {
      yield* closeSessions(runtime);
    }
  });
}

if (import.meta.main) {
  const [stage, dbPath] = z.tuple([z.enum(["crash", "recover"]), z.string().min(1)]).parse(process.argv.slice(2));
  awaitCrashStart();
  const proof = await isolated(Effect.gen(function* () {
    if (stage === "recover") return yield* recover();
    seedPolicy();
    return yield* cut();
  }), () => openCrashStores(dbPath));
  writeSync(1, `${JSON.stringify(proof)}\n`);
}
