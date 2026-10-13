/**
 * #1254 S4 — the single admission writer fiber, unit-tested over the exported
 * `writerLoop` seam with REAL stores and a capturing replier:
 *
 *  - envelopes are served strictly in arrival order (one writer, no racing
 *    handler fibers);
 *  - D3: after `alarmsBeforePrompt` consecutive alarm wakes a queued prompt
 *    delivery is served first, then the deferred alarm;
 *  - a revision-CAS loss is retried at most 3 times, then surfaces as the
 *    typed `AdmissionFailure{code: revision}` — never an unbounded spin;
 *  - interruption (scope close) drains the queue: every still-queued envelope
 *    is failed with `AdmissionFailure{code: shutdown}` so the persisted
 *    envelope redelivers to the next activation.
 */
import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { type Cause, Deferred, Effect, Exit, Fiber, Queue, Semaphore } from "effect";
import { EntityAddress, EntityId, EntityType, Envelope, ShardId, Snowflake, type Entity } from "effect/cluster";
import type { Rpc } from "effect/rpc";
import { Headers } from "effect/http";
import { openCatalogStore } from "../../src/core/store/catalog";
import { openSessionStore } from "../../src/core/store/session-file";
import * as SessionHandleStore from "../../src/core/store/fence";
import { CommitRefused } from "../../src/core/store/errors";
import { armAction, AlarmWakeError, type AlarmCapability } from "../../src/core/alarm";
import { writerLoop, type ActivationHandle, type SessionKernel } from "../../src/core/entity";
import { AdmissionFailure, AlarmOccurrence, type AlarmRpc, type DeliverRpc, type ReadRpc, type ResolveRpc } from "../../src/core/messages";
import type { SessionEntityPorts } from "../../src/core/run";
import { clusterTempDir, makeTurnPort, resolvedRunner, sessionFileFor } from "../helpers/cluster-runtime";
import { runAgent } from "../helpers/executor";
import type { Delivery } from "@openomni/protocol";
import { TEST_APPROVAL_POLICY } from "../helpers/approval-policy";

const { dir, sessionsDir, catalogFile } = clusterTempDir("w52-writer-fiber-");

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

type SessionRpcs = typeof DeliverRpc | typeof ResolveRpc | typeof AlarmRpc | typeof ReadRpc;
type SessionRequest = Envelope.Request<SessionRpcs>;
type SessionReplier = Entity.Replier<SessionRpcs>;

const address = (sessionId: string) =>
  EntityAddress.make({
    shardId: ShardId.make("default", 1),
    entityType: EntityType.make("Session"),
    entityId: EntityId.make(sessionId),
  });

let nextRequestId = 1n;
function envelope(
  sessionId: string,
  tag: Envelope.Request<SessionRpcs>["tag"],
  payload: Envelope.Request<SessionRpcs>["payload"],
): SessionRequest {
  nextRequestId += 1n;
  return Envelope.makeRequest<SessionRpcs>({
    requestId: Snowflake.Snowflake(nextRequestId),
    address: address(sessionId),
    tag,
    payload,
    headers: Headers.empty,
  });
}

function origin(messageId: string): string {
  const value: Delivery.MessageOrigin = {
    kind: "message",
    messageId,
    senderSessionId: "peer",
    sourceActionId: messageId,
  };
  return JSON.stringify(value);
}

const promptEnvelope = (sessionId: string, id: string): SessionRequest =>
  envelope(sessionId, "Deliver", {
    kind: "prompt",
    body: JSON.stringify({ content: `content ${id}` }),
    source: origin(id),
    idempotencyKey: id,
  });

/** An occurrence no arm row backs: the loop folds it `stale` (one append). */
const staleAlarmEnvelope = (sessionId: string, n: number): SessionRequest =>
  envelope(
    sessionId,
    "Alarm",
    new AlarmOccurrence({
      occurrenceId: `ghost-${n}`,
      purpose: "note.due",
      alarmId: `ghost-${n}`,
      armSeq: 1,
      sourceKey: "ghost",
      payload: "{}",
      fireAt: 1,
    }),
  );

/** Exactly what the replier carries: the union over the four session RPCs. */
type ReplySuccess = Entity.Replier.Success<SessionRpcs>;
type ReplyError = Rpc.Error<SessionRpcs> | Cause.Cause<Rpc.Error<SessionRpcs>>;
type ReplyExit = Exit.Exit<ReplySuccess, Rpc.Error<SessionRpcs>>;

/** Instantiates the replier's per-RPC generic at its constraint: the four-RPC union. */
const widen = <R extends SessionRpcs>(
  exit: Exit.Exit<Entity.Replier.Success<R>, Rpc.Error<R>>,
): ReplyExit => exit as Exit.Exit<Entity.Replier.Success<SessionRpcs>, Rpc.Error<SessionRpcs>>;

interface Reply {
  readonly tag: string;
  readonly exit: ReplyExit;
}

interface WriterWorld {
  readonly handle: ActivationHandle;
  readonly queue: Queue.Queue<SessionRequest>;
  readonly replier: SessionReplier;
  readonly replies: Queue.Queue<Reply>;
  readonly failures: Queue.Queue<{ readonly tag: string; readonly error: ReplyError }>;
  readonly kernel: SessionKernel;
}

/**
 * One real activation handle (stores + kernel + adopted fence) without the
 * cluster host; the writer loop is driven directly over an envelope queue.
 */
function makeWriterWorld(
  sessionId: string,
  options?: {
    readonly alarmsBeforePrompt?: number;
    readonly wrapKernel?: (kernel: SessionKernel) => SessionKernel;
    readonly runTurn?: SessionEntityPorts["runTurn"];
    readonly alarmCapability?: AlarmCapability;
  },
): Effect.Effect<WriterWorld, never, import("effect").Scope.Scope> {
  return Effect.gen(function* () {
    const catalog = openCatalogStore(catalogFile, { now: () => 1 });
    const store = openSessionStore(sessionFileFor(sessionsDir, sessionId), { now: () => 1 });
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        store.close();
        catalog.close();
      }),
    );
    const baseKernel = SessionHandleStore.createSessionKernel(store, catalog);
    yield* baseKernel.materialize({
      id: sessionId,
      parentId: null,
      role: "resident",
      tools: [],
      system: { preset: "", blocks: [] },
      policyGeneration: 1,
      actionId: `${sessionId}:materialize`,
      at: 1,
    }).pipe(Effect.orDie);
    catalog.indexSession({ id: sessionId, parentId: null, role: "resident", createdAt: 1 });
    const fence = catalog.rotateFence(sessionId);
    yield* baseKernel.adoptFence({ sessionId, owner: "unit-writer", fence }).pipe(Effect.orDie);
    const kernel = options?.wrapKernel === undefined ? baseKernel : options.wrapKernel(baseKernel);
    const scope = yield* Effect.scope;
    const gate = yield* Semaphore.make(1);
    const handle: ActivationHandle = {
      env: {
        owner: "unit-writer",
        clock: () => 1_000,
        catalog,
        openSession: () => store,
        ports: {
          approvalPolicy: TEST_APPROVAL_POLICY,
          runTurn: options?.runTurn ?? makeTurnPort(resolvedRunner("ok"), false, () => 1_000),
          // #1310: admission refuses a snapshot with no declared kinds.
          capabilityKinds: ["tool", "compaction"],
          // #1313: deliver refuses an unbound inputRegistrations port.
          inputRegistrations: ["prompt", "signal"],
          ...(options?.alarmCapability === undefined ? {} : { alarmCapability: options.alarmCapability }),
        },
      },
      kernel,
      authority: { sessionId, owner: "unit-writer", fence },
      drain: {
        alarmsBeforePrompt: options?.alarmsBeforePrompt ?? 4,
        maxArmed: 64,
        idleMs: 60_000,
        sweep: { full: false, idleDays: 7 },
      },
      scope,
      gate,
      live: { current: undefined },
      closing: { current: false },
      keepAlive: () => Effect.void,
    };
    const queue = yield* Queue.make<SessionRequest>();
    const replies = yield* Queue.make<Reply>();
    const failures = yield* Queue.make<{ readonly tag: string; readonly error: ReplyError }>();
    const replier: SessionReplier = {
      succeed: (request, value) =>
        Queue.offer(replies, { tag: request.tag, exit: widen(Exit.succeed(value)) }).pipe(Effect.asVoid),
      complete: (request, exit) =>
        Queue.offer(replies, { tag: request.tag, exit: widen(exit) }).pipe(Effect.asVoid),
      fail: (request, error) =>
        Queue.offer(failures, { tag: request.tag, error: error as Rpc.Error<SessionRpcs> }).pipe(Effect.asVoid),
      failCause: (request, cause) =>
        Queue.offer(failures, { tag: request.tag, error: cause as Cause.Cause<Rpc.Error<SessionRpcs>> }).pipe(Effect.asVoid),
    };
    return { handle, queue, replier, replies, failures, kernel: baseKernel };
  });
}

const takeN = <A>(queue: Queue.Queue<A>, n: number): Effect.Effect<A[]> =>
  Effect.forEach(Array.from({ length: n }, (_, index) => index), () => Queue.take(queue).pipe(Effect.orDie));

/** One committed capability arm row: the occurrence the chain guard admits. */
function commitArmedRow(world: WriterWorld, sessionId: string, alarmId: string) {
  const minted = armAction({
    parentId: null,
    sessionId,
    purpose: "note.due",
    at: 1,
    supersedes: null,
    alarmId,
    sourceKey: "note",
    payload: { note: alarmId },
    armSeq: 1,
    ts: 1,
  });
  return world.kernel
    .commit({
      sessionId,
      owner: "unit-writer",
      fence: world.handle.authority.fence,
      now: 1,
      expectedRevision: world.kernel.row(sessionId).revision,
      actions: [minted.action],
      state: "idle",
    })
    .pipe(Effect.orDie, Effect.as(minted));
}

const armedOccurrence = (sessionId: string, minted: ReturnType<typeof armAction>): SessionRequest =>
  envelope(
    sessionId,
    "Alarm",
    new AlarmOccurrence({
      occurrenceId: minted.occurrenceId,
      purpose: "note.due",
      alarmId: minted.action.id.split(":arm:")[0] ?? "",
      armSeq: 1,
      sourceKey: "note",
      payload: JSON.stringify({ note: "armed" }),
      fireAt: 1,
    }),
  );

test("an admitted occurrence with no capability composed folds to a recorded fired{stale}", () =>
  runAgent(Effect.scoped(Effect.gen(function* () {
    const sessionId = "writer-no-capability";
    const world = yield* makeWriterWorld(sessionId);
    const minted = yield* commitArmedRow(world, sessionId, "due-off");
    yield* Queue.offer(world.queue, armedOccurrence(sessionId, minted));
    const fiber = yield* Effect.forkIn(writerLoop(world.handle, world.queue, world.replier), world.handle.scope);
    const [reply] = yield* takeN(world.replies, 1);
    if (reply === undefined || !Exit.isSuccess(reply.exit)) throw new Error("expected a success exit");
    expect(reply.exit.value).toEqual({ outcome: "stale" });
    expect(world.kernel.actionById(`${minted.occurrenceId}:stale`)?.kind).toBe("alarm");
    expect(world.kernel.actionById(`${minted.occurrenceId}:delivered`)).toBeUndefined();
    yield* Fiber.interrupt(fiber);
  }))));

test("a typed AlarmWakeError from the capability folds the occurrence to fired{stale}", () =>
  runAgent(Effect.scoped(Effect.gen(function* () {
    const sessionId = "writer-wake-error";
    const wakes: string[] = [];
    const world = yield* makeWriterWorld(sessionId, {
      alarmCapability: {
        purposes: ["note.due"],
        wake: (fired) =>
          Effect.suspend(() => {
            wakes.push(fired.occurrenceId);
            return Effect.fail(new AlarmWakeError({ purpose: fired.purpose, reason: "injected" }));
          }),
      },
    });
    const minted = yield* commitArmedRow(world, sessionId, "due-fail");
    yield* Queue.offer(world.queue, armedOccurrence(sessionId, minted));
    const fiber = yield* Effect.forkIn(writerLoop(world.handle, world.queue, world.replier), world.handle.scope);
    const [reply] = yield* takeN(world.replies, 1);
    if (reply === undefined || !Exit.isSuccess(reply.exit)) throw new Error("expected a success exit");
    // The handler ran exactly once; its typed failure is a recorded stale fact.
    expect(wakes).toEqual([minted.occurrenceId]);
    expect(reply.exit.value).toEqual({ outcome: "stale" });
    expect(world.kernel.actionById(`${minted.occurrenceId}:stale`)?.kind).toBe("alarm");
    expect(world.kernel.actionById(`${minted.occurrenceId}:delivered`)).toBeUndefined();
    yield* Fiber.interrupt(fiber);
  }))));

test("one writer fiber serves envelopes strictly in arrival order", () =>
  runAgent(Effect.scoped(Effect.gen(function* () {
    const sessionId = "writer-order";
    const world = yield* makeWriterWorld(sessionId);
    yield* Queue.offerAll(world.queue, [
      promptEnvelope(sessionId, "p1"),
      promptEnvelope(sessionId, "p2"),
      staleAlarmEnvelope(sessionId, 1),
    ]);
    const fiber = yield* Effect.forkIn(writerLoop(world.handle, world.queue, world.replier), world.handle.scope);
    const replies = yield* takeN(world.replies, 3);
    expect(replies.map((reply) => reply.tag)).toEqual(["Deliver", "Deliver", "Alarm"]);
    expect(replies.every((reply) => Exit.isSuccess(reply.exit))).toBe(true);
    // The chain ordinals prove serialization: p1's append precedes p2's.
    const p1 = world.kernel.actionById("p1");
    const p2 = world.kernel.actionById("p2");
    if (p1 === undefined || p2 === undefined) throw new Error("appends missing");
    expect(p1.ordinal).toBeLessThan(p2.ordinal);
    yield* Fiber.interrupt(fiber);
  }))));

test("D3: the alarm budget yields the head to a queued prompt, then serves the deferred alarm", () =>
  runAgent(Effect.scoped(Effect.gen(function* () {
    const sessionId = "writer-d3";
    const world = yield* makeWriterWorld(sessionId, { alarmsBeforePrompt: 2 });
    yield* Queue.offerAll(world.queue, [
      staleAlarmEnvelope(sessionId, 1),
      staleAlarmEnvelope(sessionId, 2),
      staleAlarmEnvelope(sessionId, 3),
      promptEnvelope(sessionId, "p1"),
    ]);
    const fiber = yield* Effect.forkIn(writerLoop(world.handle, world.queue, world.replier), world.handle.scope);
    const replies = yield* takeN(world.replies, 4);
    // Two alarms spend the budget; the queued prompt preempts the third.
    expect(replies.map((reply) => reply.tag)).toEqual(["Alarm", "Alarm", "Deliver", "Alarm"]);
    const promptRow = world.kernel.actionById("p1");
    const deferredFold = world.kernel.actionById("ghost-3:stale");
    if (promptRow === undefined || deferredFold === undefined) throw new Error("appends missing");
    expect(promptRow.ordinal).toBeLessThan(deferredFold.ordinal);
    yield* Fiber.interrupt(fiber);
  }))));

test("a lost revision CAS retries exactly 3 times, then AdmissionFailure{revision}", () =>
  runAgent(Effect.scoped(Effect.gen(function* () {
    const sessionId = "writer-revision";
    let attempts = 0;
    const world = yield* makeWriterWorld(sessionId, {
      wrapKernel: (kernel) => ({
        ...kernel,
        commit: (input) =>
          Effect.suspend(() => {
            attempts += 1;
            return Effect.fail(
              new CommitRefused({
                sessionId,
                reason: "revision",
                expectedRevision: input.expectedRevision,
                currentRevision: input.expectedRevision + 1,
                fence: input.fence,
                currentFence: input.fence,
              }),
            );
          }),
      }),
    });
    yield* Queue.offer(world.queue, promptEnvelope(sessionId, "p1"));
    const fiber = yield* Effect.forkIn(writerLoop(world.handle, world.queue, world.replier), world.handle.scope);
    const [reply] = yield* takeN(world.replies, 1);
    if (reply === undefined || !Exit.isFailure(reply.exit)) throw new Error("expected a failed exit");
    expect(attempts).toBe(3);
    const failure = Exit.isFailure(reply.exit) ? reply.exit.cause : undefined;
    expect(JSON.stringify(failure)).toContain('"code":"revision"');
    expect(world.kernel.actionById("p1")).toBeUndefined();
    yield* Fiber.interrupt(fiber);
  }))));

test("interruption fails every queued envelope with AdmissionFailure{shutdown}", () =>
  runAgent(Effect.scoped(Effect.gen(function* () {
    const sessionId = "writer-shutdown";
    const entered = yield* Deferred.make<void>();
    const world = yield* makeWriterWorld(sessionId, {
      // The writer blocks inside the first turn; later envelopes stay queued.
      runTurn: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
    });
    yield* Queue.offer(world.queue, promptEnvelope(sessionId, "p1"));
    const fiber = yield* Effect.forkIn(writerLoop(world.handle, world.queue, world.replier), world.handle.scope);
    yield* Deferred.await(entered);
    yield* Queue.offerAll(world.queue, [
      promptEnvelope(sessionId, "p2"),
      staleAlarmEnvelope(sessionId, 9),
      envelope(sessionId, "Resolve", {
        requestId: "req-shutdown",
        outcome: "cancelled",
        payload: JSON.stringify({ actorId: "owner", kind: "human" }),
        inputId: "req-shutdown:input",
      }),
      envelope(sessionId, "Read", { model: "history", cursor: 0 }),
    ]);
    yield* Fiber.interrupt(fiber);
    const failed = yield* takeN(world.failures, 4);
    expect(failed.map((entry) => entry.tag).sort()).toEqual(["Alarm", "Deliver", "Read", "Resolve"]);
    for (const entry of failed) {
      expect(entry.error).toBeInstanceOf(AdmissionFailure);
      if (entry.error instanceof AdmissionFailure) expect(entry.error.code).toBe("shutdown");
    }
    // p1 was mid-serve (not queued): it is redelivery's problem, not a reply.
    expect(yield* Queue.size(world.replies)).toBe(0);
  }))));
