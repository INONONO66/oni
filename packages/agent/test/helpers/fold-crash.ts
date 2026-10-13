import { AgentFailure } from "../../src/core/store/errors";
import { canonicalDigest, FoldCheckpoint, PlainObjectSchema, PlainValueSchema, type LedgerAction, } from "@openomni/protocol";
import { z } from "zod";
import { Effect } from "effect";
import { runAgent } from "./executor";
import { allowConfigure, isolatedRuntime, withSessionServices, type SessionFixture, } from "./session-services";
import { isolatedLedger } from "./isolated";
import { CompactionPredecessorError } from "../../src/plugins/compaction/successor";
import { closeSessions } from "../../src/core/session/run";
import { session } from "../../src/testing/registry";
import { hydrateSessionHistory } from "../../src/inspect/history";
import { foldCheckpointAction } from "../../src/core/journal/commit";
import { requireCommit } from "../../src/testing/commit";
import { requestLedger } from "./request-ledger";
import { paddingActions, reconstructionFixture, reconstructionSession, } from "./reconstruction-fixture";

export const foldCrashPoint = z.enum([
  "fold_checkpoint_committed_before_wake",
  "fold_checkpoint_transaction_before_commit",
  "fold_checkpoint_tampered_before_load",
  "turn_context_snapshot_committed_before_model_entry",
  "compaction_result_checkpoint_committed_before_publication",
  "compaction_replacement_invalidates_prepared_projection",
]);
type Point = z.infer<typeof foldCrashPoint>;
export const foldCrashProof = z
  .object({
    revision: z.number(),
    digest: z.string(),
    stateDigest: z.string(),
    messageIds: z.array(z.string()),
    checkpointId: z.string().nullable(),
    publicationCount: z.number().int().nonnegative().optional(),
  })
  .strict();
type Proof = z.infer<typeof foldCrashProof>;
type Stop = (bodies: string[], pending: LedgerAction.Append | undefined, proof: Proof) => void;

/** Canonical fold-state proof for one session, read from the isolated kernel. */
export function foldProof(sessionId: string): Proof {
  const kernel = isolatedLedger().kernel;
  const loaded = hydrateSessionHistory(kernel, sessionId);
  return {
    revision: loaded.revision,
    digest: canonicalDigest(loaded.history),
    stateDigest: canonicalDigest({ foldVersion: 1, state: PlainValueSchema.parse(loaded.state) }),
    messageIds: loaded.history.map((message) => message.info.id),
    checkpointId: kernel.latestFoldCheckpoint(sessionId).checkpoint?.id ?? null,
  };
}

function proof(): Proof {
  return foldProof(reconstructionSession);
}

function transactionCut(stop: Stop) {
  const recording = requestLedger({ id: reconstructionSession });
  const before = proof();
  const rollback = new Error("injected transaction rollback");
  try {
    isolatedLedger().session.transaction(() => {
      requireCommit(
        recording.commitBatch(
          paddingActions(reconstructionSession, recording.identity.turnId, 254),
        ),
      );
      stop([], undefined, before);
      // The injected in-process boundary returns; the real process exited above.
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
}

async function tamperedCut(stop: Stop) {
  const recording = requestLedger({ id: reconstructionSession });
  const before = proof();
  const checkpoint = foldCheckpointAction({
    sessionId: reconstructionSession,
    parentId: recording.identity.turnId,
    revision: before.revision,
    at: 100,
    reason: "interval",
    state: hydrateSessionHistory(isolatedLedger().kernel, reconstructionSession).state,
  });
  const effect = FoldCheckpoint.Effect.parse(checkpoint.effect.value);
  const receipt = await runAgent(
    recording.ledger.commit({
      ...checkpoint,
      effect: {
        encodingVersion: 1,
        value: PlainValueSchema.parse({
          ...effect,
          result: { ...effect.result, stateHash: "sha256:tampered" },
        }),
      },
    }),
  );
  stop([], undefined, { ...before, revision: receipt.revision, checkpointId: receipt.action.id });
}

async function contextCut(stop: Stop) {
  const runtime: SessionFixture = {
    ...isolatedRuntime(),
    observations: { publish: () => undefined },
    clock: () => 100,
    authorizeConfigure: allowConfigure,
  };
  return runAgent(
    Effect.scoped(
      withSessionServices(
        Effect.gen(function* () {
          const handle = yield* session(
            {
              id: reconstructionSession,
              role: "resident",
              runner: () =>
                Effect.sync(() => {
                  stop([], undefined, proof());
                  return { kind: "result" as const, text: "" };
                }),
            },
            runtime,
          );
          yield* handle.prompt("pinned input");
        }).pipe(Effect.ensuring(closeSessions(runtime).pipe(Effect.orDie))),
        runtime,
      ),
    ),
  );
}

async function resultCut(stop: Stop) {
  const fixture = await reconstructionFixture(
    (action, recording, bodies, publications) =>
      Effect.gen(function* () {
        const receipt = yield* recording.ledger.commit(action);
        if (
          action.kind === "compaction" &&
          PlainObjectSchema.parse(action.effect.value).phase === "result"
        )
          stop([...bodies], receipt.action, { ...proof(), publicationCount: publications.length });
        return receipt;
      }),
    { updates: 2, padding: 0 },
  );
  await fixture.compact();
}

async function staleCut(stop: Stop) {
  let original: string | undefined;
  const fixture = await reconstructionFixture(
    (action, recording, bodies) =>
      Effect.gen(function* () {
        if (action.kind === "compaction") {
          const intent = PlainObjectSchema.parse(action.intent.value);
          if (intent.phase === "intent") original ??= action.id;
          if (action.parentId === original && intent.phase === "boundary")
            yield* Effect.try({
              try: () => stop([...bodies], action, proof()),
              catch: (cause) =>
                new AgentFailure({ operation: "test.witness", cause: String(cause) }),
            });
        }
        return yield* recording.ledger.commit(action);
      }),
    { updates: 2, padding: 0 },
  );
  try {
    await fixture.compact(async () => {
      await fixture.compact(async () => "replacement");
      return "stale";
    });
  } catch (error) {
    if (!CompactionPredecessorError.isInstance(error)) throw error;
  }
}

/** Exact SQLite/action seams; an injected returning boundary makes every path testable in-process. */
export async function foldCrashMain(point: Point, stop: Stop) {
  switch (point) {
    case "fold_checkpoint_transaction_before_commit":
      return transactionCut(stop);
    case "fold_checkpoint_tampered_before_load":
      return tamperedCut(stop);
    case "turn_context_snapshot_committed_before_model_entry":
      return contextCut(stop);
    case "compaction_result_checkpoint_committed_before_publication":
      return resultCut(stop);
    case "compaction_replacement_invalidates_prepared_projection":
      return staleCut(stop);
    case "fold_checkpoint_committed_before_wake": {
      const fixture = await reconstructionFixture();
      await fixture.compact();
      await fixture.suffix();
      stop(fixture.bodies, undefined, proof());
    }
  }
}
