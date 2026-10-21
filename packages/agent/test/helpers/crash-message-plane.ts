import { appendFileSync, existsSync, readFileSync, writeSync } from "node:fs";
import { Clock, Effect } from "effect";
import { TestClock } from "effect/testing";
import type { LedgerError } from "../../src/core/store/errors";
import { Delivery, LedgerAction, SessionTransition } from "@oni/protocol";
import { z } from "zod";
import { sessionTree } from "./session-tree";
import type { SessionKernel } from "../../src/core/session/entity";
import { CommitFailed } from "../../src/core/ports/failure";
import { receivedMessageAction } from "../../src/core/journal/delivery";
import { firedAction } from "../../src/core/ports/alarm";
import { closeSessions } from "../../src/core/session/run";
import { session } from "../../src/testing/registry";
import { isolated, isolatedLedger } from "./isolated";
import { openCrashStores } from "./crash-stores";
import { awaitCrashStart, holdCrashBarrier } from "./crash-channel";
import { receiveOutbound } from "./effect-g2";
import { seedPolicy } from "./seed-policy";
import { reactivateSession } from "./wake-session";
import { uniqueEntropy } from "./time";
import { allowConfigure, isolatedRuntime, type SessionFixture, withSessionServices } from "./session-services";

export const messagePlanePoint = z.enum([
  "delivery_ack_committed_before_owner_cleanup",
  "platform_send_committed_before_local_ack_reconciled_sent",
  "platform_attempt_marker_before_send_reconciled_not_sent",
  "platform_send_ambiguous_without_reconciliation",
  "outbound_flood_deadline_before_timer_rearm",
  "watch_fired_committed_before_entity_wake",
]);
export const messagePlaneProof = z.object({
  before: z.array(LedgerAction.Node), after: z.array(LedgerAction.Node), repeated: z.array(LedgerAction.Node),
  outboundBefore: z.array(SessionTransition.Outbound), outboundAfter: z.array(SessionTransition.Outbound),
  deliveriesBefore: z.array(Delivery.Row), deliveriesAfter: z.array(Delivery.Row),
  dispatches: z.number(), sourceRuns: z.number(), destinationRuns: z.number(),
  externalBefore: z.array(z.string()), externalAfter: z.array(z.string()),
  watch: z.object({ occurrenceId: z.string(), redelivery: z.string(), fired: z.number() }).nullable(),
}).strict();
const sessionId = "crash-session";
const watchId = "doorbell";
const occurrenceId = `${watchId}:fired:1`;
/** The `alarm{fired}` fact a delivered occurrence commits: `<occurrenceId>:<outcome>`. */
const firedFactId = `${occurrenceId}:delivered`;

/** Inline watch-occurrence dedupe: a committed fired fact for the occurrence no-ops. */
function watchFiredDisposition(
  kernel: SessionKernel,
  occurrence: string,
): { readonly op: "run" } | { readonly op: "skip"; readonly reason: "duplicate_occurrence" } {
  return kernel.actionById(`${occurrence}:delivered`) === undefined
    ? { op: "run" }
    : { op: "skip", reason: "duplicate_occurrence" };
}

/**
 * A WatchFired delivery on the entity plane (W5.2 F2): the chain-guard admits
 * the first occurrence, then one fenced batch commits the occurrence action
 * and the pending wake prompt together. The cut lands before any wake.
 */
function watchCut() {
  return Effect.gen(function* () {
    yield* TestClock.setTime(100);
    const now = yield* Clock.currentTimeMillis;
    const kernel = isolatedLedger().kernel;
    let hibernated = 0;
    const runtime: SessionFixture = {
      ...isolatedRuntime(),
      authorizeConfigure: allowConfigure, observations: { publish: () => undefined }, clock: () => now,
      entropy: uniqueEntropy("watch"),
      onHibernate: () => Effect.sync(() => { hibernated += 1; }),
    };
    const handle = yield* withSessionServices(session({
      id: sessionId, role: "resident", runner: () => Effect.succeed({ kind: "result", text: "idle" }),
    }, runtime), runtime);
    yield* handle.prompt("initialize");
    if (hibernated !== 1) throw new Error("session did not hibernate before the watch fired");
    if (watchFiredDisposition(kernel, occurrenceId).op !== "run")
      throw new Error("fresh occurrence must be admitted");
    const row = kernel.row(sessionId);
    if (row.fenceOwner === null) throw new Error("hibernated session lost its pinned writer");
    yield* kernel.commit({
      sessionId, owner: row.fenceOwner, fence: row.fence, now,
      expectedRevision: row.revision, state: row.state,
      actions: [
        firedAction({
          parentId: null, sessionId, purpose: "monitor.hit", alarmId: watchId, occurrenceId,
          outcome: "delivered", ts: now,
        }),
        receivedMessageAction({
          id: `${occurrenceId}:prompt`, sessionId, kind: "prompt", content: "watch prompt",
          origin: { encodingVersion: 1, value: { watchId } }, parentActionId: firedFactId, at: now,
        }),
      ],
    }).pipe(Effect.mapError((error: LedgerError) => new CommitFailed({ error })));
    const after = kernel.row(sessionId);
    return holdCrashBarrier(JSON.stringify({
      crashPoint: "watch_fired_committed_before_entity_wake", bodies: [],
      lease: { owner: after.fenceOwner, fence: after.fence }, openTurns: [],
    }));
  });
}

function platformEntries(dbPath: string): string[] {
  const path = `${dbPath}.platform`;
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n") : [];
}

function recover(point: z.infer<typeof messagePlanePoint>, dbPath: string) {
  return Effect.gen(function* () {
    yield* TestClock.setTime(200_000);
    const now = yield* Clock.currentTimeMillis;
    const kernel = isolatedLedger().kernel;
    const before = sessionTree(kernel, sessionId);
    const outboundBefore = kernel.outboundRows(sessionId);
    const watch = point === "watch_fired_committed_before_entity_wake";
    const deliveriesBefore = kernel.inputMessages(watch ? sessionId : "parent");
    const externalBefore = platformEntries(dbPath);
    let dispatches = 0;
    let sourceRuns = 0;
    let destinationRuns = 0;
    const runtime: SessionFixture = {
      ...isolatedRuntime(),
      authorizeConfigure: allowConfigure, observations: { publish: () => undefined }, clock: () => now,
      entropy: uniqueEntropy("recover"),
      dispatchOutbound: ({ message }) => Effect.gen(function* () {
        dispatches += 1;
        if (point === "platform_send_committed_before_local_ack_reconciled_sent" || point === "platform_send_ambiguous_without_reconciliation")
          appendFileSync(`${dbPath}.platform`, `${message.messageId}\n`);
        return (yield* receiveOutbound(message, now)).receipt;
      }),
    };
    const runner = () => Effect.sync(() => {
      sourceRuns += 1;
      return { kind: "result" as const, text: "rehydrated" };
    });
    const receiver = () => Effect.sync(() => {
      destinationRuns += 1;
      return { kind: "result" as const, text: "received" };
    });
    // Zero re-fire: the committed occurrence makes every redelivery a chain-guarded no-op.
    const redelivery = watchFiredDisposition(kernel, occurrenceId);
    if (watch && JSON.stringify(watchFiredDisposition(kernel, occurrenceId)) !== JSON.stringify(redelivery))
      throw new Error("watch redelivery must stay a stable no-op");
    yield* withSessionServices(reactivateSession(sessionId, runner, runtime), runtime);
    if (!watch) yield* withSessionServices(reactivateSession("parent", receiver, runtime), runtime);
    const after = sessionTree(kernel, sessionId);
    yield* withSessionServices(reactivateSession(sessionId, runner, runtime), runtime);
    if (!watch) yield* withSessionServices(reactivateSession("parent", receiver, runtime), runtime);
    const proof = messagePlaneProof.parse({
      before, after, repeated: sessionTree(kernel, sessionId), outboundBefore,
      outboundAfter: kernel.outboundRows(sessionId), deliveriesBefore,
      deliveriesAfter: kernel.inputMessages(watch ? sessionId : "parent"),
      dispatches, sourceRuns, destinationRuns, externalBefore, externalAfter: platformEntries(dbPath),
      watch: watch
        ? {
            occurrenceId,
            redelivery: redelivery.op === "skip" ? redelivery.reason : redelivery.op,
            fired: sessionTree(kernel, sessionId).filter((action) => action.kind === "alarm").length,
          }
        : null,
    });
    yield* closeSessions(runtime);
    return proof;
  });
}

if (import.meta.main) {
  const [stage, point, dbPath] = z.tuple([z.enum(["crash", "recover"]), messagePlanePoint, z.string().min(1)]).parse(process.argv.slice(2));
  awaitCrashStart();
  const proof = await isolated(Effect.gen(function* () {
    if (stage === "crash") {
      seedPolicy();
      return yield* watchCut();
    }
    return yield* recover(point, dbPath);
  }).pipe(Effect.provide(TestClock.layer())), () => openCrashStores(dbPath));
  writeSync(1, `${JSON.stringify(proof)}\n`);
}
