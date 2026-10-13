import { sessionTree } from "./session-tree";
import { runAgent, testExecutor } from "./executor";
import { AsyncLocalStorage } from "node:async_hooks";
import { foldCrashMain, foldCrashPoint, foldCrashProof } from "./fold-crash";
import { configureCrashPoint } from "./crash-configure";
import { reconstructionCut, reconstructionPoint } from "./crash-reconstruction";
import { turnTestLayer, catalogLayer } from "./service-layers";
import { runnerTestLayer } from "./isolated";
import { allowConfigure, isolatedRuntime, type SessionFixture as SessionRuntime, type SessionFixture, withSessionServices } from "./session-services";
import { activeIsolation, isolatedLedger, isolatedRun } from "./isolated";
import { openCrashStores } from "./crash-stores";
import type { ResolvedExecutorOptions } from "../../src/core/gate/decide";
import { Effect } from "effect";
import { appendFileSync, writeSync } from "node:fs";
import * as SessionHandleStore from "../../src/core/store/fence";
import type { LedgerError } from "../../src/core/store/errors";
import { LedgerAction, Message, PlainObjectSchema, PlainValueSchema, type PlainValue, } from "@openomni/protocol";
import { z } from "zod";
import type { ExecutionLedger } from "../../src/core/gate/decide";
import { createLedgerRetryAlarmPort } from "../../src/core/gate/decide";
import { executeCompaction } from "../../src/plugins/compaction/execute-cut";
import { session } from "../../src/testing/registry";
import { reactivateSession } from "./wake-session";
import { commitReceivedMessage } from "./ingress";

import { receiveOutbound } from "./receive-outbound";
import { createTurnDispatcher } from "../../src/plugins/tool";
import { requestLedger } from "./request-ledger";
import { compiledPolicy } from "./compiled-policy";
import { runChatAttempts } from "./chat-attempts";
import { providerFailure } from "./mock-llm";
import { stringQueryTool } from "./query-tool";
import { textMessage } from "./messages";
import { seedPolicy } from "./seed-policy";
import { uniqueEntropy } from "./time";
import { CommitFailed, AgentFailure, type SessionError } from "../../src/core/failure";
import { TEST_APPROVAL_POLICY } from "../helpers/approval-policy";

export const crashPoint = z.enum([
  configureCrashPoint,
  "turn_intent_before_llm_entry",
  "llm_body_before_attempt_result_commit",
  "fiber_exit_after_execute_before_action_commit",
  "llm_result_committed",
  "tool_wave_between_result_commits",
  "retry_backoff_wait",
  "compaction_summary_before_result_commit",
  "compaction_summary_before_boundary_commit",
  "delivery_admitted_before_turn_open",
  "outbound_reply_before_delivery_settle",
  "recovery_dispatch_identity_committed_before_rpc",
  "compaction_boundary_committed_before_publication",
  "delivery_ack_committed_before_owner_cleanup",
  "platform_send_committed_before_local_ack_reconciled_sent",
  "platform_attempt_marker_before_send_reconciled_not_sent",
  "platform_send_ambiguous_without_reconciliation",
  "compaction_concurrent_tail_committed_before_owner_crash",
  "outbound_flood_deadline_before_timer_rearm",
  "watch_fired_committed_before_entity_wake",
  "owner_reclaimed_before_stale_transcript_flush",
  ...reconstructionPoint.options,
]);
export const recovery = z.enum([
  "resumed_without_reexecution",
  "replayed",
  "rearmed",
  "not_durable",
  "rejected",
  "lost",
]);
export const matrixSchema = z
  .object({
    version: z.literal(2),
    rows: z.array(z.object({ crashPoint, recovery, note: z.string().min(1) }).strict()).min(17),
  })
  .strict();
const allCrashPoints = z.enum([...new Set([...crashPoint.options, ...foldCrashPoint.options])]);
export const crashWitness = z
  .object({
    crashPoint: allCrashPoints,
    bodies: z.array(z.string()),
    pending: z.object({ kind: z.string(), effect: PlainObjectSchema }).optional(),
    staleAction: LedgerAction.Append.optional(),
    fold: foldCrashProof.optional(),
    lease: z.object({
      owner: z.string().nullable(),
      fence: z.number(),
    }),
    openTurns: z.array(
      z.object({ turnId: z.string(), resultId: z.string(), resumeCount: z.number() }),
    ),
  })
  .strict();
export type CrashPoint = z.infer<typeof crashPoint>;
export const sessionId = "crash-session";
export const observations = { publish: () => undefined };
export const effectOf = (action: LedgerAction.Append) =>
  PlainObjectSchema.parse(action.effect.value);
export const intentOf = (action: LedgerAction.Append) =>
  PlainObjectSchema.parse(action.intent.value);

/** The committed checkpoint payload and the protected original answer, schema-typed. */
export function checkpointEvidence(
  result: PlainValue | undefined,
  messageResults: readonly LedgerAction.Append[],
) {
  const committed = z
    .object({ summary: z.literal("checkpoint"), projection: z.array(Message.WithParts) })
    .parse(result);
  const originalAnswer = z
    .array(Message.WithParts)
    .parse(messageResults.map((action: LedgerAction.Append) => effectOf(action).result))
    .find((message: Message.WithParts) => message.info.id === "answer");
  return { committed, originalAnswer };
}

export const outboundPoints = new Set<CrashPoint>([
  "outbound_reply_before_delivery_settle",
  "delivery_ack_committed_before_owner_cleanup",
  "platform_send_committed_before_local_ack_reconciled_sent",
  "platform_attempt_marker_before_send_reconciled_not_sent",
  "platform_send_ambiguous_without_reconciliation",
  "outbound_flood_deadline_before_timer_rearm",
]);
export const committedCompactionPoints = new Set<CrashPoint>([
  "compaction_boundary_committed_before_publication",
  "compaction_concurrent_tail_committed_before_owner_crash",
]);

type Witness = z.infer<typeof crashWitness>;
const witnessSink = new AsyncLocalStorage<(witness: Witness) => void>();

export function emitCrashWitness(witness: Witness, write: (fd: number, value: string) => void = writeSync, exit: (code: number) => void = process.exit): void {
  write(1, `${JSON.stringify(witness)}\n`);
  exit(0);
}

// Synchronous witness output also permits cuts inside the synchronous store commit port.
function stop(point: z.infer<typeof allCrashPoints>, bodies: string[], pending?: LedgerAction.Append, fold?: z.infer<typeof foldCrashProof>): never {
  const kernel = isolatedLedger().kernel;
  const row = kernel.row(sessionId);
  const witness = crashWitness.parse({
    crashPoint: point,
    bodies,
    ...(fold === undefined ? {} : { fold }),
    lease: { owner: row.fenceOwner, fence: row.fence },
    openTurns: SessionHandleStore.openTurns(sessionTree(kernel, sessionId)),
    ...(pending === undefined
      ? {}
      : { pending: { kind: pending.kind, effect: pending.effect.value } }),
    ...(point === "owner_reclaimed_before_stale_transcript_flush" ? { staleAction: pending } : {}),
  });
  (witnessSink.getStore() ?? emitCrashWitness)(witness);
  throw new Error("crash witness returned without exiting");
}

function beforeResult(point: CrashPoint, action: LedgerAction.Append, toolResults: number) {
  if (point === "compaction_summary_before_boundary_commit")
    return action.kind === "compaction" && effectOf(action).phase === "boundary";
  if (effectOf(action).phase !== "result") return false;
  switch (point) {
    case "llm_body_before_attempt_result_commit":
    case "owner_reclaimed_before_stale_transcript_flush":
      // Attempts share the llm kind; the attempt result is the one
      // carrying durable usage provenance.
      return action.kind === "llm" && effectOf(action).usageProvenance !== undefined;
    case "tool_wave_between_result_commits":
      return action.kind === "tool" && toolResults === 2;
    case "compaction_summary_before_result_commit":
      return action.kind === "compaction";
    default:
      return false;
  }
}

function intercept(ledger: ExecutionLedger, point: CrashPoint, bodies: string[]): ExecutionLedger {
  let toolResults = 0;
  return {
    ...ledger,
    commit(action: LedgerAction.Append) {
      return Effect.gen(function* () {
        const result = effectOf(action).phase === "result";
        if (action.kind === "tool" && result) toolResults += 1;
        if (beforeResult(point, action, toolResults)) return stop(point, bodies, action);
        const receipt = yield* ledger.commit(action);
        const after =
          (point === "llm_result_committed" && action.kind === "llm" &&
            effectOf(action).usageProvenance === undefined) ||
          (committedCompactionPoints.has(point) && action.kind === "compaction");
        if (after && result) return stop(point, bodies, action);
        return receipt;
      });
    },
  };
}

function executePoint(point: CrashPoint, bodies: string[]) {
  return Effect.gen(function* () {
    const recording = requestLedger({ id: sessionId });
    if (
      point === "turn_intent_before_llm_entry" ||
      point === "recovery_dispatch_identity_committed_before_rpc"
    )
      return stop(point, bodies);
    const ledger = intercept(recording.ledger, point, bodies);
    const executor = testExecutor({
      ...recording,
      ledger,
      policy: compiledPolicy(),
      observations,
      // The durable arm (retry.scheduled chain action) commits before the cut:
      // only the wait itself is lost.
      retryAlarm: {
        ...createLedgerRetryAlarmPort(ledger, sessionId, recording.clock),
        wait: () => Effect.sync(() => stop(point, bodies)),
      },
    });
    if (point === "tool_wave_between_result_commits") {
      const tools = ["first", "second"].map((name: string) =>
        stringQueryTool(name, name, async () => {
          bodies.push(name);
          return name;
        }),
      );
      const dispatcher = (yield* Effect.gen(function* () { const turnInput: Parameters<typeof createTurnDispatcher>[0] & { readonly policy?: ResolvedExecutorOptions["policy"] } = {
          ...recording.identity,
          actionId: recording.identity.turnId,
          ledger,
          policy: compiledPolicy(),
        }; const turnRuntime: Parameters<typeof createTurnDispatcher>[1] & Partial<Pick<ResolvedExecutorOptions, "clock" | "entropy" | "observations">> = { approvalPolicy: TEST_APPROVAL_POLICY, observations, clock: recording.clock, entropy: recording.entropy }; return yield* createTurnDispatcher(turnInput, turnRuntime).pipe(Effect.provide(catalogLayer(tools)), Effect.provide(turnTestLayer(turnInput, turnRuntime))); }));
      return yield* dispatcher.executeWave(
        tools.map((tool: (typeof tools)[number]) => ({
          id: tool.name,
          tool: tool.name,
          input: {},
        })),
        {
          sessionId,
          turnId: recording.identity.turnId,
        },
      );
    }
    if (
      point === "compaction_summary_before_result_commit" ||
      point === "compaction_summary_before_boundary_commit" ||
      committedCompactionPoints.has(point)
    ) {
      const history = [
        textMessage("assistant", "earlier evidence ".repeat(200), sessionId, "earlier"),
        textMessage("assistant", "answer", sessionId, "answer"),
      ];
      for (const message of history) {
        yield* executor.run({ kind: "message", op: "assistant", intent: {}, effect: {} }, () =>
          Effect.sync(() => PlainValueSchema.parse(message)),
        );
      }
      return yield* executeCompaction({
        history,
        executor,
        events: observations,
        options: {
          contextWindowTokens: 10_000,
          protectRecentMessages: 1,
          onSummarize: () =>
            Effect.gen(function* () {
              bodies.push("summary");
              if (point === "compaction_concurrent_tail_committed_before_owner_crash") {
                yield* commitReceivedMessage(isolatedLedger().kernel, {
                  id: "tail",
                  sessionId,
                  kind: "prompt",
                  content: "concurrent tail",
                  createdAt: 100,
                  origin: { encodingVersion: 1, value: {} },
                  parentActionId: null,
                }).pipe(Effect.mapError((error: LedgerError) => new CommitFailed({ error })));
              }
              return "checkpoint";
            }),
        },
        identity: { traceId: "crash", sessionId },
        dispatch: { trigger: "yield" },
      });
    }
    return yield* runChatAttempts(executor, () =>
      Effect.gen(function* () {
        bodies.push("llm");
        if (point === "retry_backoff_wait") return yield* providerFailure("overloaded");
        return { type: "stop" };
      }),
    );
  });
}

/**
 * The entity-plane owner-cleanup seam: hibernation runs only after the ACK
 * commit is durable, so crashing here leaves the delivered outbound row with
 * its activation authority never cleaned up.
 */
function hibernateCut(point: CrashPoint, bodies: string[]) {
  return () => Effect.sync(() => {
    if (
      point === "delivery_ack_committed_before_owner_cleanup" &&
      bodies.includes("accepted") &&
      isolatedLedger().kernel.outboundRows(sessionId).some(
        (item: import("@openomni/protocol").SessionTransition.Outbound) => item.state === "delivered",
      )
    )
      stop(point, bodies);
  });
}

function outboundPort(
  point: CrashPoint,
  bodies: string[],
  dbPath: string,
): SessionRuntime["dispatchOutbound"] {
  return ({ message }: Parameters<NonNullable<SessionRuntime["dispatchOutbound"]>>[0]) =>
    Effect.gen(function* () {
      if (point === "outbound_flood_deadline_before_timer_rearm") {
        bodies.push("flood");
        return yield* new AgentFailure({ operation: "outbound.flood", cause: "flood" });
      }
      if (point === "platform_send_ambiguous_without_reconciliation") {
        appendFileSync(`${dbPath}.platform`, `${message.messageId}\n`);
        bodies.push("accepted");
        return stop(point, bodies);
      }
      if (
        point === "delivery_ack_committed_before_owner_cleanup" ||
        point === "platform_send_committed_before_local_ack_reconciled_sent"
      ) {
        if (point === "platform_send_committed_before_local_ack_reconciled_sent")
          appendFileSync(`${dbPath}.platform`, `${message.messageId}\n`);
        const { receipt } = receiveOutbound(isolatedLedger().kernel, message, 100);
        bodies.push("accepted");
        if (point === "platform_send_committed_before_local_ack_reconciled_sent")
          stop(point, bodies);
        return receipt;
      }
      return stop(point, bodies);
    });
}

function admissionPoint(point: CrashPoint, bodies: string[], dbPath: string) {
  return Effect.gen(function* () {
    const runtime: SessionRuntime = {
      ...isolatedRuntime(),
      authorizeConfigure: allowConfigure,
      observations,
      clock: () => 100,
      entropy: uniqueEntropy("admission"),
      onHibernate: hibernateCut(point, bodies),
      dispatchOutbound: outboundPort(point, bodies, dbPath),
    };
    const runner = () =>
      Effect.sync(() => {
        bodies.push("reply");
        return { kind: "result" as const, text: "durable reply" };
      });
    if (point === "delivery_admitted_before_turn_open") {
      yield* Effect.gen(function* () { const fixture: SessionFixture = runtime; return yield* withSessionServices(session({ id: sessionId, role: "resident", runner }, fixture), fixture); });
      yield* commitReceivedMessage(isolatedLedger().kernel, {
        id: "admitted",
        sessionId,
        kind: "prompt",
        content: "original prompt",
        createdAt: 100,
        origin: { encodingVersion: 1, value: {} },
        parentActionId: null,
      });
      return stop(point, bodies);
    }
    yield* Effect.gen(function* () { const fixture: SessionFixture = runtime; return yield* withSessionServices(session({ id: "parent", role: "resident", runner }, fixture), fixture); });
    const commission = yield* commitReceivedMessage(isolatedLedger().kernel, {
      id: "commission",
      sessionId: "parent",
      kind: "prompt",
      content: "commission",
      createdAt: 100,
      origin: { encodingVersion: 1, value: {} },
      parentActionId: null,
    });
    const child = yield* Effect.gen(function* () { const fixture: SessionFixture = runtime; return yield* withSessionServices(session({ id: sessionId, parentId: "parent", role: "child", runner }, fixture), fixture); });
    return yield* child
      .prompt("work", {
        encodingVersion: 1,
        value: {
          kind: "message",
          messageId: "commission",
          senderSessionId: "parent",
          sourceActionId: commission.receipt.action.id,
        },
      })
      .pipe(
        Effect.catch((error: SessionError) => {
          if (point !== "outbound_flood_deadline_before_timer_rearm") return Effect.fail(error);
          if (error._tag !== "AgentFailure" || error.operation !== "outbound.flood")
            return Effect.fail(error);
          return Effect.sync(() => stop(point, bodies));
        }),
      );
  });
}

export async function crashMatrixMain(args: string[], emit: (witness: Witness) => void = emitCrashWitness) {
  const [cut, dbPath, stage] = z
    .tuple([allCrashPoints, z.string().min(1), z.enum(["initial", "resume"])])
    .parse(args);
  const main = async () => {
    const reconstruct = reconstructionPoint.safeParse(cut);
    if (reconstruct.success) return runAgent(reconstructionCut(reconstruct.data, dbPath,
      (bodies, pending, proof) => stop(cut, bodies, pending, proof)).pipe(Effect.provide(runnerTestLayer)));
    const fold = foldCrashPoint.safeParse(cut);
    if (fold.success) return foldCrashMain(fold.data, (bodies, pending, proof) => stop(cut, bodies, pending, proof));
    const point = crashPoint.parse(cut);
    return runAgent(Effect.scoped(Effect.gen(function* () {
      const bodies: string[] = [];
      if (stage === "resume") {
        const fixture: SessionFixture = { ...isolatedRuntime(), observations, clock: () => 100_000, entropy: uniqueEntropy("resume"), authorizeConfigure: allowConfigure };
        yield* withSessionServices(reactivateSession(sessionId, () => Effect.sync(() => {
          stop(point, bodies);
          return { kind: "result" as const, text: "" };
        }), fixture), fixture);
      } else if (point === "delivery_admitted_before_turn_open" || outboundPoints.has(point)) {
        yield* admissionPoint(point, bodies, dbPath);
      } else yield* executePoint(point, bodies);
    }).pipe(Effect.provide(runnerTestLayer))));
  };
  return witnessSink.run(emit, () => {
    const ambient = activeIsolation();
    if (ambient !== undefined) return main();
    return isolatedRun(() => {
      seedPolicy();
      return main();
    }, () => openCrashStores(dbPath));
  });
}

if (import.meta.main) await crashMatrixMain(process.argv.slice(2));
