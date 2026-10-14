import { describe, expect, test } from "bun:test";
import { canonicalDigest, type LedgerAction } from "@openomni/protocol";
import { Effect } from "effect";
import { deliveryActions } from "../src/core/journal/delivery";
import { turnIntentAction, turnTerminalAction } from "../src/core/journal/turn-rows";
import { configureAction } from "../src/core/store/configure";
import { restoreSessionHistory } from "../src/inspect/history";
import { runAgentSync } from "./helpers/executor";
import { isolatedRun, runTestSync } from "./helpers/isolated";
import { nth } from "./helpers/nth";
import { paddingActions } from "./helpers/reconstruction-fixture";
import { requestLedger } from "./helpers/request-ledger";

type Recording = ReturnType<typeof requestLedger>;
type Ledger = Parameters<Parameters<typeof isolatedRun>[0]>[0];

function deliverPrompt(recording: Recording, ledger: Ledger, key: string, content: string, turnId: string): void {
  const id = recording.identity.sessionId;
  const prompt = nth(
    deliveryActions(
      [
        {
          id: `${id}:${key}`,
          sessionId: id,
          kind: "prompt",
          content,
          origin: { encodingVersion: 1, value: {} },
          status: "pending",
          consumedBy: null,
          consumedAt: null,
          createdAt: 100,
          ordinal: 1,
        },
      ],
      { kind: "turn", turnId },
      "after_tools",
      ledger.kernel.latestAction(id)?.id ?? null,
    ),
    0,
  );
  runAgentSync(recording.ledger.commit(prompt));
}

function meterWriter(ledger: Ledger) {
  const counts = { commits: 0, refused: 0, rows: 0, scans: 0 };
  const { kernel } = ledger;
  const store = ledger.session.actions;
  const commit = kernel.commit;
  const range = store.range.bind(store);
  const payloadBytes = kernel.payloadBytes;
  kernel.payloadBytes = (sessionId, after, through) => {
    counts.scans += 1;
    return payloadBytes(sessionId, after, through);
  };
  kernel.commit = (input) => {
    counts.commits += 1;
    return commit(input).pipe(
      Effect.tapError((error) =>
        Effect.sync(() => {
          if ("reason" in error && error.reason === "row_bytes") counts.refused += 1;
        }),
      ),
    );
  };
  store.range = (sessionId, cursor, limit) => {
    const rows = range(sessionId, cursor, limit);
    counts.rows += rows.length;
    return rows;
  };
  return counts;
}

describe("fold writer tail", () => {
  test("a turn intent over a 200k-token history pins a reference, not a copy of the projection", () =>
    isolatedRun((ledger) => {
      const recording = requestLedger();
      const id = recording.identity.sessionId;
      let turnId = recording.identity.turnId;
      const intents: string[] = [];
      // Five 335 KB prompts fold to ~1.68 MB of projection, past the 1 MiB row cap a copy would hit at turn four.
      for (let turn = 0; turn < 5; turn += 1) {
        deliverPrompt(recording, ledger, `prompt:${turn}`, "q".repeat(335_000), turnId);
        expect(
          recording.commitBatch([
            turnTerminalAction({
              id: `${id}:reply:${turn}`,
              parentId: turnId,
              sessionId: id,
              turnId,
              result: { kind: "result", text: "a" },
              resumeCount: 0,
              boundaryActionId: null,
              at: 200 + turn,
            }),
          ]).ok,
        ).toBe(true);
        const generation = ledger.kernel.latestGenerationFor(id);
        turnId = `${id}:turn:${turn + 2}`;
        runAgentSync(
          recording.ledger.commit(turnIntentAction({
            id: turnId,
            parentId: `${id}:reply:${turn}`,
            sessionId: id,
            resultId: `${id}:result:${turn + 2}`,
            deliveryIds: [],
            generation,
            resumeCount: 0,
            boundaryActionId: null,
            at: 300 + turn,
          })),
        );
        intents.push(turnId);
      }
      const stored = intents.map((intent) => JSON.stringify(ledger.kernel.actionById(intent)));
      expect(stored.map((text) => text.includes('"projection"'))).toEqual([false, false, false, false, false]);
      expect(stored.map((text) => text.includes('"projectionHash"'))).toEqual([true, true, true, true, true]);
    }));

  test("a commit below both thresholds reads no history", () =>
    isolatedRun((ledger) => {
      const recording = requestLedger();
      const id = recording.identity.sessionId;
      const turnId = recording.identity.turnId;
      expect(recording.commitBatch(paddingActions(id, turnId, 3, "seed")).ok).toBe(true);
      const counts = meterWriter(ledger);
      for (let index = 0; index < 10; index += 1)
        expect(recording.commitBatch(paddingActions(id, turnId, 1, `late:${index}`)).ok).toBe(true);
      expect(counts).toEqual({ commits: 10, refused: 0, rows: 0, scans: 0 });
    }));

  test("after a row-cap refusal each commit lands once without rehydrating, and restore refuses once typed", () =>
    isolatedRun((ledger) => {
      const recording = requestLedger();
      const id = recording.identity.sessionId;
      const turnId = recording.identity.turnId;
      const { kernel } = ledger;
      const checkpoint = { everyActions: 4, maxTailBytes: 4 * 1024 * 1024 };
      expect(
        recording.commitBatch([
          configureAction({
            settings: { checkpoint, followUp: "all", steering: "all" },
            snapshot: kernel.latestGenerationFor(id),
            operation: "compose",
            parentId: kernel.latestAction(id)?.id ?? null,
            sessionId: id,
            id: `${id}:configure:checkpoint`,
            at: 100,
          }),
        ]).ok,
      ).toBe(true);
      // A 530 KB prompt folds into a checkpoint just past the 1 MiB row cap.
      deliverPrompt(recording, ledger, "big", "x".repeat(530_000), turnId);
      const counts = meterWriter(ledger);
      for (let index = 0; index < 8; index += 1)
        expect(recording.commitBatch(paddingActions(id, turnId, 1, `pad:${index}`)).ok).toBe(true);
      expect(counts).toEqual({ commits: 8, refused: 0, rows: 0, scans: 0 });
      expect(kernel.latestFoldCheckpoint(id).checkpoint).toBeUndefined();

      let parentId = turnId;
      for (let call = 0; call < 5; call += 1) {
        const tool = `${id}:tool:${call}`;
        const result = "y".repeat(900_000);
        const rows: LedgerAction.Append[] = [
          {
            id: tool,
            sessionId: id,
            parentId,
            kind: "tool",
            ts: 160 + call,
            irreversible: true,
            intent: { encodingVersion: 1, value: { phase: "intent", op: "echo", value: { text: "x" } } },
            effect: { encodingVersion: 1, value: { phase: "pending" } },
          },
          {
            id: `${tool}:result`,
            sessionId: id,
            parentId: tool,
            kind: "tool",
            ts: 190 + call,
            irreversible: true,
            intent: { encodingVersion: 1, value: { phase: "result", op: "echo" } },
            effect: {
              encodingVersion: 1,
              value: { phase: "result", terminal: "executed", result, resultHash: canonicalDigest(result) },
            },
          },
        ];
        for (const row of rows) runAgentSync(recording.ledger.commit(row));
        parentId = `${tool}:result`;
      }
      const restored = runTestSync(Effect.result(restoreSessionHistory(kernel, id)));
      expect(restored._tag).toBe("Failure");
      if (restored._tag !== "Failure") return;
      expect(restored.failure.data.code).toBe("budget");
      expect(restored.failure.data.maxTailBytes).toBe(4 * 1024 * 1024);
      expect(restored.failure.data.revision).toBe(kernel.row(id).revision);
    }));
});
