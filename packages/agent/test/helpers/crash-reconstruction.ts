import { generationSnapshot, configureAction } from "../../src/core/store/configure";
import { Database } from "bun:sqlite";
import { appendFileSync, writeSync } from "node:fs";
import { Cause, Effect, Exit, Layer } from "effect";
import { KERNEL_POLICY_REGISTRY } from "../../src/core/gate/compile";
import { GenerationHandlers } from "../../src/core/composition/compose";
import { AgentGenerationLive } from "./generation-layer";
import { makeSessionGenerations } from "../../src/core/session/run";

import { canonicalDigest, FoldCheckpoint, Message, PlainObjectSchema, PlainValueSchema, type LedgerAction, } from "@oni/protocol";
import { z } from "zod";
import { recordedCompaction, restoreContextRequest, restoredContextProjection, } from "../../src/plugins/compaction/restore";
import { executeCompaction } from "../../src/plugins/compaction/execute-cut";
import { GenerationUnavailable } from "../../src/core/ports/failure";
import { GenerationLayers, ObservationSink } from "../../src/core/ports/ports";
import { closeSessions } from "../../src/core/session/run";
import { reactivateSession } from "./wake-session";
import { FoldCheckpointIntegrityError, hydrateSessionHistory, } from "../../src/inspect/history";
import { compiledPolicy } from "./compiled-policy";
import { testExecutor } from "./executor";
import { isolated, isolatedLedger } from "./isolated";
import { openCrashStores } from "./crash-stores";
import { textMessage } from "./messages";
import { requestLedger } from "./request-ledger";
import { paddingActions, reconstructionSession as sessionId } from "./reconstruction-fixture";
import { seedPolicy } from "./seed-policy";
import { uniqueEntropy } from "./time";
import { allowConfigure, isolatedRuntime, withSessionServices, type SessionFixture, } from "./session-services";
import { foldProof, type foldCrashProof } from "./fold-crash";

// R1 and R3 retain their imported draft IDs; no duplicate campaign rows.
export const reconstructionPoint = z.enum([
  "fold_checkpoint_committed_before_wake",
  "context_restore_checkpoint_committed_before_publish",
  "fold_checkpoint_tampered_before_load",
  "same_id_result_after_checkpoint_before_wake",
  "open_tool_checkpoint_before_terminal",
  "captured_generation_missing_after_restart",
]);
type Point = z.infer<typeof reconstructionPoint>;
type Stop = (
  bodies: string[],
  pending: LedgerAction.Append | undefined,
  proof: z.infer<typeof foldCrashProof>,
) => void;

function proof() {
  return foldProof(sessionId);
}

function threshold(recording: ReturnType<typeof requestLedger>) {
  const remaining =
    256 - hydrateSessionHistory(isolatedLedger().kernel, sessionId).nonCheckpointActions;
  recording.commitBatch(paddingActions(sessionId, recording.identity.turnId, remaining));
}

function snapshot(executor: ReturnType<typeof testExecutor>, text: string) {
  return executor.run({ kind: "message", op: "assistant", intent: {}, effect: {} }, () =>
    Effect.succeed(PlainValueSchema.parse(textMessage("assistant", text, sessionId, "same-id"))),
  );
}

function restoreCut(recording: ReturnType<typeof requestLedger>, stop: Stop) {
  return Effect.gen(function* () {
    const bodies: string[] = [];
    const published: string[] = [];
    const executor = testExecutor({
      ...recording,
      policy: compiledPolicy(),
      observations: {
        publish: (_event, data) => {
          const observation = z.object({ id: z.string() }).safeParse(data);
          if (observation.success) published.push(observation.data.id);
        },
      },
      ledger: {
        ...recording.ledger,
        commit: (action) =>
          Effect.gen(function* () {
            const receipt = yield* recording.ledger.commit(action);
            if (
              action.kind === "compaction" &&
              PlainObjectSchema.parse(action.intent.value).op === "restore_context_projection" &&
              PlainObjectSchema.parse(action.effect.value).phase === "result"
            )
              stop(bodies, receipt.action, {
                ...proof(),
                publicationCount: published.filter((id) => id === receipt.action.id).length,
              });
            return receipt;
          }),
      },
    });
    yield* snapshot(executor, "earlier evidence ".repeat(200));
    yield* executor.run({ kind: "message", op: "assistant", intent: {}, effect: {} }, () =>
      Effect.succeed(
        PlainValueSchema.parse(textMessage("assistant", "answer", sessionId, "answer")),
      ),
    );
    yield* executeCompaction({
      history: hydrateSessionHistory(isolatedLedger().kernel, sessionId).history,
      executor,
      events: { publish: () => undefined },
      options: {
        contextWindowTokens: 10_000,
        protectRecentMessages: 1,
        onSummarize: () =>
          Effect.sync(() => {
            bodies.push("summary");
            return "checkpoint";
          }),
      },
      identity: { traceId: "restore-crash", sessionId },
      dispatch: { trigger: "yield" },
    });
    const kernel = isolatedLedger().kernel;
    const source = kernel.latestFoldCheckpoint(sessionId).checkpoint;
    const result =
      source?.parentId === null ? undefined : kernel.actionById(source?.parentId ?? "");
    if (result?.parentId === null || result === undefined)
      throw new Error("missing compacted source");
    const record = yield* recordedCompaction(result.parentId, result);
    const history = hydrateSessionHistory(kernel, sessionId).history;
    yield* executor.run(
      restoreContextRequest(
        result.parentId,
        canonicalDigest({ foldVersion: 1, projection: PlainValueSchema.parse(history) }),
      ),
      () => Effect.succeed(restoredContextProjection(history, result.parentId ?? "", record)),
    );
  });
}

export function reconstructionCut(point: Point, dbPath: string, stop: Stop) {
  return Effect.gen(function* () {
    const recording = requestLedger({ id: sessionId });
    const executor = testExecutor({
      ...recording,
      policy: compiledPolicy(),
      observations: { publish: () => undefined },
    });
    if (point === "context_restore_checkpoint_committed_before_publish")
      return yield* restoreCut(recording, stop);
    if (point === "captured_generation_missing_after_restart") {
      const newer = generationSnapshot({
        generation: 2,
        revertTo: 1,
        tools: [],
        system: { preset: "newer", blocks: [] },
        policyGeneration: 1,
      });
      recording.commitBatch(
        [
          configureAction({
            id: "newer-generation",
            sessionId,
            parentId: recording.identity.turnId,
            operation: "system.blocks.set",
            snapshot: newer,
            at: 100,
          }),
        ],
        { generation: { toolsGeneration: 2, systemHash: newer.systemHash, policyGeneration: 1 } },
      );
      return stop([], undefined, proof());
    }
    if (point === "open_tool_checkpoint_before_terminal") {
      const message = textMessage("assistant", "", sessionId, "tool-message");
      message.parts.push({
        id: "open-part",
        sessionID: sessionId,
        messageID: message.info.id,
        type: "tool",
        tool: "write",
        callID: "open-call",
        state: { status: "pending", input: {} },
      });
      yield* executor.run({ kind: "message", op: "assistant", intent: {}, effect: {} }, () =>
        Effect.succeed(PlainValueSchema.parse(message)),
      );
      return yield* executor.run(
        {
          kind: "tool",
          op: "write",
          intent: {},
          effect: { category: "mutation" },
          toolObservation: { turnId: recording.identity.turnId, callId: "open-call" },
        },
        () =>
          Effect.sync(() => {
            threshold(recording);
            appendFileSync(`${dbPath}.effect`, "write-once\n");
            stop(["tool"], undefined, proof());
            return "uncommitted";
          }),
      );
    }
    yield* snapshot(executor, "before checkpoint");
    threshold(recording);
    if (point === "same_id_result_after_checkpoint_before_wake")
      yield* snapshot(executor, "after checkpoint");
    stop([], undefined, proof());
  });
}

/** Deliberate storage fault, not a power-loss claim. */
export function corruptCheckpoint(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.run(
      "UPDATE action SET effect = json_set(effect, '$.result.stateHash', 'sha256:corrupt') WHERE kind = 'fold.checkpoint'",
    );
  } finally {
    db.close();
  }
}

export const reconstructionRecovery = z.object({
  runnerCount: z.number(),
  captures: z.array(z.number()),
  rangeReads: z.array(z.object({ cursor: z.number(), limit: z.number() })),
  refusal: z.enum(["FoldCheckpointIntegrityError", "GenerationUnavailable"]).nullable(),
  loaded: z
    .object({
      revision: z.number(),
      state: FoldCheckpoint.State,
      history: z.array(Message.WithParts),
    })
    .nullable(),
  runnerHistory: z.array(Message.WithParts),
});

function restartGenerations(captures: number[], missing: boolean) {
  return Layer.effect(
    GenerationLayers,
    Effect.gen(function* () {
      const snapshot = isolatedLedger().kernel.generationFor(sessionId, missing ? 2 : 1);
      if (snapshot === undefined) throw new Error("restart fixture generation missing");
      const observations = yield* ObservationSink;
      const owner = yield* makeSessionGenerations({
        id: { sessionId, generation: snapshot.generation },
        snapshot,
        activate: Effect.void,
        layer: Layer.mergeAll(
          AgentGenerationLive({ snapshot, policy: compiledPolicy(), definitions: [] }),
          Layer.succeed(ObservationSink, observations),
          Layer.succeed(GenerationHandlers, KERNEL_POLICY_REGISTRY),
        ),
      });
      return {
        initialize: () => Effect.void,
        settle: owner.settle,
        drain: owner.drain,
        configure: <A>(
          _id: import("@oni/protocol").SessionGeneration.Id,
          _snapshot: import("@oni/protocol").SessionGeneration.Snapshot,
          commit: Effect.Effect<A, import("../../src/core/ports/failure").SessionError>,
        ) => commit,
        capture: (id: import("@oni/protocol").SessionGeneration.Id) => {
          captures.push(id.generation);
          return id.generation === snapshot.generation
            ? owner.capture()
            : Effect.fail(new GenerationUnavailable({ generation: id.generation }));
        },
      };
    }),
  );
}

function refusalFromCause<E>(cause: Cause.Cause<E>) {
  const error = Cause.squash(cause);
  if (FoldCheckpointIntegrityError.isInstance(error))
    return "FoldCheckpointIntegrityError" as const;
  if (error instanceof GenerationUnavailable) return "GenerationUnavailable" as const;
  return null;
}

function recoverReconstruction(point: Point, dbPath: string) {
  return isolated(
    (ledger) =>
      Effect.scoped(
        Effect.gen(function* () {
          seedPolicy();
          const rangeReads: { cursor: number; limit: number }[] = [];
          const adapter = ledger.session.actions;
          const range = adapter.range.bind(adapter);
          adapter.range = (id, cursor, limit) => {
            rangeReads.push({ cursor, limit });
            return range(id, cursor, limit);
          };
          let runnerCount = 0;
          const captures: number[] = [];
          const fixture: SessionFixture = {
            ...isolatedRuntime(),
            observations: { publish: () => undefined },
            clock: () => 100_000,
            entropy: uniqueEntropy("recover"),
            authorizeConfigure: allowConfigure,
          };
          let runnerHistory: Message.WithParts[] = [];
          const wake = reactivateSession(
            sessionId,
            (input) =>
              Effect.sync(() => {
                runnerCount += 1;
                runnerHistory = Array.from(input.history ?? []);
                return { kind: "result" as const, text: "" };
              }),
            fixture,
          );
          const work = wake.pipe(
            Effect.provide(
              restartGenerations(captures, point === "captured_generation_missing_after_restart"),
            ),
          );
          let refusal: z.infer<typeof reconstructionRecovery>["refusal"] = null;
          let loaded: z.infer<typeof reconstructionRecovery>["loaded"] = null;
          try {
            const expectsRefusal =
              point === "fold_checkpoint_tampered_before_load" ||
              point === "captured_generation_missing_after_restart";
            if (expectsRefusal) {
              const exit = yield* Effect.exit(withSessionServices(work, fixture));
              if (Exit.isSuccess(exit)) throw new Error("faulted wake entered successfully");
              refusal = refusalFromCause(exit.cause);
              if (refusal === null) return yield* Effect.failCause(exit.cause);
            } else {
              loaded = hydrateSessionHistory(ledger.kernel, sessionId);
              if (point !== "open_tool_checkpoint_before_terminal")
                yield* withSessionServices(work, fixture);
            }
            return reconstructionRecovery.parse({
              runnerCount,
              captures,
              rangeReads,
              refusal,
              loaded,
              runnerHistory,
            });
          } finally {
            adapter.range = range;
            yield* closeSessions(fixture);
          }
        }),
      ),
    () => openCrashStores(dbPath),
  );
}

if (import.meta.main) {
  const [point, dbPath] = z.tuple([reconstructionPoint, z.string()]).parse(process.argv.slice(2));
  writeSync(1, JSON.stringify(await recoverReconstruction(point, dbPath)));
}
