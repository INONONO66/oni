import { turnTerminal, openTurns } from "../../src/core/store/session-reads";
import { configureCrashPoint, configureCutProof, configureRecoveryProof } from "../helpers/crash-configure";
import { sessionTree } from "../helpers/session-tree";
import { testExecutor } from "../helpers/executor";
import { allowConfigure, isolatedRuntime, type SessionFixture as SessionRuntime, type SessionFixture, withSessionServices } from "../helpers/session-services";
import { isolated, isolatedLedger, isolatedRun } from "../helpers/isolated";
import { openCrashStores } from "../helpers/crash-stores";
import type { ExecutionError } from "../../src/core/ports/failure";
import { Effect, Result } from "effect";
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LedgerAction, type Message, SessionTransition } from "@oni/protocol";
import { z } from "zod";
import { renderAnchorText } from "../../src/plugins/compaction/summary";
import { alarmDisposition } from "../../src/core/ports/alarm";
import { closeSessions } from "../../src/core/session/run";
import { reactivateSession } from "../helpers/wake-session";
import { foldHistoryState, foldSessionHistory, hydrateSessionHistory } from "../../src/inspect/history";

import { killAtCrashBarrier } from "../helpers/crash-channel";
import { messagePlanePoint, messagePlaneProof } from "../helpers/crash-message-plane";
import { corruptCheckpoint, reconstructionPoint, reconstructionRecovery } from "../helpers/crash-reconstruction";
import { bounded } from "../helpers/bounded";
import { fiberCrashCell } from "../helpers/fiber-outcome-crash";
import { compiledPolicy } from "../helpers/compiled-policy";
import { countingRunner } from "../helpers/counting-runner-g1";
import { nth } from "../helpers/nth";
import { receiveOutbound } from "../helpers/effect-g2";
import { requestLedger } from "../helpers/effect-g1";
import { checkpointEvidence, committedCompactionPoints, crashPoint, crashWitness, effectOf, intentOf, matrixSchema, observations, outboundPoints, recovery, sessionId, type CrashPoint, } from "../helpers/crash-matrix";

const matrix = matrixSchema.parse(
  await Bun.file(new URL("../../../../script/conformance/crash-matrix.json", import.meta.url)).json(),
);
const crashScript = new URL("../helpers/crash-matrix-g1.ts", import.meta.url).pathname;
const planeScript = new URL("../helpers/crash-message-plane.ts", import.meta.url).pathname;
type Witness = z.infer<typeof crashWitness>;

function actions() {
  return sessionTree(isolatedLedger().kernel, sessionId);
}
function pendingDeliveries(id = sessionId) {
  return isolatedLedger().kernel.pendingMessages(id);
}
function results(kind: LedgerAction.Kind) {
  return actions().filter((action) => action.kind === kind && effectOf(action).phase === "result");
}
/** Attempts share the llm kind; an attempt result settles an intent pinning its ordinal. */
function attemptIds() {
  return new Set(
    actions()
      .filter((action) => action.kind === "llm" && typeof intentOf(action).attempt === "number")
      .map((action) => action.id),
  );
}
function llmResults(which: "attempt" | "logical") {
  const ids = attemptIds();
  return results("llm").filter(
    (action) => (which === "attempt") === ids.has(action.parentId ?? ""),
  );
}
function terminalClass(action: LedgerAction.Node) {
  const terminal = z
    .enum(["executed", "failed", "outcome_unknown"])
    .parse(effectOf(action).terminal);
  return {
    executed: "resumed_without_reexecution",
    failed: "not_durable",
    outcome_unknown: "lost",
  }[terminal];
}

// A fresh kernel process loads agent+ledger, opens SQLite and runs one turn;
// on a loaded shared runner that cold start alone has exceeded the 5 s in-process
// bound. The child's exit is the signal; this is only the failure ceiling.
const SPAWNED_CHILD_MS = 30_000;

async function crash(point: CrashPoint, dbPath: string, stage = "initial"): Promise<Witness> {
  const stdout = await killAtCrashBarrier(crashScript, [point, dbPath, stage]);
  const witness = crashWitness.parse(JSON.parse(stdout));
  expect(witness.crashPoint).toBe(point);
  return witness;
}

function recoverExecutor(witness: Witness) {
  return Effect.gen(function* () {
  const before = actions();
  const history = foldSessionHistory(sessionId, before);
  const recording = yield* requestLedger({ id: sessionId, clock: () => 100_000 });
  const executor = testExecutor({ ...recording, observations, policy: compiledPolicy() });
  yield* executor.recover();
  expect(actions().slice(0, before.length)).toEqual(before);
  const recovered = actions();
  yield* executor.recover();
  expect(actions()).toEqual(recovered);
  switch (witness.crashPoint) {
    case "compaction_summary_before_boundary_commit":
      expect(witness.bodies).toEqual(["summary"]);
      expect(before.filter((action) => action.kind === "compaction" && effectOf(action).phase === "boundary")).toEqual([]);
      expect(results("compaction").map(effectOf)).toMatchObject([{ terminal: "interrupted", recovery: { proof: "absent" } }]);
      expect(foldSessionHistory(sessionId, recovered)).toEqual(history);
      return "not_durable";
    case "llm_body_before_attempt_result_commit":
      expect(witness.bodies).toEqual(["llm"]);
      expect(witness.pending).toMatchObject({ kind: "llm", effect: { terminal: "executed" } });
      expect(llmResults("attempt").map(effectOf)).toMatchObject([
        { terminal: "outcome_unknown", recovery: { site: "crash", rawSettled: false } },
      ]);
      return terminalClass(nth(llmResults("logical"), 0));
    case "llm_result_committed":
      expect(witness.bodies).toEqual(["llm"]);
      expect(recovered).toEqual(before);
      expect(llmResults("attempt").map(effectOf)).toMatchObject([{ terminal: "executed" }]);
      return terminalClass(nth(llmResults("logical"), 0));
    case "tool_wave_between_result_commits":
      expect(witness.bodies).toEqual(["first", "second"]);
      expect(
        before.filter((action) => action.kind === "tool" && effectOf(action).phase === "result"),
      ).toHaveLength(1);
      expect(results("tool").map(effectOf)).toMatchObject([
        { terminal: "executed", callId: "first" },
        { terminal: "outcome_unknown", callId: "second", toolResult: { settlement: "unknown" } },
      ]);
      return terminalClass(nth(results("tool"), 1));
    case "compaction_summary_before_result_commit": {
      expect(witness.bodies).toEqual(["summary"]);
      expect(witness.pending).toMatchObject({
        kind: "compaction",
        effect: { result: { summary: "checkpoint" } },
      });
      // The boundary transaction landed before the crash; only the result echo was lost,
      // so the pre-recovery fold still reads the original two-message history.
      expect(history).toHaveLength(2);
      const boundary = before.find(
        (action) => action.kind === "compaction" && effectOf(action).phase === "boundary",
      );
      if (boundary === undefined) throw new Error("missing durable compaction boundary");
      expect(effectOf(boundary)).toMatchObject({ result: { summary: "checkpoint" } });
      const settledResults = results("compaction").map(effectOf);
      expect(settledResults).toMatchObject([
        {
          terminal: "executed",
          recovery: {
            proof: "applied",
            classification: "local_transactional",
            site: "crash",
            proofReceipt: { id: boundary.id },
          },
        },
      ]);
      const { committed, originalAnswer } = checkpointEvidence(
        nth(settledResults, 0).result,
        results("message"),
      );
      const recoveredHistory = foldSessionHistory(sessionId, recovered);
      expect(recoveredHistory).toEqual(committed.projection);
      expectCompactedProjection(recoveredHistory, originalAnswer);
      return terminalClass(nth(results("compaction"), 0));
    }
  }
  });
}

/** Wakes the recovered session once and returns the turn terminals; the pre-crash prefix must be untouched. */
function wakeAfterCrash(
  _witness: Witness,
  runner: ReturnType<typeof countingRunner>,
  runtime: SessionRuntime,
  before: LedgerAction.Node[],
) {
  return Effect.gen(function* () {
  yield* Effect.gen(function* () { const fixture: SessionFixture = runtime; return yield* withSessionServices(reactivateSession(sessionId, runner, fixture), fixture); }).pipe(Effect.timeout("5 seconds"));
  expect(actions().slice(0, before.length)).toEqual(before);
  return actions().filter((action) => turnTerminal(action) !== undefined);
  });
}

function recoverAdmission(witness: Witness) {
  return Effect.gen(function* () {
  const before = actions();
  const originalTurns = openTurns(before);
  const originalDeliveries = pendingDeliveries();
  const originalOutbound = isolatedLedger().kernel.outboundRows(sessionId);
  const calls = { model: 0 };
  let deliveries = 0;
  const runtime: SessionRuntime = {
    ...isolatedRuntime(),
    authorizeConfigure: allowConfigure,
    observations,
    clock: () => 100_000,
    dispatchOutbound: ({ message }) => Effect.gen(function* () {
      deliveries += 1;
      expect([message]).toEqual(originalOutbound.map((item) => item.message));
      return (yield* receiveOutbound(message, 100_000)).receipt;
    }),
  };
  const runner = countingRunner(runtime, calls);
  try {
    const terminals = yield* wakeAfterCrash(witness, runner, runtime, before);
    expect(terminals).toHaveLength(1);
    if (witness.crashPoint === "outbound_reply_before_delivery_settle") {
      expect(witness.bodies).toEqual(["reply"]);
      expect(originalOutbound).toMatchObject([
        { state: "pending", message: { content: "durable reply" } },
      ]);
      expect(calls.model).toBe(0);
      expect(deliveries).toBe(1);
      expect(isolatedLedger().kernel.outboundRows(sessionId)).toMatchObject([{ state: "delivered" }]);
      const revision = isolatedLedger().kernel.row(sessionId).revision;
      yield* Effect.gen(function* () { const fixture: SessionFixture = runtime; return yield* withSessionServices(reactivateSession(sessionId, runner, fixture), fixture); });
      expect(isolatedLedger().kernel.row(sessionId).revision).toBe(revision);
      expect(deliveries).toBe(1);
      return "rearmed";
    }
    expect(witness.bodies).toEqual([]);
    expect(calls.model).toBe(1);
    const terminal = turnTerminal(nth(terminals, 0));
    if (witness.crashPoint === "turn_intent_before_llm_entry") {
      expect(originalTurns).toHaveLength(1);
      expect(terminal?.turnId).toBe(originalTurns[0]?.turnId);
      expect(terminals.map((action) => action.id)).toEqual(
        originalTurns.map((turn) => turn.resultId),
      );
      return "resumed_without_reexecution";
    }
    expect(originalTurns).toEqual([]);
    expect(originalDeliveries).toMatchObject([{ id: "admitted", content: "original prompt" }]);
    expect(pendingDeliveries()).toEqual([]);
    expect(isolatedLedger().kernel.inputMessages(sessionId)).toHaveLength(1);
    return "rearmed";
  } finally {
    yield* closeSessions(runtime);
  }
  });
}

function recoverCommittedCompaction(witness: Witness) {
  return Effect.gen(function* () {
  const before = actions();
  const deliveries = pendingDeliveries();
  expect(witness.bodies).toEqual(["summary"]);
  expect(results("compaction")).toHaveLength(1);
  const result = nth(results("compaction"), 0);
  expect(effectOf(result).terminal).toBe("executed");
  const { committed, originalAnswer } = checkpointEvidence(
    effectOf(result).result,
    results("message"),
  );
  const history = foldSessionHistory(sessionId, before);
  expect(history).toEqual(committed.projection);
  expectCompactedProjection(history, originalAnswer);
  if (witness.crashPoint === "compaction_concurrent_tail_committed_before_owner_crash") {
    expect(deliveries.map((item) => item.id)).toEqual(["tail"]);
    expect(isolatedLedger().kernel.inputMessages(sessionId).map((item) => item.id)).toContain("tail");
  } else expect(deliveries).toEqual([]);
  const recording = yield* requestLedger({ id: sessionId, clock: () => 100_000 });
  const executor = testExecutor({ ...recording, observations, policy: compiledPolicy() });
  yield* executor.recover();
  expect(actions()).toEqual(before);
  const recovered = foldSessionHistory(sessionId, actions());
  expect(recovered).toEqual(history);
  expectCompactedProjection(recovered, originalAnswer);
  expect(pendingDeliveries()).toEqual(deliveries);
  yield* executor.recover();
  expect(actions()).toEqual(before);
  expect(pendingDeliveries()).toEqual(deliveries);
  return terminalClass(result);
  });
}

/** Independent of the stored projection: the summary replaced `earlier`, the protected answer survived verbatim. */
function expectCompactedProjection(
  projection: Message.WithParts[],
  originalAnswer: Message.WithParts | undefined,
) {
  const texts = projection.map((message) =>
    message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""),
  );
  const ids = projection.map((message) => message.info.id);
  expect(ids).not.toContain("earlier");
  expect(new Set(ids).size).toBe(ids.length);
  for (const message of projection) {
    expect(message.parts.map((part) => part.messageID)).toEqual([message.info.id]);
  }
  expect(projection.map((message) => message.parts.map((part) => part.type))).toEqual([
    ["text"],
    ["text"],
  ]);
  expect(texts).toHaveLength(2);
  expect(projection[0]?.info.role).toBe("user");
  expect(texts[0]).toBe(renderAnchorText("checkpoint", false));
  const anchor = nth(projection, 0);
  expect(anchor.parts).toEqual([
    {
      id: nth(anchor.parts, 0).id,
      sessionID: sessionId,
      messageID: nth(ids, 0),
      type: "text",
      text: renderAnchorText("checkpoint", false),
      metadata: {
        compactionAnchor: true,
        anchorBody: "checkpoint",
        keptWindow: [
          { role: "assistant", text: "answer", time: originalAnswer?.info.time.created },
        ],
      },
    },
  ]);
  expect(originalAnswer?.info.id).toBe("answer");
  expect(projection[1]).toEqual(originalAnswer);
  expect(texts[1]).toBe("answer");
}

function recoverTurn(witness: Witness, resumeCount: number, onModel: () => Effect.Effect<void, ExecutionError> = () => Effect.void) {
  return Effect.gen(function* () {
  const before = actions();
  const original = crashWitness.shape.openTurns.element.parse(witness.openTurns[0]);
  expect(witness.openTurns).toHaveLength(1);
  const calls = { model: 0 };
  const runtime: SessionRuntime = { ...isolatedRuntime(), observations, clock: () => 200_000, authorizeConfigure: allowConfigure };
  const runner = countingRunner(runtime, calls, onModel);
  try {
    const terminals = yield* wakeAfterCrash(witness, runner, runtime, before);
    expect(terminals.map((action) => action.id)).toEqual([original.resultId]);
    expect(turnTerminal(nth(terminals, 0))).toMatchObject({
      turnId: original.turnId,
      resumeCount,
      kind: "result",
    });
    expect(openTurns(actions())).toEqual([]);
    expect(calls.model).toBe(1);
    const recovered = actions();
    const revision = isolatedLedger().kernel.row(sessionId).revision;
    yield* Effect.gen(function* () { const fixture: SessionFixture = runtime; return yield* withSessionServices(reactivateSession(sessionId, runner, fixture), fixture); }).pipe(Effect.timeout("5 seconds"));
    expect(actions()).toEqual(recovered);
    expect(isolatedLedger().kernel.row(sessionId).revision).toBe(revision);
    expect(calls.model).toBe(1);
    return "resumed_without_reexecution";
  } finally {
    yield* closeSessions(runtime);
  }
  });
}

function recoverContinuation(witness: Witness) {
  return Effect.gen(function* () {
  expect(witness.bodies).toEqual([]);
  expect(witness.openTurns.map((turn) => turn.resumeCount)).toEqual([1]);
  const result = yield* recoverTurn(witness, 2);
  expect(
    actions()
      .filter((action) => action.kind === "turn" && intentOf(action).phase === "resume")
      .map((action) => ({
        turnId: intentOf(action).turnId,
        resumeCount: intentOf(action).resumeCount,
      })),
  ).toEqual([1, 2].map((resumeCount) => ({ turnId: witness.openTurns[0]?.turnId, resumeCount })));
  return result;
  });
}

/**
 * The committed retry.scheduled chain action survives the crash (W5.2 timer
 * plane): the redelivered RetryScheduled delivery consults the chain and
 * no-ops against the settled attempt, while the entity wake (activation
 * resume) re-runs the open turn's model attempt exactly once.
 */
function recoverRetryAlarm(witness: Witness) {
  return Effect.gen(function* () {
  expect(witness.bodies).toEqual(["llm"]);
  const ids = attemptIds();
  const attempts = actions().filter(
    (action) =>
      action.kind === "llm" &&
      (ids.has(action.id) || ids.has(action.parentId ?? "")),
  );
  expect(attempts.map(intentOf)).toMatchObject([
    { phase: "intent", attempt: 1 },
    { phase: "result" },
  ]);
  // The retry port arms the occurrence chain `<attemptId>:retry`;
  // the arm row id is `<chain>:arm:1` and the effect names the minted
  // occurrence.
  const alarmId = `${nth(attempts, 0).id}:retry`;
  const armed = actions().find((action) => action.id === `${alarmId}:arm:1`);
  expect(armed).toMatchObject({
    kind: "alarm",
    intent: {
      value: { op: "arm", purpose: "retry", at: 100, payload: { attempt: 1, reason: "transient_error" } },
    },
  });
  const occurrenceId = z.object({ occurrenceId: z.string() }).parse(
    effectOf(LedgerAction.Node.parse(armed)),
  ).occurrenceId;
  expect(pendingDeliveries()).toEqual([]);
  // Redelivered RetryScheduled: the settled attempt makes the delivery a chain-
  // guarded no-op; a second delivery no-ops identically (never a cancel CAS).
  // The legacy-shape retry arm carries no occurrence chain, so the one
  // chain guard skips the redelivery (zero execution), idempotently. Reads
  // scan the real committed chain for new-shape arm/fired rows.
  const alarmRows = () => actions().filter((action) => action.kind === "alarm");
  const reads = {
    latestArm: (chain: string) => {
      const arm = alarmRows()
        .filter((action) => {
          const intent = intentOf(action);
          return intent.op === "arm" && intent.alarmId === chain;
        })
        .at(-1);
      if (arm === undefined) return undefined;
      const occurrence = effectOf(arm).occurrenceId;
      const at = intentOf(arm).at;
      return {
        occurrenceId: typeof occurrence === "string" ? occurrence : "",
        at: typeof at === "number" ? at : null,
      };
    },
    settled: (occurrence: string) =>
      alarmRows().some((action) => {
        const intent = intentOf(action);
        return (
          intent.op === "fired" &&
          intent.occurrenceId === occurrence &&
          (intent.outcome === "delivered" || intent.outcome === "exhausted")
        );
      }),
  };
  // A foreign occurrence of the same chain is superseded by the live arm;
  // the live occurrence itself still runs (the wait was lost, not the arm).
  expect(alarmDisposition(reads, { alarmId, occurrenceId: `${alarmId}:bogus` })).toEqual({
    op: "skip",
    reason: "superseded",
  });
  expect(alarmDisposition(reads, { alarmId, occurrenceId })).toEqual({ op: "run" });
  expect(yield* recoverTurn(witness, 1)).toBe("resumed_without_reexecution");
  // The wake injected no prompt and the completed attempt armed nothing new.
  expect(pendingDeliveries()).toEqual([]);
  expect(
    actions().filter((action) => action.kind === "alarm" && action.id.includes(":retry:")),
  ).toHaveLength(1);
  return "rearmed";
  });
}

function recoverStaleOwner(witness: Witness) {
  return Effect.gen(function* () {
  expect(witness.bodies).toEqual(["llm"]);
  const staleAction = LedgerAction.Append.parse(witness.staleAction);
  expect(staleAction.kind).toBe("llm");
  expect(effectOf(staleAction)).toMatchObject({ phase: "result", terminal: "executed" });
  const owner = z.string().parse(witness.lease.owner);
  let refusals = 0;
  yield* recoverTurn(witness, 1, () => Effect.gen(function* () {
    const kernel = isolatedLedger().kernel;
    const current = kernel.row(sessionId);
    // The entity wake pinned a strictly newer fence; the crashed activation's
    // authority is dead the moment the successor adopts, with no timer involved.
    expect(current.fenceOwner).not.toBe(owner);
    expect(current.fence).toBeGreaterThan(witness.lease.fence);
    const before = actions();
    const refused = yield* Effect.result(kernel.commit({
      sessionId, owner, fence: witness.lease.fence, now: 200_000,
      expectedRevision: current.revision, actions: [staleAction], state: current.state,
    }));
    expect(Result.isFailure(refused) ? refused.failure : undefined).toMatchObject({ _tag: "CommitRefused", reason: "fence" });
    expect(actions()).toEqual(before);
    expect(kernel.row(sessionId)).toEqual(current);
    refusals += 1;
    return undefined;
  }));
  expect(refusals).toBe(1);
  expect(results("llm").filter((action) => action.parentId === staleAction.parentId).map(effectOf)).toMatchObject([
    { terminal: "outcome_unknown", recovery: { site: "crash", rawSettled: false } },
  ]);
  // Write disposition and ambiguous effect disposition are independent assertions.
  // The typed rejection is atomic: the stale writer's effect row never appears.
  expect(actions().some((action) => action.id === staleAction.id)).toBe(false);
  return "lost";
  });
}

function assertOutboundCut(witness: Witness) {
  const kernel = isolatedLedger().kernel;
  const outbound = kernel.outboundRows(sessionId);
  expect(outbound).toHaveLength(1);
  const item = SessionTransition.Outbound.parse(outbound[0]);
  const acked = witness.crashPoint === "delivery_ack_committed_before_owner_cleanup";
  const sent =
    acked || witness.crashPoint === "platform_send_committed_before_local_ack_reconciled_sent";
  const accepted = sent || witness.crashPoint === "platform_send_ambiguous_without_reconciliation";
  const extra =
    witness.crashPoint === "outbound_flood_deadline_before_timer_rearm" ? ["flood"] : [];
  expect(witness.bodies).toEqual(["reply", ...(accepted ? ["accepted"] : extra)]);
  expect(item.state).toBe(acked ? "delivered" : "pending");
  expect(item.message.content).toBe("durable reply");
  const destination = kernel.inputMessages(item.message.destinationSessionId).filter(
    (row) => row.id === item.message.messageId,
  );
  expect(destination).toHaveLength(sent ? 1 : 0);
  const openId = `${item.message.sourceActionId}:outbound`;
  const openIndex = actions().findIndex((action) => action.id === openId);
  expect(openIndex).toBeGreaterThanOrEqual(0);
  // In particular C5 has no attempt/marker action of any kind after its open row.
  expect(
    actions()
      .slice(openIndex + 1)
      .map((action) => action.id),
  ).toEqual(acked ? [`${item.message.messageId}:ack`] : []);
  return { item, acked, destination };
}

async function recoverChild<S extends z.ZodType>(helperScript: string, args: string[], label: string, schema: S) {
  const child = Bun.spawn([process.execPath, helperScript, "recover", ...args], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  const receipt = Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  child.stdin.write("S");
  try {
    const [code, stdout, stderr] = await bounded(receipt, label, SPAWNED_CHILD_MS);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    return schema.parse(JSON.parse(stdout));
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    child.stdin.end();
  }
}

async function recoverMessagePlane(point: z.infer<typeof messagePlanePoint>, dbPath: string) {
  return recoverChild(planeScript, [point, dbPath], "fresh message-plane recovery", messagePlaneProof);
}

function recoverOutbound(witness: Witness, dbPath: string) {
  return Effect.gen(function* () {
    const before = actions();
    const { item, acked, destination } = assertOutboundCut(witness);
    const point = messagePlanePoint.parse(witness.crashPoint);
    const ambiguous = point === "platform_send_ambiguous_without_reconciliation";
    const sent = point === "platform_send_committed_before_local_ack_reconciled_sent";
    const proof = yield* Effect.promise(() => recoverMessagePlane(point, dbPath));
    expect(proof.before).toEqual(before);
    expect(proof.after.slice(0, before.length)).toEqual(before);
    expect(proof.repeated).toEqual(proof.after);
    expect(proof.sourceRuns).toBe(0);
    expect(proof.destinationRuns).toBe(1);
    expect(proof.dispatches).toBe(acked || sent ? 0 : 1);
    expect(proof.outboundAfter).toMatchObject([{ state: "delivered", message: item.message }]);
    const received = proof.deliveriesAfter.filter((row) => row.id === item.message.messageId);
    expect(received).toHaveLength(1);
    expect(received[0]?.status).toBe("consumed");
    if (destination.length === 1) expect(received[0]?.content).toBe(destination[0]?.content);
    expect(proof.after.filter((action) => turnTerminal(action) !== undefined)).toHaveLength(1);
    if (sent || ambiguous) {
      expect(proof.externalBefore).toEqual([item.message.messageId]);
      expect(proof.externalAfter).toEqual(Array.from({ length: sent ? 1 : 2 }, () => item.message.messageId));
    }
    if (acked || sent) return "resumed_without_reexecution";
    return ambiguous ? "replayed" : "rearmed";
  });
}

/**
 * Entity-plane doorbell (W5.2 F2): a WatchFired delivery commits its occurrence
 * chain action and the pending wake prompt in one fenced batch; the cut lands
 * before any entity wake. Recovery wakes once, consumes the prompt exactly
 * once, and every redelivery of the occurrence is a chain-guarded no-op.
 */
async function watchWakeCell(dbPath: string) {
  const point = "watch_fired_committed_before_entity_wake";
  const witness = crashWitness.parse(JSON.parse(await killAtCrashBarrier(planeScript, ["crash", point, dbPath])));
  expect(witness).toMatchObject({ crashPoint: point, bodies: [], openTurns: [] });
  expect(typeof witness.lease.owner).toBe("string");
  const proof = await recoverMessagePlane(point, dbPath);
  expect(proof.watch).toEqual({ occurrenceId: "doorbell:fired:1", redelivery: "duplicate_occurrence", fired: 1 });
  expect(proof.before.filter(({ kind }) => kind === "alarm")).toHaveLength(1);
  const pending = proof.deliveriesBefore.filter(({ status }) => status === "pending");
  expect(pending).toHaveLength(1);
  expect(proof.deliveriesAfter.filter(({ id, status }) => id === pending[0]?.id && status === "consumed")).toHaveLength(1);
  expect(proof.after.slice(0, proof.before.length)).toEqual(proof.before);
  expect(proof.repeated).toEqual(proof.after);
  expect(proof.sourceRuns).toBe(1);
  expect(proof.dispatches).toBe(0);
  return "rearmed";
}

function recoverCell(witness: Witness, dbPath: string) {
  return Effect.gen(function* () {
  const point = crashPoint.parse(witness.crashPoint);
  if (committedCompactionPoints.has(point)) return yield* recoverCommittedCompaction(witness);
  if (witness.crashPoint === "outbound_reply_before_delivery_settle")
    return yield* recoverAdmission(witness);
  if (outboundPoints.has(point)) return yield* recoverOutbound(witness, dbPath);
  switch (witness.crashPoint) {
    case "recovery_dispatch_identity_committed_before_rpc":
      return yield* recoverContinuation(witness);
    case "retry_backoff_wait":
      return yield* recoverRetryAlarm(witness);
    case "owner_reclaimed_before_stale_transcript_flush":
      return yield* recoverStaleOwner(witness);
    case "turn_intent_before_llm_entry":
    case "delivery_admitted_before_turn_open":
      return yield* recoverAdmission(witness);
    default:
      return yield* recoverExecutor(witness);
  }
  });
}

async function crashCell(point: CrashPoint, dbPath: string) {
  const initial = await crash(point, dbPath);
  if (point !== "recovery_dispatch_identity_committed_before_rpc") return initial;
  expect(initial.bodies).toEqual([]);
  expect(initial.openTurns).toHaveLength(1);
  expect(initial.openTurns[0]?.resumeCount).toBe(0);
  const resumed = await crash(point, dbPath, "resume");
  expect(resumed.openTurns).toEqual(initial.openTurns.map((turn) => ({ ...turn, resumeCount: 1 })));
  return resumed;
}

async function recoverReconstructionCell(point: z.infer<typeof reconstructionPoint>, witness: Witness, dbPath: string) {
  // Phase 1: reopen the crashed stores, capture the durable prefix, close them
  // again so the fresh reconstruction child owns the file alone.
  const durable = await isolatedRun(() => {
    const before = actions();
    const full = foldHistoryState(sessionId, before);
    const projection = foldSessionHistory(sessionId, before);
    if (point !== "captured_generation_missing_after_restart") {
      expect(witness.fold?.checkpointId).not.toBeNull();
      expect(hydrateSessionHistory(isolatedLedger().kernel, sessionId).state).toEqual(full);
    }
    return Promise.resolve({ before, full, projection });
  }, () => openCrashStores(dbPath));
  if (point === "fold_checkpoint_tampered_before_load") corruptCheckpoint(dbPath);
  const reopened = Bun.spawn([process.execPath, new URL("../helpers/crash-reconstruction.ts", import.meta.url).pathname, point, dbPath], {
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await bounded(Promise.all([
    reopened.exited, new Response(reopened.stdout).text(), new Response(reopened.stderr).text(),
  ]), "fresh reconstruction process", SPAWNED_CHILD_MS);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  const recovered = reconstructionRecovery.parse(JSON.parse(stdout));
  // Phase 2: this parent reopens the settled stores for the durable-state checks.
  return isolated(Effect.gen(function* () {
    const ledger = isolatedLedger();
    const { before, full, projection } = durable;
    if (point === "fold_checkpoint_tampered_before_load") {
      expect(recovered).toMatchObject({ refusal: "FoldCheckpointIntegrityError", runnerCount: 0, loaded: null, rangeReads: [] });
      return "rejected";
    }
    if (point === "captured_generation_missing_after_restart") {
      expect(recovered).toMatchObject({ refusal: "GenerationUnavailable", runnerCount: 0, loaded: null, captures: [1] });
      return "rejected";
    }
    expect(recovered.refusal).toBeNull();
    expect(recovered.loaded?.state).toEqual(full);
    expect(recovered.loaded?.history).toEqual(projection);
    // Chain-fold reads (backlog, received messages) legitimately page from
    // cursor 0; the fold-reconstruction guard is bounded pages plus at least
    // one checkpoint-cursored hydration read.
    expect(recovered.rangeReads.every((read) => read.limit <= 256)).toBe(true);
    expect(recovered.rangeReads.some((read) => read.cursor > 0)).toBe(true);
    if (point === "fold_checkpoint_committed_before_wake") {
      expect(before.at(-1)?.ordinal).toBe(257);
      expect(before.at(-1)?.kind).toBe("fold.checkpoint");
    }
    if (point === "same_id_result_after_checkpoint_before_wake") {
      expect(projection.map((message) => message.info.id)).toEqual(["same-id"]);
      expect(projection[0]?.parts).toMatchObject([{ type: "text", text: "after checkpoint" }]);
    }
    if (point === "context_restore_checkpoint_committed_before_publish") {
      expect(witness.bodies).toEqual(["summary"]);
      expect(projection.map((message) => message.info.id)).toEqual(["same-id", "answer"]);
      expect(witness.fold?.publicationCount).toBe(0);
    }
    if (point === "open_tool_checkpoint_before_terminal") {
      expect(witness.bodies).toEqual(["tool"]);
      expect(full.messages.flatMap((message) => message.parts).filter((part) => part.type === "tool")).toMatchObject([
        { callID: "open-call", state: { status: "pending" } },
      ]);
      expect(readFileSync(`${dbPath}.effect`, "utf8")).toBe("write-once\n");
      const recording = yield* requestLedger({ id: sessionId, clock: () => 100_000 });
      const executor = testExecutor({ ...recording, observations, policy: compiledPolicy() });
      yield* executor.recover();
      expect(results("tool").map(effectOf)).toMatchObject([{ terminal: "outcome_unknown", recovery: { site: "crash", rawSettled: false } }]);
      const settled = actions();
      yield* executor.recover();
      expect(actions()).toEqual(settled);
      expect(readFileSync(`${dbPath}.effect`, "utf8")).toBe("write-once\n");
      expect(hydrateSessionHistory(ledger.kernel, sessionId).state).toEqual(foldHistoryState(sessionId, actions()));
      return "lost";
    }
    expect(recovered.runnerCount).toBe(1);
    expect(recovered.runnerHistory).toEqual(projection);
    expect(hydrateSessionHistory(ledger.kernel, sessionId).state).toEqual(foldHistoryState(sessionId, actions()));
    return "resumed_without_reexecution";
  }), () => openCrashStores(dbPath));
}

async function configureCrashCell(dbPath: string) {
  const configureScript = new URL("../helpers/crash-configure.ts", import.meta.url).pathname;
  const cut = configureCutProof.parse(JSON.parse(await killAtCrashBarrier(configureScript, ["crash", dbPath])));
  expect(cut.crashPoint).toBe(configureCrashPoint);
  expect(cut.hibernations).toBe(0);
  expect(cut.snapshot).toMatchObject({ generation: 2, revertTo: 1 });
  {
    const proof = await recoverChild(configureScript, [dbPath], "fresh configure recovery", configureRecoveryProof);
    expect(proof.before).toEqual(cut.actions);
    expect(proof.idle).toEqual(proof.before);
    expect(proof.snapshot).toEqual(cut.snapshot);
    expect(proof.captured).toEqual([cut.snapshot]);
    expect(proof.runnerGenerations).toEqual([2]);
    expect(proof.configureCalls).toBe(0);
    expect(proof.after.slice(0, proof.before.length)).toEqual(proof.before);
    expect(proof.repeated).toEqual(proof.after);
    const configured = (actions: readonly LedgerAction.Node[]) => actions.filter((action: LedgerAction.Node) => action.kind === "session.configure");
    expect(configured(proof.before)).toHaveLength(2);
    expect(configured(proof.after)).toEqual(configured(proof.before));
    return "resumed_without_reexecution";
  }
}

test("the authoritative crash matrix names every crash point once", () => {
  expect(matrix.version).toBe(2);
  expect(matrix.rows.map((row) => row.crashPoint).sort()).toEqual([...crashPoint.options].sort());
});

// One test per cell: each cell spawns a child kernel (two for the resumed
// continuation), and under the exact coverage collector the seventeen children
// together exceed one test budget.
for (const row of matrix.rows) {
  test(`SQLite crash recovery matches the authoritative matrix cell ${row.crashPoint}`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "crash-matrix-"));
    try {
      const dbPath = join(directory, "kernel.sqlite");
      if (row.crashPoint === configureCrashPoint) {
        expect(recovery.parse(await configureCrashCell(dbPath))).toBe(row.recovery);
        return;
      }
      if (row.crashPoint === "watch_fired_committed_before_entity_wake") {
        expect(recovery.parse(await watchWakeCell(dbPath))).toBe(row.recovery);
        return;
      }
      if (row.crashPoint === "fiber_exit_after_execute_before_action_commit") {
        expect(await fiberCrashCell(`${dbPath}.receipt`, "present")).toBe("resumed_without_reexecution");
        expect(recovery.parse(await fiberCrashCell(dbPath))).toBe(row.recovery);
        return;
      }
      const witness = await crashCell(row.crashPoint, dbPath);
      const reconstruction = reconstructionPoint.safeParse(row.crashPoint);
      if (reconstruction.success) {
        expect(recovery.parse(await recoverReconstructionCell(reconstruction.data, witness, dbPath))).toBe(row.recovery);
        return;
      }
      // Durability check: an independent handle over the crashed file reads the
      // identical tree the recovery isolation is about to see.
      const persistedHandle = openCrashStores(dbPath);
      const persisted = sessionTree(persistedHandle.kernel, sessionId);
      persistedHandle.close();
      const result = await isolated(Effect.scoped(Effect.gen(function* () {
        expect(actions()).toEqual(persisted);
        return yield* recoverCell(witness, dbPath);
      })), () => openCrashStores(dbPath));
      expect(recovery.parse(result)).toBe(row.recovery);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
