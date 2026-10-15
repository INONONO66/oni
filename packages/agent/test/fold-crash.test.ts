import { turnIntent } from "../src/core/store/session-reads";
import { expect, test } from "bun:test";

import { sessionTree } from "./helpers/session-tree";
import { canonicalDigest, PlainValueSchema, SessionTurn } from "@openomni/protocol";
import { FoldCheckpointIntegrityError, foldHistoryState, hydrateSessionHistory, } from "../src/inspect/history";
import { crashMatrixMain, crashWitness, emitCrashWitness, sessionId } from "./helpers/crash-matrix";
import { foldCrashMain, foldCrashPoint } from "./helpers/fold-crash";
import { isolatedRun } from "./helpers/isolated";
import { requestLedger } from "./helpers/request-ledger";
import { seedPolicy } from "./helpers/seed-policy";

for (const point of foldCrashPoint.options) {
  test(`in-process witness at ${point}`, () => isolatedRun(async (ledger) => {
    seedPolicy();
    let cuts = 0;
    let revision = 0;
    let pinned = false;
    await foldCrashMain(point, (_bodies, pending, proof) => {
      cuts += 1;
      revision = proof.revision;
      const actions = sessionTree(ledger.kernel, sessionId);
      if (point === "fold_checkpoint_transaction_before_commit") {
        expect(actions.at(-1)?.kind).toBe("fold.checkpoint");
        expect(actions.length).toBeGreaterThan(proof.revision);
      } else {
        expect(actions.length).toBe(proof.revision);
        expect(
          canonicalDigest({
            foldVersion: 1,
            state: PlainValueSchema.parse(foldHistoryState(sessionId, actions)),
          }),
        ).toBe(proof.stateDigest);
      }
      if (point === "turn_context_snapshot_committed_before_model_entry") {
        const opened = actions.find(
          (action) => turnIntent(action) !== undefined,
        );
        const pin = SessionTurn.Intent.parse(opened?.intent.value).context;
        expect(opened?.id).toBe(pin.snapshotActionId);
        expect(pin.messageIds).toEqual(proof.messageIds);
        // The pin is a reference: the projection is rebuilt from the ledger at its source revision.
        expect(pin.projection).toBeUndefined();
        const rebuilt = hydrateSessionHistory(ledger.kernel, sessionId, pin.sourceRevision).history;
        expect(rebuilt.map((message) => message.info.id)).toEqual(pin.messageIds);
        expect(pin.projectionHash).toBe(
          canonicalDigest({ foldVersion: 1, projection: PlainValueSchema.parse(rebuilt) }),
        );
        pinned = true;
      }
      if (point === "compaction_result_checkpoint_committed_before_publication")
        expect(proof.publicationCount).toBe(0);
      if (point === "compaction_replacement_invalidates_prepared_projection") {
        expect(pending).toBeDefined();
        expect(ledger.kernel.actionById(pending?.id ?? "")).toBeUndefined();
      }
    });
    expect(cuts).toBe(1);
    expect(pinned).toBe(point === "turn_context_snapshot_committed_before_model_entry");
    if (point === "fold_checkpoint_tampered_before_load") {
      expect(() => hydrateSessionHistory(ledger.kernel, sessionId)).toThrow(
        FoldCheckpointIntegrityError,
      );
      const recording = requestLedger({ id: sessionId });
      expect(() => recording.commitBatch([])).toThrow(FoldCheckpointIntegrityError);
      expect(ledger.kernel.row(sessionId).revision).toBe(revision);
    } else if (point !== "turn_context_snapshot_committed_before_model_entry")
      expect(ledger.kernel.row(sessionId).revision).toBe(revision);
  }));
}

test("a failing transaction witness is propagated and rolls the inserted checkpoint back", () =>
  isolatedRun(async (ledger) => {
    seedPolicy();
    const failure = new Error("injected witness failure");
    await expect(
      foldCrashMain("fold_checkpoint_transaction_before_commit", () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(sessionTree(ledger.kernel, sessionId)).toHaveLength(2);
  }));

test("a failing stale-projection witness is not silently swallowed", () =>
  isolatedRun(async () => {
    seedPolicy();
    await expect(
      foldCrashMain("compaction_replacement_invalidates_prepared_projection", () => {
        throw new Error("injected stale-writer witness failure");
      }),
    ).rejects.toBeInstanceOf(Error);
  }));

for (const point of [
  "turn_intent_before_llm_entry",
  "delivery_admitted_before_turn_open",
  "outbound_reply_before_delivery_settle",
  "fold_checkpoint_transaction_before_commit",
] as const) {
  test(`the importable crash main dispatches ${point} through its injected exit`, () =>
    isolatedRun(async () => {
      seedPolicy();
      const exit = new Error("injected process exit");
      let output = "";
      await expect(
        crashMatrixMain([point, ":memory:", "initial"], (witness) =>
          emitCrashWitness(
            witness,
            (fd, value) => {
              expect(fd).toBe(1);
              output = value;
            },
            (code) => {
              expect(code).toBe(0);
              throw exit;
            },
          ),
        ),
      ).rejects.toBe(exit);
      expect(crashWitness.parse(JSON.parse(output)).crashPoint).toBe(point);
    }));
}

test("the importable crash main enters the original turn's resume seam", () =>
  isolatedRun(async () => {
    seedPolicy();
    requestLedger({ id: sessionId });
    const seen: ReturnType<typeof crashWitness.parse>[] = [];
    await crashMatrixMain(["turn_intent_before_llm_entry", ":memory:", "resume"], (witness) => {
      seen.push(witness);
      throw new Error("injected resume exit");
    });
    expect(seen).toHaveLength(1);
    expect(crashWitness.parse(seen[0]).openTurns).toMatchObject([{ resumeCount: 1 }]);
  }));

test("the crash process argument boundary rejects unsupported cuts", async () => {
  await expect(crashMatrixMain([])).rejects.toBeInstanceOf(Error);
});
