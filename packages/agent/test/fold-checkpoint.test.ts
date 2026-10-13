import { Effect, Logger, References } from "effect";
import { runAgentSync } from "./helpers/executor";
import { expect, spyOn, test } from "bun:test";
import * as SessionHandleStore from "../src/core/store/fence";
import { sessionTree } from "./helpers/session-tree";
import {
  canonicalDigest,
  type CheckpointPolicy,
  FoldCheckpoint,
  type LedgerAction,
  type PlainObject,
  PlainValueSchema,
  SessionTurn,
} from "@openomni/protocol";
import { createRunState } from "../src/core/turn";
import { evaluateBudget } from "../src/core/budget";
import { testBudget } from "./helpers/approval-policy";
import { runInput } from "./helpers/run-input";
import { checkpointPolicy, DEFAULT_CHECKPOINT_POLICY, foldHistoryState, hydrateSessionHistory, RestoreRefused, restoreSessionHistory } from "../src/inspect/history";
import { actionPayloadBytes } from "../src/core/store/action-hash";
import { deliveryActions, foldCheckpointAction, turnTerminalAction } from "../src/core/commit";
import { bounded } from "./helpers/bounded";
import { effectOf, intentOf } from "./helpers/crash-matrix";
import { commitReceivedMessage } from "./helpers/ingress";
import { isolated, isolatedLedger, isolatedRun, runTestSync } from "./helpers/isolated";
import { reopenableLedger } from "./helpers/reopenable-ledger";
import { allowConfigure, isolatedRuntime, type SessionFixture, withSessionServices } from "./helpers/session-services";
import { testTurnDispatcher } from "./helpers/service-layers";
import { fixtureConfigHead, fixtureTraceContext, prepareChatFixture } from "./helpers/chat-services";
import { seedPolicy } from "./helpers/seed-policy";
import { uniqueEntropy } from "./helpers/time";
import { createSessionChatRunner, resolveSessionRuntime, type SessionRunnerInput } from "../src/core/run";
import { createController } from "../src/testing/controller";
import { nth } from "./helpers/nth";
import { requestLedger } from "./helpers/request-ledger";
import { textMessage } from "./helpers/messages";
import { paddingActions, reconstructionFixture, reconstructionSession, } from "./helpers/reconstruction-fixture";

function expectReplay(sessionId: string) {
  const kernel = isolatedLedger().kernel;
  const hydrated = hydrateSessionHistory(kernel, sessionId);
  const full = foldHistoryState(sessionId, sessionTree(kernel, sessionId));
  expect(canonicalDigest(PlainValueSchema.parse(hydrated.state))).toBe(
    canonicalDigest(PlainValueSchema.parse(full)),
  );
  return hydrated;
}

test("below-interval audit commits do not replay the unchanged history prefix", () => isolatedRun((ledger) => {
  const recording = requestLedger();
  const range = spyOn(ledger.session.actions, "range");
  try {
    expect(
      recording.commitBatch(
        paddingActions(recording.identity.sessionId, recording.identity.turnId, 1),
      ).ok,
    ).toBe(true);
    expect(range).not.toHaveBeenCalled();
  } finally {
    range.mockRestore();
  }
  expectReplay(recording.identity.sessionId);
}));

for (const count of [255, 256, 257]) {
  test(`durable cadence at ${count} non-checkpoint actions, including empty suffix`, () => isolatedRun((ledger) => {
    const recording = requestLedger();
    const id = recording.identity.sessionId;
    const committed = recording.commitBatch(
      paddingActions(id, recording.identity.turnId, count - 2),
    );
    expect(committed.ok).toBe(true);
    const actions = sessionTree(ledger.kernel, id);
    const checkpoints = actions.filter((action) => action.kind === "fold.checkpoint");
    expect(checkpoints).toHaveLength(count >= 256 ? 1 : 0);
    if (count >= 256) {
      const checkpoint = nth(checkpoints, 0);
      expect(checkpoint.ordinal).toBe(257);
      const result = FoldCheckpoint.Effect.parse(checkpoint.effect.value).result;
      expect(result.revision).toBe(256);
      expect(result.stateHash).toBe(
        canonicalDigest({
          foldVersion: 1,
          state: PlainValueSchema.parse(
            foldHistoryState(
              id,
              actions.filter((action) => action.ordinal <= result.revision),
            ),
          ),
        }),
      );
    }
    const loaded = expectReplay(id);
    expect(loaded.revision).toBe(actions.length);
    expect(loaded.nonCheckpointActions).toBe(count >= 256 ? count - 256 : count);
    expect(() => ledger.session.actions.range(id, 0, 257)).toThrow();
    expect(() => ledger.kernel.historyPage(id, { limit: 257 })).toThrow();
    expect("tree" in SessionHandleStore).toBe(false);
  }));
}

/** Pins `settings.checkpoint` through a later `compose` configure row (#1347): settings data, not code. */
function pinCheckpointPolicy(
  recording: ReturnType<typeof requestLedger>,
  kernel: ReturnType<typeof isolatedLedger>["kernel"],
  checkpoint: CheckpointPolicy,
) {
  const id = recording.identity.sessionId;
  const committed = recording.commitBatch([
    SessionHandleStore.configureAction({
      id: `${id}:configure:checkpoint`,
      sessionId: id,
      parentId: kernel.latestAction(id)?.id ?? null,
      operation: "compose",
      snapshot: kernel.latestGenerationFor(id),
      settings: { steering: "all", followUp: "all", checkpoint },
      at: 100,
    }),
  ]);
  expect(committed.ok).toBe(true);
  expect(checkpointPolicy(kernel, id)).toEqual(checkpoint);
}

/** A stepping clock: each read advances by `step`, so `telemetry.ms` is exact, never timing luck. */
function steppingClock(step: number) {
  let at = 0;
  return () => {
    at += step;
    return at;
  };
}

/** The executor's row shapes for one charged model step and one tool, stamped by the kernel clock (#1347). */
function chargedTurnRows(sessionId: string, turnId: string): LedgerAction.Append[] {
  const row = (
    id: string,
    kind: LedgerAction.Kind,
    parentId: string,
    intent: PlainObject,
    effect: PlainObject,
    ts: number,
  ): LedgerAction.Append =>
    LedgerActionAppend({
      id,
      sessionId,
      parentId,
      kind,
      ts,
      irreversible: true,
      intent: { encodingVersion: 1, value: intent },
      effect: { encodingVersion: 1, value: effect },
    });
  const llm = `${sessionId}:llm`;
  const tool = `${sessionId}:tool`;
  return [
    row(llm, "llm", turnId, { phase: "intent", op: "chat", value: {} }, { phase: "pending" }, 110),
    row(`${llm}:1`, "llm", llm, { phase: "intent", op: "chat", value: {}, attempt: 1, maxAttempts: 3, retryReason: null, effectHash: "h", routeChange: null }, { phase: "pending" }, 111),
    row(`${llm}:1:result`, "llm", `${llm}:1`, { phase: "result", op: "chat" }, { phase: "result", terminal: "executed", effect: {}, usageProvenance: "reported", evidence: { usage: { inputTokens: 40, outputTokens: 7 } } }, 150),
    row(`${llm}:result`, "llm", llm, { phase: "result", op: "chat" }, { phase: "result", terminal: "executed", effect: {} }, 151),
    row(tool, "tool", turnId, { phase: "intent", op: "echo", value: { text: "x" } }, { phase: "pending" }, 160),
    row(`${tool}:result`, "tool", tool, { phase: "result", op: "echo" }, { phase: "result", terminal: "executed", result: "x", resultHash: canonicalDigest("x") }, 190),
  ];
}

const LedgerActionAppend = (append: LedgerAction.Append): LedgerAction.Append => append;

test("#1347 a reactivated turn resumes its checkpointed budget counters instead of resetting them", () => isolatedRun((ledger) => {
  const recording = requestLedger();
  const id = recording.identity.sessionId;
  const kernel = ledger.kernel;
  // Checkpoint every 4 rows so the charged step lands in a checkpoint AND a suffix.
  pinCheckpointPolicy(recording, kernel, { everyActions: 4, maxTailBytes: 4 * 1024 * 1024 });
  expect(recording.commitBatch(chargedTurnRows(id, recording.identity.turnId)).ok).toBe(true);
  expect(kernel.latestFoldCheckpoint(id).checkpoint).toBeDefined();
  const restored = expectReplay(id);
  const expected: FoldCheckpoint.BudgetState = {
    startTime: 100, chargedAt: 190, turns: 1, toolCalls: 1, toolRuntimeMs: 30,
    totalInputTokens: 40, totalOutputTokens: 7, toolsThrough: 190, openTools: [],
  };
  expect(restored.state.budgetState).toEqual(expected);
  const checkpoint = kernel.latestFoldCheckpoint(id).checkpoint;
  expect(FoldCheckpoint.Effect.parse(checkpoint?.effect.value).result.state.budgetState).toMatchObject({ turns: 1, totalInputTokens: 40 });
  // The resumed run charges the restored counters on its own clock: 90 ms already elapsed, one turn, one call.
  let time = 5_000;
  const state = createRunState({ ...runInput([{ role: "user", content: "hi" }]), budgetState: restored.state.budgetState }, { now: () => time, id: () => "m" });
  expect(state.budgetState).toEqual({ startTime: 5_000 - 90, turns: 1, toolCalls: 1, toolRuntimeMs: 30, totalInputTokens: 40, totalOutputTokens: 7 });
  expect(evaluateBudget(state.budgetState, () => time, testBudget({ maxTurns: 1 }))).toMatchObject({ status: "exceeded", exceededLimit: "turns" });
  time += 10;
  expect(evaluateBudget(state.budgetState, () => time, testBudget({ maxWallTimeMs: 100 }))).toMatchObject({ status: "exceeded", elapsedMs: 100, exceededLimit: "wall time" });
  // A fresh run (no restored counters) still starts from zero.
  expect(createRunState(runInput([{ role: "user", content: "hi" }]), { now: () => time, id: () => "m" }).budgetState).toEqual({ startTime: time, turns: 0, toolCalls: 0, toolRuntimeMs: 0, totalInputTokens: 0, totalOutputTokens: 0 });
}));

test("#1347 a crash-open reactivation hands the charged counters to the resumed run, which still stops with AgentStopError budget", () => {
  const ledger = reopenableLedger("1347-budget-");
  return isolated(
    Effect.scoped(
      Effect.gen(function* () {
        const id = "charged";
        const turnId = `${id}:turn`;
        const kernel = () => isolatedLedger().kernel;
        seedPolicy();
        yield* kernel().materialize({
          id, role: "resident", parentId: null, tools: [], system: { preset: "", blocks: [] },
          policyGeneration: 1, actionId: "initial", at: 1,
        });
        const generation = SessionHandleStore.latestGeneration(sessionTree(kernel(), id));
        const lease = yield* kernel().adoptFence({ sessionId: id, owner: "crashed", fence: kernel().row(id).fence + 1 });
        // One model step charged under an open turn, then the process dies: no turn terminal.
        yield* kernel().commit({
          sessionId: id, owner: "crashed", fence: lease.fence, now: 2,
          expectedRevision: kernel().row(id).revision, state: "running",
          actions: [
            {
              id: turnId, sessionId: id, parentId: "initial", kind: "turn", irreversible: true, ts: 2,
              intent: {
                encodingVersion: 1,
                value: PlainValueSchema.parse(SessionTurn.DecodeIntent.parse({
                  phase: "intent", resultId: `${id}:result`, deliveryIds: [], resumeCount: 0, boundaryActionId: "initial",
                  toolsGeneration: 1, toolsHash: generation.toolsHash, systemHash: generation.systemHash, policyGeneration: 1,
                })),
              },
              effect: { encodingVersion: 1, value: { phase: "pending" } },
            },
            ...chargedTurnRows(id, turnId),
          ],
        });
        expect(hydrateSessionHistory(kernel(), id).state.budgetState).toMatchObject({ turns: 1, toolCalls: 1 });
        ledger.reopen();
        const runtime: SessionFixture = {
          observations: { publish: () => undefined }, clock: () => 2_000, entropy: uniqueEntropy("boot2"),
          authorizeConfigure: allowConfigure, ...isolatedRuntime(),
        };
        const inputs: SessionRunnerInput[] = [];
        let modelCalls = 0;
        const runner = createSessionChatRunner({
          prepare: (input) => Effect.gen(function* () {
            inputs.push(input);
            return prepareChatFixture({
              traceContext: fixtureTraceContext(input),
              config: {
                ...fixtureConfigHead((yield* testTurnDispatcher(input, runtime)).executor),
                // The crashed turn already spent its one turn.
                budget: testBudget({ maxTurns: 1 }),
                llm: { run: () => Effect.sync(() => { modelCalls += 1; return { type: "stop" }; }) },
              },
            });
          }),
        });
        const result = yield* withSessionServices(
          Effect.gen(function* () {
            const resolved = yield* resolveSessionRuntime(runtime);
            const controller = yield* createController(kernel(), id, runner, resolved, {
              reactivate: () => Effect.die("no reactivation in recovery test"),
              release: () => undefined,
            }, yield* Effect.scope);
            return yield* controller.reconcile();
          }),
          runtime,
        );
        // Crash-open: the same turn resumes, and the restored counters stop it before any model call.
        expect(inputs.map((input) => input.turnId)).toEqual([turnId]);
        expect(result).toMatchObject({ kind: "error", cause: { code: "agent_stop", reason: "budget" } });
        expect(modelCalls).toBe(0);
        expect(kernel().latestTurnTerminal(id)?.effect.kind).toBe("error");
      }),
    ),
    () => ledger,
  );
});

test("#1347 checkpoint cadence folds `everyActions` from the configured policy, not a literal", () => isolatedRun((ledger) => {
  const recording = requestLedger();
  const id = recording.identity.sessionId;
  const kernel = ledger.kernel;
  expect(checkpointPolicy(kernel, id)).toEqual(DEFAULT_CHECKPOINT_POLICY);
  expect(DEFAULT_CHECKPOINT_POLICY).toEqual({ everyActions: 256, maxTailBytes: 4 * 1024 * 1024 });
  pinCheckpointPolicy(recording, kernel, { everyActions: 8, maxTailBytes: 4 * 1024 * 1024 });
  // configure + turn intent + compose configure = 3 non-checkpoint actions already committed.
  expect(recording.commitBatch(paddingActions(id, recording.identity.turnId, 4)).ok).toBe(true);
  expect(kernel.latestFoldCheckpoint(id).checkpoint).toBeUndefined();
  expect(recording.commitBatch(paddingActions(id, recording.identity.turnId, 1, "eighth")).ok).toBe(true);
  const checkpoint = kernel.latestFoldCheckpoint(id).checkpoint;
  expect(checkpoint?.ordinal).toBe(9);
  expect(FoldCheckpoint.Effect.parse(checkpoint?.effect.value).result.revision).toBe(8);
  expect(expectReplay(id).nonCheckpointActions).toBe(0);
  // The suffix after revision 8 is the checkpoint row itself: counted, never folded.
  const loaded = hydrateSessionHistory(kernel, id, undefined, { now: steppingClock(3) });
  expect(loaded.telemetry).toEqual({ rows: 1, bytes: actionPayloadBytes(nth(sessionTree(kernel, id), 8)), pages: 1, ms: 3 });
}));

test("#1347 restore reports rows, bytes, pages and elapsed ms from the injected clock", () => isolatedRun((ledger) => {
  const recording = requestLedger({ legacy: true });
  const id = recording.identity.sessionId;
  const kernel = ledger.kernel;
  const padding = paddingActions(id, recording.identity.turnId, 300, "legacy");
  for (const action of padding) {
    expect(ledger.session.actions.append(action, kernel.row(id).revision)).toBeDefined();
  }
  const tree = sessionTree(kernel, id);
  const loaded = hydrateSessionHistory(kernel, id, undefined, { now: steppingClock(7) });
  expect(loaded.telemetry).toEqual({
    rows: tree.length,
    bytes: tree.reduce((total, action) => total + actionPayloadBytes(action), 0),
    pages: 2,
    ms: 7,
  });
  expect(loaded.revision).toBe(tree.length);
}));

test("#1347 an activation restore past `maxTailBytes` on a later page refuses typed in the error channel with the work done and no partial state", () => isolatedRun((ledger) => {
  const id = "bounded-restore";
  const kernel = ledger.kernel;
  // Pinned at genesis: page one (256 rows) fits under 10_000 bytes, page two carries the total past it.
  const maxTailBytes = 10_000;
  runTestSync(kernel.materialize({
    id,
    role: "resident",
    parentId: null,
    policyGeneration: 1,
    tools: [],
    system: { preset: "", blocks: [] },
    settings: { steering: "all", followUp: "all", checkpoint: { everyActions: 256, maxTailBytes } },
    actionId: `${id}:configure`,
    at: 100,
  }));
  for (const action of paddingActions(id, `${id}:configure`, 600, "legacy")) {
    expect(ledger.session.actions.append(action, kernel.row(id).revision)).toBeDefined();
  }
  const revision = kernel.row(id).revision;
  const pageBytes = (afterRevision: number) =>
    kernel.historyPage(id, { afterRevision, limit: 256 }).actions.reduce((total, action) => total + actionPayloadBytes(action), 0);
  expect(pageBytes(0)).toBeLessThanOrEqual(maxTailBytes);
  expect(pageBytes(0) + pageBytes(256)).toBeGreaterThan(maxTailBytes);
  const pages = ledger.session.actions.range.bind(ledger.session.actions);
  const read: number[] = [];
  ledger.session.actions.range = (sessionId, cursor, limit) => {
    read.push(cursor);
    return pages(sessionId, cursor, limit);
  };
  let refused: RestoreRefused;
  try {
    // The activation restore is the one bounded read: its refusal is a typed failure, never a throw.
    refused = runTestSync(Effect.flip(restoreSessionHistory(kernel, id, { now: steppingClock(5) })));
    // The runner's own reads stay unbounded: the same tail hydrates whole.
    expect(hydrateSessionHistory(kernel, id).revision).toBe(revision);
  } finally {
    ledger.session.actions.range = pages;
  }
  expect(RestoreRefused.isInstance(refused)).toBe(true);
  expect(refused.data).toEqual({
    code: "budget",
    sessionId: id,
    revision,
    maxTailBytes,
    telemetry: { rows: 512, bytes: pageBytes(0) + pageBytes(256), pages: 2, ms: 5 },
  });
  // The second page was counted, then refused before folding: the bounded read stopped there; the unbounded one read all three pages.
  expect(read).toEqual([0, 256, 0, 256, 512]);
  // Nothing durable changed; the same chain restores whole once the budget allows it.
  expect(kernel.row(id).revision).toBe(revision);
  expect(kernel.verifyChain(id)).toMatchObject({ kind: "intact", length: revision });
}));

/** One settled tool call whose result is `bytes` long: two executor-shaped rows, each under the row cap. */
function toolCallRows(sessionId: string, turnId: string, call: number, bytes: number): LedgerAction.Append[] {
  const tool = `${sessionId}:tool:${call}`;
  const result = "x".repeat(bytes);
  return [
    LedgerActionAppend({
      id: tool, sessionId, parentId: turnId, kind: "tool", ts: 160 + call, irreversible: true,
      intent: { encodingVersion: 1, value: { phase: "intent", op: "echo", value: { text: "x" } } },
      effect: { encodingVersion: 1, value: { phase: "pending" } },
    }),
    LedgerActionAppend({
      id: `${tool}:result`, sessionId, parentId: tool, kind: "tool", ts: 190 + call, irreversible: true,
      intent: { encodingVersion: 1, value: { phase: "result", op: "echo" } },
      effect: { encodingVersion: 1, value: { phase: "result", terminal: "executed", result, resultHash: canonicalDigest(result) } },
    }),
  ];
}

test("#1347 the writer keeps the restore tail under `maxTailBytes`: 4 MiB of rows inside fewer than 256 actions keeps committing, running turns and restoring", () => isolatedRun((ledger) => {
  const recording = requestLedger();
  const id = recording.identity.sessionId;
  const turnId = recording.identity.turnId;
  const kernel = ledger.kernel;
  const { maxTailBytes } = checkpointPolicy(kernel, id);
  expect(maxTailBytes).toBe(4 * 1024 * 1024);
  const tail = () => {
    const { revision, checkpoint } = kernel.latestFoldCheckpoint(id);
    return kernel.payloadBytes(id, checkpoint === undefined ? 0 : checkpoint.ordinal - 1, revision);
  };
  const payload = (actions: readonly LedgerAction.Node[]) => actions.reduce((total, action) => total + actionPayloadBytes(action), 0);
  // The review's probe: five tool calls of 1_000_000-byte results through the executor's ledger, each row under the cap.
  for (let call = 0; call < 5; call += 1) {
    for (const action of toolCallRows(id, turnId, call, 1_000_000)) {
      const receipt = runAgentSync(recording.ledger.commit(action));
      // Only the result that carries the tail past the budget is followed by a checkpoint row.
      expect(kernel.row(id).revision - receipt.revision).toBe(action.id === `${id}:tool:4:result` ? 1 : 0);
    }
    expect(tail()).toBeLessThanOrEqual(maxTailBytes);
    // The runner's turn-entry read keeps working after every commit.
    expect(expectReplay(id).revision).toBe(kernel.row(id).revision);
  }
  const tree = sessionTree(kernel, id);
  expect(tree.length).toBeLessThan(256);
  expect(payload(tree)).toBeGreaterThan(maxTailBytes);
  // The interval checkpoint landed on bytes, not on `everyActions`: right after the result that carried the tail past the budget.
  const checkpoint = nth(tree.filter((action) => action.kind === "fold.checkpoint"), 0);
  expect(checkpoint.parentId).toBe(`${id}:tool:4:result`);
  expect(FoldCheckpoint.Intent.parse(checkpoint.intent.value).reason).toBe("interval");
  expect(payload(tree.slice(0, checkpoint.ordinal - 1))).toBeGreaterThan(maxTailBytes);
  expect(payload(tree.slice(0, checkpoint.ordinal - 2))).toBeLessThanOrEqual(maxTailBytes);
  // Turns keep running: the terminal and the next turn intent (a projection commit) both land.
  expect(recording.commitBatch([
    turnTerminalAction({
      id: `${id}:result`, parentId: turnId, sessionId: id, turnId,
      result: { kind: "result", text: "done" }, resumeCount: 0, boundaryActionId: null, at: 200,
    }),
  ]).ok).toBe(true);
  const generation = kernel.latestGenerationFor(id);
  expect(recording.commitBatch([
    LedgerActionAppend({
      id: `${id}:turn:2`, sessionId: id, parentId: `${id}:result`, kind: "turn", ts: 201, irreversible: true,
      intent: { encodingVersion: 1, value: {
        phase: "intent", resultId: `${id}:result:2`, deliveryIds: [], resumeCount: 0, boundaryActionId: null,
        toolsGeneration: generation.generation, toolsHash: generation.toolsHash, systemHash: generation.systemHash, policyGeneration: 1,
      } },
      effect: { encodingVersion: 1, value: { phase: "pending" } },
    }),
  ]).ok).toBe(true);
  // The activation restore folds the bounded tail and reports only the rows after the checkpoint.
  const restored = runTestSync(restoreSessionHistory(kernel, id, { now: steppingClock(1) }));
  expect(restored.revision).toBe(kernel.row(id).revision);
  expect(restored.telemetry).toMatchObject({ rows: restored.revision - checkpoint.ordinal + 1, pages: 1 });
  expect(restored.telemetry.bytes).toBeLessThanOrEqual(maxTailBytes);
  expect(canonicalDigest(PlainValueSchema.parse(restored.state))).toBe(
    canonicalDigest(PlainValueSchema.parse(foldHistoryState(id, sessionTree(kernel, id)))),
  );
}));

test("#1347 a folded state past the row cap degrades explicitly: the checkpoint's typed `row_bytes` refusal is logged, the caller's rows still land", () => isolatedRun((ledger) => {
  const recording = requestLedger();
  const id = recording.identity.sessionId;
  const turnId = recording.identity.turnId;
  const kernel = ledger.kernel;
  // configure + turn intent + compose configure = 3 non-checkpoint rows: the next row is the fourth.
  pinCheckpointPolicy(recording, kernel, { everyActions: 4, maxTailBytes: 4 * 1024 * 1024 });
  const ROW_CAP = 1_048_576;
  const revision = kernel.row(id).revision;
  // A delivered prompt folds twice (message parts and compatibility text), so a prompt row
  // well under the cap carries the checkpoint row just past it.
  const prompt = (content: string) =>
    nth(deliveryActions(
      [{
        id: `${id}:big`, sessionId: id, kind: "prompt", content, origin: { encodingVersion: 1, value: {} },
        status: "pending", consumedBy: null, consumedAt: null, createdAt: 100, ordinal: 1,
      }],
      { kind: "turn", turnId },
      "after_tools",
      kernel.latestAction(id)?.id ?? null,
    ), 0);
  const checkpointBytes = (content: string) =>
    actionPayloadBytes(foldCheckpointAction({
      sessionId: id, parentId: `${id}:big:delivery`, revision: revision + 1, at: 100, reason: "interval",
      state: foldHistoryState(id, [...sessionTree(kernel, id), { ...prompt(content), ordinal: revision + 1, prevHash: "", actionHash: "" }]),
    }));
  const base = 500_000;
  const slope = checkpointBytes("x".repeat(base + 1)) - checkpointBytes("x".repeat(base));
  expect(slope).toBe(2);
  const content = "x".repeat(base + Math.ceil((ROW_CAP + 1 - checkpointBytes("x".repeat(base))) / slope));
  const row = prompt(content);
  expect(actionPayloadBytes(row)).toBeLessThan(ROW_CAP);
  const overBy = checkpointBytes(content) - ROW_CAP;
  expect(overBy).toBeGreaterThanOrEqual(1);
  expect(overBy).toBeLessThanOrEqual(slope);
  const warnings: { message: string; annotations: Record<string, string | number> }[] = [];
  const collector = Logger.make((options) => {
    if (options.logLevel !== "Warn") return;
    for (const item of Array.isArray(options.message) ? options.message : [options.message]) {
      if (typeof item === "string")
        warnings.push({
          message: item,
          annotations: Object.fromEntries(
            Object.entries(options.fiber.getRef(References.CurrentLogAnnotations)).filter(
              (entry): entry is [string, string | number] =>
                typeof entry[1] === "string" || typeof entry[1] === "number",
            ),
          ),
        });
    }
  });
  // The fourth row: the writer plans a checkpoint, the store refuses it typed, the row lands without it.
  const receipt = runAgentSync(recording.ledger.commit(row).pipe(Effect.provide(Logger.layer([collector]))));
  expect(receipt.revision).toBe(revision + 1);
  expect(kernel.row(id).revision).toBe(revision + 1);
  expect(kernel.latestFoldCheckpoint(id).checkpoint).toBeUndefined();
  expect(warnings).toEqual([{
    message: `fold checkpoint refused (row_bytes): ${id}`,
    annotations: { sessionId: id, checkpointId: `${id}:fold:${revision + 1}`, checkpointBytes: ROW_CAP + overBy },
  }]);
  expect(kernel.verifyChain(id)).toMatchObject({ kind: "intact", length: revision + 1 });
  // Nothing wedges: later rows keep landing at the threshold, each without a checkpoint, and the history still folds whole.
  expect(recording.commitBatch(paddingActions(id, turnId, 2)).ok).toBe(true);
  expect(kernel.row(id).revision).toBe(revision + 3);
  expect(kernel.latestFoldCheckpoint(id).checkpoint).toBeUndefined();
  expect(expectReplay(id).history.map((message) => message.info.id)).toEqual([`${id}:big`]);
}));

test("legacy genesis paging fixes a high-water revision, then checkpoints under the existing fence", () => isolatedRun((ledger) => {
  const recording = requestLedger({ legacy: true });
  const id = recording.identity.sessionId;
  const kernel = ledger.kernel;
  for (const action of paddingActions(id, recording.identity.turnId, 600, "legacy")) {
    expect(ledger.session.actions.append(action, kernel.row(id).revision)).toBeDefined();
  }
  const original = sessionTree(kernel, id);
  const revision = kernel.row(id).revision;
  const range = ledger.session.actions.range.bind(ledger.session.actions);
  const cursors: number[] = [];
  ledger.session.actions.range = (sessionId, cursor, limit) => {
    cursors.push(cursor);
    expect(limit).toBeLessThanOrEqual(256);
    const page = range(sessionId, cursor, limit);
    if (cursors.length === 1) {
      expect(
        ledger.session.actions.append(
          nth(paddingActions(id, recording.identity.turnId, 1, "concurrent"), 0),
          revision,
        ),
      ).toBeDefined();
    }
    return page;
  };
  const loaded = hydrateSessionHistory(kernel, id);
  ledger.session.actions.range = range;
  expect(loaded.revision).toBe(revision);
  expect(cursors).toEqual([0, 256, 512]);
  expect(canonicalDigest(PlainValueSchema.parse(loaded.state))).toBe(
    canonicalDigest(PlainValueSchema.parse(foldHistoryState(id, original))),
  );
  expect(recording.commitBatch([]).ok).toBe(true);
  expect(kernel.latestFoldCheckpoint(id).checkpoint?.ordinal).toBe(revision + 2);
  expect(sessionTree(kernel, id).slice(0, original.length)).toEqual(original);
  expectReplay(id);
}));

test("a compaction below N commits result and checkpoint together, rolls both back inside SQLite, and refuses a stale CAS", () => isolatedRun(async (ledger) => {
  let cuts = 0;
  const rollback = new Error("injected transaction rollback");
  const kernel = ledger.kernel;
  const fixture = await reconstructionFixture(
    (action, recording) => Effect.gen(function* () {
      if (
        action.kind === "compaction" &&
        effectOf(action).phase === "result" &&
        effectOf(action).terminal === "executed"
      ) {
        const before = sessionTree(kernel, reconstructionSession);
        const revision = kernel.row(reconstructionSession).revision;
        expect(() => recording.commitBatch([action], { expectedRevision: revision - 1 })).toThrow();
        expect(sessionTree(kernel, reconstructionSession)).toEqual(before);
        expect(() =>
          ledger.session.transaction(() => {
            expect(recording.commitBatch([action]).ok).toBe(true);
            const pending = sessionTree(kernel, reconstructionSession).slice(before.length);
            expect(pending.map((node) => node.kind)).toEqual(["compaction", "fold.checkpoint"]);
            throw rollback;
          }),
        ).toThrow(rollback);
        expect(sessionTree(kernel, reconstructionSession)).toEqual(before);
        cuts += 1;
      }
      return yield* recording.ledger.commit(action);
    }),
    { updates: 2, padding: 0 },
  );
  await fixture.compact();
  expect(cuts).toBe(1);
  expect(fixture.bodies).toEqual(["tool", "summary"]);
  expect(fixture.publications).toHaveLength(1);
  const actions = sessionTree(kernel, reconstructionSession);
  expect(actions.length).toBeLessThan(256);
  const checkpoint = nth(actions.slice(-1), 0);
  const result = nth(actions.slice(-2), 0);
  expect(checkpoint.kind).toBe("fold.checkpoint");
  expect(FoldCheckpoint.Effect.parse(checkpoint.effect.value).result.state.successorActionId).toBe(
    result.id,
  );
  const loaded = expectReplay(reconstructionSession);
  expect(effectOf(result).result).toMatchObject({
    successorActionId: result.id,
    foldVersion: 1,
    messageIds: loaded.history.map((message) => message.info.id),
    projectionHash: canonicalDigest({
      foldVersion: 1,
      projection: PlainValueSchema.parse(loaded.history),
    }),
  });
}));

test("legacy compaction without captured context reconstructs its predecessor before committing the successor", () => isolatedRun((ledger) => {
  const recording = requestLedger({ legacy: true });
  const sessionId = recording.identity.sessionId;
  const kernel = ledger.kernel;
  const prior = hydrateSessionHistory(kernel, sessionId);
  const history = [textMessage("assistant", "legacy summary", sessionId, "legacy-summary")];
  const projection = PlainValueSchema.parse(history);
  const predecessorProjectionHash = canonicalDigest({
    foldVersion: 1,
    projection: PlainValueSchema.parse(prior.history),
  });
  expect(ledger.session.actions.append({
    id: "legacy-compaction", sessionId, parentId: recording.identity.turnId,
    kind: "compaction", ts: 100, irreversible: true,
    intent: { encodingVersion: 1, value: { phase: "intent", op: "compact" } },
    effect: { encodingVersion: 1, value: { phase: "pending" } },
  }, prior.revision)?.revision).toBe(prior.revision + 1);
  expect(recording.commitBatch([{
    id: "legacy-compaction:result", sessionId, parentId: "legacy-compaction",
    kind: "compaction", ts: 100, irreversible: true,
    intent: { encodingVersion: 1, value: { phase: "result", op: "compact" } },
    effect: { encodingVersion: 1, value: {
      phase: "result", terminal: "executed", result: { projection },
    } },
  }]).ok).toBe(true);
  const result = kernel.resultFor(sessionId, "legacy-compaction");
  if (result === undefined) throw new Error("missing legacy compaction result");
  expect(effectOf(result).result).toEqual({
    sourceRevision: prior.revision,
    foldVersion: 1,
    predecessorActionId: null,
    predecessorProjectionHash,
    successorActionId: "legacy-compaction:result",
    messageIds: ["legacy-summary"],
    projection,
    projectionHash: canonicalDigest({ foldVersion: 1, projection }),
  });
  expect(expectReplay(sessionId).history).toEqual(history);
}));

for (const change of ["replacement", "delivered-tail"] as const) {
  test(`prepared compaction refuses a later ${change} without overwriting or dropping it`, () => isolatedRun(async (ledger) => {
    const kernel = ledger.kernel;
    const fixture = await reconstructionFixture(undefined, { updates: 2, padding: 0 });
    const prepared = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<string>();
    const pending = fixture.compact(() => {
      prepared.resolve();
      return finish.promise;
    });
    const settled = Promise.allSettled([pending]);
    await bounded(prepared.promise);
    const intent = nth(
      sessionTree(kernel, reconstructionSession)
        .filter((action) => action.kind === "compaction" && intentOf(action).phase === "intent")
        .slice(-1),
      0,
    );
    if (change === "replacement") await fixture.compact(async () => "replacement");
    else {
      const incoming = runAgentSync(commitReceivedMessage(kernel, {
        id: "concurrent",
        sessionId: reconstructionSession,
        kind: "prompt",
        content: "tail",
        createdAt: 100,
        origin: { encodingVersion: 1, value: {} },
        parentActionId: kernel.latestAction(reconstructionSession)?.id ?? null,
      }));
      const row = kernel.pendingMessages(reconstructionSession).find((item) => item.id === "concurrent");
      if (row === undefined) throw new Error("missing concurrent ingress row");
      expect(
        fixture.recording.commitBatch(
          deliveryActions(
            [row],
            { kind: "turn", turnId: fixture.recording.identity.turnId },
            "after_tools",
            incoming.receipt.action.id,
          ),
        ).ok,
      ).toBe(true);
    }
    const before = hydrateSessionHistory(kernel, reconstructionSession).history;
    finish.resolve("stale summary");
    expect(await bounded(settled)).toMatchObject([
      {
        status: "rejected",
        reason: {
          name: "CompactionPredecessorError",
          data: { code: "compaction_predecessor_changed" },
        },
      },
    ]);
    expect(kernel.resultFor(reconstructionSession, intent.id)).toBeUndefined();
    expect(expectReplay(reconstructionSession).history).toEqual(before);
    if (change === "delivered-tail")
      expect(before.map((message) => message.info.id)).toEqual([
        "prior-result",
        "same-id",
        "answer",
        "tool-message",
        "concurrent",
      ]);
  }));
}
