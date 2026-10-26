import { describe, expect, test } from "bun:test";
import { canonicalDigest, type LedgerAction, PlainValueSchema, SessionTurn } from "@oni/protocol";
import { Effect } from "effect";
import { deliveryActions } from "../src/core/journal/delivery";
import { turnIntentAction, turnTerminalAction } from "../src/core/journal/turn-rows";
import { actionPayloadBytes } from "../src/core/store/action-row";
import { configureAction } from "../src/core/store/configure";
import { turnIntent } from "../src/core/store/session-reads";
import { hydrateSessionHistory, restoreSessionHistory } from "../src/inspect/history";
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
          content: [{ kind: "text", text: content }],
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

/** One answered turn over `prompts`, then a second turn intent pinned by the fold writer; its rebuilt projection. */
function pinnedTurn(ledger: Ledger, prompts: readonly string[]) {
  const recording = requestLedger();
  const id = recording.identity.sessionId;
  const { kernel } = ledger;
  const turnId = recording.identity.turnId;
  for (const [index, content] of prompts.entries())
    deliverPrompt(recording, ledger, `prompt:${index}`, content, turnId);
  expect(
    recording.commitBatch([
      turnTerminalAction({
        id: `${id}:reply`,
        parentId: turnId,
        sessionId: id,
        turnId,
        result: { kind: "result", text: "a" },
        resumeCount: 0,
        boundaryActionId: null,
        at: 200,
      }),
    ]).ok,
  ).toBe(true);
  const pinnedId = `${id}:turn:2`;
  const intent = turnIntentAction({
    id: pinnedId,
    parentId: `${id}:reply`,
    sessionId: id,
    resultId: `${id}:result:2`,
    deliveryIds: [],
    generation: kernel.latestGenerationFor(id),
    resumeCount: 0,
    boundaryActionId: null,
    at: 300,
  });
  runAgentSync(recording.ledger.commit(intent));
  const node = kernel.actionById(pinnedId);
  const context = SessionTurn.Intent.parse(node?.intent.value).context;
  const history = hydrateSessionHistory(kernel, id, context.sourceRevision).history;
  // The row as written before the pin became a reference: the same context plus a copy of the projection.
  const copy: LedgerAction.Append = {
    ...intent,
    id: `${id}:turn:copy`,
    parentId: pinnedId,
    ts: 301,
    intent: {
      encodingVersion: 1,
      value: PlainValueSchema.parse({ ...SessionTurn.Intent.parse(node?.intent.value), context: { ...context, projection: history } }),
    },
  };
  const commitCopy = () => {
    const row = kernel.row(id);
    return runTestSync(
      Effect.result(
        kernel.commit({
          sessionId: id,
          owner: row.fenceOwner ?? "",
          fence: row.fence,
          now: 301,
          expectedRevision: row.revision,
          actions: [copy],
          state: row.state,
        }),
      ),
    );
  };
  return { kernel, id, node, context, history, copy, commitCopy };
}

describe("fold writer tail", () => {
  test("a 200k-token history whose projection-bearing intent is 1,354,023 B commits as a reference under the 1 MiB cap", () =>
    isolatedRun((ledger) => {
      // Two prompts, because one 1.35 MB prompt row would itself pass the cap.
      const { kernel, id, node, context, history, copy, commitCopy } = pinnedTurn(ledger, [
        "q".repeat(676_152),
        "q".repeat(676_153),
      ]);
      expect(actionPayloadBytes(copy)).toBe(1_354_023);
      expect(node === undefined ? 0 : actionPayloadBytes(node)).toBe(646);
      expect(context.projectionHash).toBe(
        canonicalDigest({ foldVersion: 1, projection: PlainValueSchema.parse(history) }),
      );
      const revision = kernel.row(id).revision;
      const refused = commitCopy();
      expect(refused._tag).toBe("Failure");
      if (refused._tag !== "Failure") return;
      expect(refused.failure).toMatchObject({ _tag: "SchemaRefused", actionId: copy.id, reason: "row_bytes" });
      expect(kernel.row(id).revision).toBe(revision);
    }));

  test("an old projection-bearing intent and a new reference-only intent read back the same pin", () =>
    isolatedRun((ledger) => {
      const { kernel, id, node, context, history, copy, commitCopy } = pinnedTurn(ledger, ["q", "r"]);
      expect(commitCopy()._tag).toBe("Success");
      const reference = turnIntent(node);
      const legacy = turnIntent(kernel.actionById(copy.id));
      expect(reference !== undefined && "context" in reference ? reference.context.projection : null).toBeUndefined();
      expect(legacy !== undefined && "context" in legacy ? legacy.context : null).toEqual({ ...context, projection: history });
      expect(reference).toEqual(SessionTurn.Intent.parse(node?.intent.value));
      const rebuilt = hydrateSessionHistory(kernel, id, context.sourceRevision).history;
      expect(rebuilt).toEqual(history);
      expect(rebuilt.map((message) => message.info.id)).toEqual(context.messageIds);
      expect(hydrateSessionHistory(kernel, id).history.map((message) => message.info.id)).toEqual(context.messageIds);
    }));

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
        // The last result is sized so the refused tail is exactly 5,026,719 B.
        const result = "y".repeat(call === 4 ? 893_583 : 900_000);
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
      expect(kernel.payloadBytes(id, 0, kernel.row(id).revision)).toBe(5_026_744);
      expect(restored.failure.data.telemetry).toMatchObject({ rows: 22, bytes: 5_026_744, pages: 1 });
      const again = runTestSync(Effect.result(restoreSessionHistory(kernel, id)));
      expect(again._tag === "Failure" ? { ...again.failure.data, telemetry: { ...again.failure.data.telemetry, ms: 0 } } : again).toEqual({
        ...restored.failure.data,
        telemetry: { ...restored.failure.data.telemetry, ms: 0 },
      });
    }));
});
