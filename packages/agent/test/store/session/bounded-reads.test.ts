import { turnTerminal } from "../../../src/core/store/session-reads";
import { beforeEach, expect, test } from "bun:test";
import { z } from "zod";
import { canonicalDigest, type LedgerAction, type PlainValue } from "@openomni/protocol";
import { LedgerInvariant } from "../../../src/core/store/errors";
import * as SessionHandleStore from "../../../src/core/store/fence";
import { materializeSession } from "../helpers/session";
import { requestFixture } from "../helpers/request";
import { sessionTree } from "../helpers/session-tree";
import { useMemoryStores } from "../helpers/storage";

const stores = useMemoryStores();
let kernel: SessionHandleStore.SessionKernel;
beforeEach(() => {
  kernel = stores.kernel;
  materializeSession(kernel, "bounded");
});

function append(
  id: string,
  kind: LedgerAction.Kind,
  intent: PlainValue = {},
  effect: PlainValue = { phase: "pending" },
  parentId = "bounded:configure",
) {
  const receipt = stores.session.actions.append(
    {
      id,
      kind,
      intent: { encodingVersion: 1, value: intent },
      effect: { encodingVersion: 1, value: effect },
      sessionId: "bounded",
      parentId,
      irreversible: true,
      ts: 2,
    },
    kernel.row("bounded").revision,
  );
  if (receipt === undefined) throw new Error(`append refused: ${id}`);
  return receipt.action;
}

function turn(id: string) {
  const generation = kernel.latestGenerationFor("bounded");
  return append(id, "turn", {
    phase: "intent",
    resultId: `${id}:result`,
    deliveryIds: [],
    resumeCount: 0,
    boundaryActionId: null,
    toolsGeneration: generation.generation,
    toolsHash: generation.toolsHash,
    systemHash: generation.systemHash,
    policyGeneration: generation.policyGeneration,
    context: {
      snapshotActionId: id,
      sourceRevision: kernel.row("bounded").revision,
      foldVersion: 1,
      projectionHash: canonicalDigest([]),
      messageIds: [],
      successorActionId: null,
      projection: [],
    },
  });
}

function terminal(turnId: string) {
  return append(
    `${turnId}:result`,
    "turn",
    { phase: "terminal", turnId },
    {
      phase: "terminal",
      turnId,
      kind: "result",
      text: "done",
      boundaryActionId: turnId,
      resumeCount: 0,
    },
    turnId,
  );
}

test("latest action, checkpoint and generation reads respect persisted revisions", () => {
  const initial = kernel.latestAction("bounded");
  expect(initial?.id).toBe("bounded:configure");
  expect(kernel.latestFoldCheckpoint("bounded")).toEqual({ revision: 1, checkpoint: undefined });
  const first = append("seed-1", "fold.checkpoint");
  append("between", "message");
  const second = append("seed-2", "fold.checkpoint");
  expect(kernel.latestAction("bounded", 2)).toEqual(first);
  expect(kernel.latestFoldCheckpoint("bounded", 3)).toEqual({ revision: 3, checkpoint: first });
  expect(kernel.latestFoldCheckpoint("bounded", 100)).toEqual({ revision: 4, checkpoint: second });
  expect(kernel.latestFoldCheckpoint("bounded", 0)).toEqual({ revision: 0, checkpoint: undefined });
  const generation = kernel.latestGenerationFor("bounded");
  expect(kernel.generationFor("bounded", 1)).toEqual(generation);
  expect(kernel.generationFor("bounded", 2)).toBeUndefined();
  append("invalid-configure", "session.configure");
  expect(kernel.latestGenerationFor("bounded")).toEqual(generation);
  expect(kernel.latestAction("missing")).toBeUndefined();
});

test("open turns page by original ordinal even when their latest update is beyond the page", () => {
  for (let index = 0; index < 257; index += 1) turn(`turn-${index}`);
  const update = append(
    "boundary",
    "turn",
    { phase: "checkpoint", turnId: "turn-255" },
    {
      phase: "checkpoint",
      turnId: "turn-255",
      resultId: "turn-255:result",
      resumeCount: 1,
      boundaryActionId: "boundary",
      boundary: "after_llm",
    },
    "turn-255",
  );
  const page = kernel.openTurnsPage("bounded");
  expect(page).toHaveLength(256);
  expect(page.at(-1)?.action).toEqual(update);
  expect(kernel.latestOpenTurn("bounded")?.turnId).toBe("turn-256");
  const closed = terminal("turn-256");
  expect(kernel.turnTerminalFor("bounded", "turn-256")).toEqual(
    turnTerminal(closed),
  );
  const effect = turnTerminal(closed);
  if (effect === undefined) throw new Error("missing turn terminal");
  expect(kernel.latestTurnTerminal("bounded")).toEqual({ action: closed, effect });
  expect(kernel.latestOpenTurn("bounded")?.turnId).toBe("turn-255");
  expect(kernel.openTurnsPage("bounded", 0, 1).map((entry) => entry.turnId)).toEqual(["turn-0"]);
  const tailIntent = kernel.openTurnsPage("bounded", 0, 255).at(-1)?.action;
  if (tailIntent === undefined) throw new Error("missing open turn");
  expect(kernel.openTurnsPage("bounded", tailIntent.ordinal).map((entry) => entry.turnId)).toEqual([
    "turn-255",
  ]);
  expect(kernel.openTurnsPage("missing")).toEqual([]);
  expect(kernel.latestTurnTerminal("missing")).toBeUndefined();
  expect(() => kernel.openTurnsPage("bounded", 0, 257)).toThrow(z.ZodError);
});

test("open turns resolve their latest update from either persisted turn-id path", () => {
  turn("intent-path");
  turn("effect-path");
  const generation = kernel.latestGenerationFor("bounded");
  const resumed = append(
    "intent-resume",
    "turn",
    {
      phase: "resume",
      turnId: "intent-path",
      resultId: "intent-path:result",
      resumeCount: 1,
      boundaryActionId: null,
      toolsGeneration: generation.generation,
      toolsHash: generation.toolsHash,
      systemHash: generation.systemHash,
      policyGeneration: generation.policyGeneration,
    },
    {},
    "intent-path",
  );
  const checkpoint = append(
    "effect-checkpoint",
    "turn",
    { phase: "checkpoint" },
    {
      phase: "checkpoint",
      turnId: "effect-path",
      resultId: "effect-path:result",
      resumeCount: 1,
      boundaryActionId: "effect-checkpoint",
      boundary: "after_llm",
    },
    "effect-path",
  );
  expect(kernel.openTurnsPage("bounded").map(({ turnId, action, resumeCount }) => ({
    turnId,
    actionId: action.id,
    resumeCount,
  }))).toEqual([
    { turnId: "intent-path", actionId: resumed.id, resumeCount: 1 },
    { turnId: "effect-path", actionId: checkpoint.id, resumeCount: 1 },
  ]);
});

test("a full open-turn page whose tail intent cannot be re-read is a named invariant", () => {
  for (let index = 0; index < 256; index += 1) turn(`turn-${index}`);
  // A store whose action index lost the row behind an open turn: the read must
  // name the torn intent instead of paging from an undefined ordinal.
  const torn: typeof stores.session = Object.create(stores.session, {
    actions: { value: { ...stores.session.actions, actionById: () => undefined } },
  });
  const read = SessionHandleStore.createSessionKernel(torn, stores.catalog);
  let thrown: LedgerInvariant | undefined;
  try {
    read.latestOpenTurn("bounded");
  } catch (error) {
    if (error instanceof LedgerInvariant) thrown = error;
  }
  expect(thrown).toMatchObject({ operation: "session.openTurns", message: "open turn intent missing: turn-255" });
});

test("a terminal row without a turnId does not hide every open turn", () => {
  turn("open");
  append(
    "orphan-terminal",
    "turn",
    { phase: "terminal" },
    { phase: "terminal", kind: "result", text: "done", boundaryActionId: "open", resumeCount: 0 },
    "open",
  );
  expect(kernel.openTurnsPage("bounded").map((entry) => entry.turnId)).toEqual(["open"]);
  terminal("open");
  expect(kernel.openTurnsPage("bounded")).toEqual([]);
});

test("snapshot pages retain all deliveries for the selected turn without loading unrelated actions", () => {
  turn("older");
  terminal("older");
  turn("current");
  for (let index = 0; index < 257; index += 1) {
    append(
      `delivery-${index}`,
      "prompt",
      {},
      {
        phase: "delivery",
        turnId: "current",
        deliveryId: `prompt-${index}`,
        kind: "prompt",
        content: `${index}`,
        origin: { encodingVersion: 1, value: {} },
        boundary: "before_llm",
      },
      "current",
    );
  }
  terminal("current");
  const snapshot = kernel.getSnapshot("bounded");
  expect(snapshot.turns.map((tail) => tail.turnId)).toEqual(["current"]);
  const deliveries: { role: "user"; text: string }[] = [];
  for (let index = 0; index < 257; index += 1) {
    deliveries.push({ role: "user", text: `${index}` });
  }
  expect(snapshot.turns[0]?.messages).toEqual([
    ...deliveries,
    { role: "assistant", text: "done" },
  ]);
  expect(kernel.getSnapshot("bounded", 2).turns.map((tail) => tail.turnId)).toEqual([
    "older",
    "current",
  ]);
  expect(kernel.getSnapshot("bounded", 0).turns).toEqual([]);
});

test("turnWindowStart opens after the intent preceding the newest count turns, else at zero", () => {
  const actions = stores.session.actions;
  const first = turn("first");
  terminal("first");
  const second = turn("second");
  const third = turn("third");
  const revision = kernel.row("bounded").revision;
  expect(actions.turnWindowStart("bounded", revision + 1, 1)).toBe(second.ordinal);
  expect(actions.turnWindowStart("bounded", revision + 1, 2)).toBe(first.ordinal);
  expect(actions.turnWindowStart("bounded", revision + 1, 3)).toBe(0);
  expect(actions.turnWindowStart("bounded", revision + 1, 99)).toBe(0);
  expect(actions.turnWindowStart("bounded", third.ordinal, 1)).toBe(first.ordinal);
  expect(actions.turnWindowStart("missing", revision + 1, 1)).toBe(0);
});

test("snapshot tails fold deliveries committed before their turn intent and stay per turn", () => {
  const deliver = (id: string, turnId: string, content: string, parentId: string) =>
    append(
      id,
      "prompt",
      {},
      {
        phase: "delivery",
        turnId,
        deliveryId: id,
        kind: "prompt",
        content,
        origin: { encodingVersion: 1, value: {} },
        boundary: "before_llm",
      },
      parentId,
    );
  deliver("d-first", "first", "hello", "bounded:configure");
  turn("first");
  terminal("first");
  deliver("d-second", "second", "again", "first:result");
  turn("second");
  append(
    "d-interrupt",
    "signal",
    {},
    {
      phase: "delivery",
      turnId: "second",
      deliveryId: "d-interrupt",
      kind: "interrupt",
      content: "",
      origin: { encodingVersion: 1, value: {} },
      boundary: "before_llm",
    },
    "second",
  );
  expect(kernel.turnIntentsPage("bounded", Number.MAX_SAFE_INTEGER).map((a) => a.id)).toEqual([
    "second",
    "first",
  ]);
  expect(kernel.getSnapshot("bounded", 1).turns).toMatchObject([
    { turnId: "second", state: "running", messages: [{ role: "user", text: "again" }] },
  ]);
  expect(kernel.getSnapshot("bounded", 2).turns).toMatchObject([
    {
      turnId: "first",
      state: "idle",
      messages: [
        { role: "user", text: "hello" },
        { role: "assistant", text: "done" },
      ],
      terminal: { kind: "result", actionId: "first:result" },
    },
    { turnId: "second", state: "running" },
  ]);
});

test("operation reads exclude administrative checkpoints and reject mismatched result identities", () => {
  turn("turn");
  append("llm", "llm", { phase: "intent" }, undefined, "turn");
  const attempt = append("attempt", "llm", { phase: "intent", op: "chat", attempt: 1 }, undefined, "llm");
  expect(kernel.priorModelAttempt("bounded", "other-turn")).toEqual(attempt);
  expect(kernel.priorModelAttempt("bounded", "turn")).toBeUndefined();
  append("operation-seed", "fold.checkpoint", {}, { phase: "result" }, "llm");
  expect(kernel.resultFor("bounded", "llm")).toBeUndefined();
  expect(kernel.openOperationsPage("bounded", "turn").map((action) => action.id)).toEqual(["llm"]);
  expect(kernel.operationChildrenPage("bounded", "llm", 0, 1)).toEqual([attempt]);
  const result = append(
    "llm-result",
    "llm",
    { phase: "result" },
    { phase: "result", terminal: "executed" },
    "llm",
  );
  expect(kernel.resultFor("bounded", "llm")).toEqual(result);
  expect(kernel.openOperationsPage("bounded", "turn")).toEqual([]);
  append(
    "mismatched",
    "tool",
    { phase: "result" },
    { phase: "result", terminal: "executed" },
    "llm",
  );
  expect(() => kernel.resultFor("bounded", "llm")).toThrow(
    expect.objectContaining({ _tag: "LedgerInvariant", message: "invalid result identity: mismatched" }),
  );
  expect(kernel.resultFor("missing", "llm")).toBeUndefined();
});

test("guarded wave pages retain settled members until their last sibling settles", () => {
  turn("turn");
  const guarded = append(
    "guarded",
    "tool",
    { phase: "intent", turnId: "turn", waveId: "wave", approvalRequired: true },
    undefined,
    "turn",
  );
  const sibling = append(
    "sibling",
    "tool",
    { phase: "intent", turnId: "turn", waveId: "wave", approvalRequired: false },
    undefined,
    "turn",
  );
  const result = append(
    "guarded-result",
    "tool",
    { phase: "result" },
    { phase: "result", terminal: "executed" },
    "guarded",
  );
  expect(kernel.openOperationsPage("bounded", "turn")).toEqual([]);
  expect(kernel.guardedOperationsPage("bounded", "turn")).toEqual([guarded, sibling, result]);
  expect(kernel.guardedOperationsPage("bounded", "turn", sibling.ordinal, 1)).toEqual([result]);
  const seed = append("wave-seed", "fold.checkpoint", {}, { phase: "result" }, "sibling");
  expect(kernel.guardedOperationsPage("bounded", "turn")).toEqual([guarded, sibling, result, seed]);
  append(
    "sibling-result",
    "tool",
    { phase: "result" },
    { phase: "result", terminal: "executed" },
    "sibling",
  );
  expect(kernel.guardedOperationsPage("bounded", "turn")).toEqual([]);
});

test("request state pages select the latest identity and cross page boundaries", () => {
  const { request } = requestFixture(kernel);
  for (let index = 0; index < 257; index += 1) {
    const requestId = `r${String(index).padStart(3, "0")}`;
    append(
      `${requestId}:open`,
      "request",
      { inputId: requestId },
      {
        phase: "open",
        request: { ...request, sessionId: "bounded", requestId },
      },
    );
  }
  const requestId = "r000";
  const cancelled = {
    ...request,
    sessionId: "bounded",
    requestId,
    state: "cancelled" as const,
    outcome: "cancelled" as const,
  };
  const update = append(
    "r000:cancelled",
    "request",
    { inputId: "answer" },
    { phase: "resolved", request: cancelled },
  );
  expect(kernel.requestById(requestId)).toEqual(cancelled);
  expect(kernel.requestInputById("bounded", "answer")).toEqual(update);
  expect(kernel.requestInputById("missing", "answer")).toBeUndefined();
  expect(kernel.requestStatesPage("bounded", "", 1)).toEqual([cancelled]);
  expect(kernel.requestStatesPage("bounded", "r255").map((value) => value.requestId)).toEqual([
    "r256",
  ]);
  expect(kernel.requestRows("bounded")).toHaveLength(257);
  expect(kernel.requestRows()).toEqual(kernel.requestRows("bounded"));
});

test("outbound pages deduplicate acknowledgements without dropping the next page", () => {
  for (let index = 0; index < 257; index += 1) {
    const payload = {
      messageId: `m${String(index).padStart(3, "0")}`,
      sourceSessionId: "bounded",
      sourceActionId: "terminal",
      destinationSessionId: "receiver",
      requestId: "request",
      replyTo: "binding",
      terminal: "completed",
      content: `${index}`,
    };
    append(
      `${payload.messageId}:pending`,
      "message",
      { op: "open" },
      {
        outbound: {
          message: { ...payload, digest: canonicalDigest(payload) },
          state: "pending",
          destinationReceipt: null,
        },
      },
    );
  }
  const first = kernel.outboundStatesPage("bounded", "", 1)[0];
  if (first === undefined) throw new Error("missing outbound");
  const delivered = {
    ...first,
    state: "delivered" as const,
    destinationReceipt: { id: "receipt", revision: 2 },
  };
  append("m000:ack", "message", { op: "ack" }, { outbound: delivered });
  expect(kernel.outboundStatesPage("bounded", "", 1)).toEqual([delivered]);
  expect(
    kernel.outboundStatesPage("bounded", "m255").map((value) => value.message.messageId),
  ).toEqual(["m256"]);
  expect(kernel.outboundRows("bounded")).toHaveLength(257);
  expect(sessionTree("bounded", stores.session.actions)).toHaveLength(259);
});
