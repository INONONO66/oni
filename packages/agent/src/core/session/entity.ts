import * as SessionHandleStore from "../store/fence";
import { Effect, Queue, Semaphore } from "effect";
import { Entity, type Envelope, type Sharding } from "effect/cluster";
import { logRestoredHistory } from "./recovery";
import type { SessionEntityAuthority } from "./run";
import { AdmissionFailure, type AlarmRpc, type DeliverRpc, type ReadPage, type ReadRpc, type ResolveRpc } from "../journal/messages";
import type { AlarmDrainConfig } from "../ports/alarm";
import { renderReadModel } from "./read";
import { SessionEntity, SessionEntityContext, adoptFence, armResumeOnPassivation, entityArmVerb, resendArmedAlarms, rotateActivationFence, type ActivationHandle, type SessionReplier, type SessionRequest } from "./entity-activation";
import { deliver, drain, resolveCommand } from "./entity-delivery";
import { alarmOccurrence } from "./entity-alarm";

function readProjection(
  handle: ActivationHandle,
  payload: { readonly model: Parameters<typeof renderReadModel>[0]; readonly cursor: number },
): Effect.Effect<ReadPage> {
  const { kernel, authority } = handle;
  return Effect.sync(() => {
    const page = kernel.historyPage(authority.sessionId, { afterRevision: payload.cursor, limit: 256 });
    const actions = [...page.actions];
    if (payload.model === "metrics") {
      const parentIds = new Set<string>();
      for (const action of page.actions) {
        if (action.kind !== "llm" || action.parentId === null) continue;
        if (parentIds.has(action.parentId)) continue;
        parentIds.add(action.parentId);
        const parent = kernel.actionById(action.parentId);
        if (parent?.kind === "llm" && parent.ordinal <= payload.cursor) actions.push(parent);
      }
    }
    return {
      body: JSON.stringify(renderReadModel(payload.model, actions)),
      nextCursor: page.nextRevision,
    };
  });
}

const isPromptDeliver = (request: SessionRequest): boolean =>
  request.tag === "Deliver" &&
  (request as Envelope.Request<typeof DeliverRpc>).payload.kind === "prompt";

export function writerLoop(
  handle: ActivationHandle,
  queue: Queue.Dequeue<SessionRequest>,
  replier: SessionReplier,
): Effect.Effect<never> {
  const buffer: SessionRequest[] = [];
  let alarmsSincePrompt = 0;

  const next: Effect.Effect<SessionRequest> = Effect.suspend(() => {
    const head = buffer.shift();
    return head === undefined ? Queue.take(queue) : Effect.succeed(head);
  });
  const select: Effect.Effect<SessionRequest> = next.pipe(
    Effect.flatMap((request) => {
      if (request.tag !== "Alarm" || alarmsSincePrompt < handle.drain.alarmsBeforePrompt)
        return Effect.succeed(request);
      return Queue.clear(queue).pipe(
        Effect.map((flushed) => {
          buffer.push(...flushed);
          const promptIndex = buffer.findIndex(isPromptDeliver);
          if (promptIndex === -1) return request;
          const prompt = buffer[promptIndex] as SessionRequest;
          buffer.splice(promptIndex, 1);
          buffer.unshift(request);
          return prompt;
        }),
      );
    }),
  );

  const serve = (request: SessionRequest): Effect.Effect<void> => {
    switch (request.tag) {
      case "Deliver": {
        const req = request as Envelope.Request<typeof DeliverRpc>;
        if (req.payload.kind === "prompt") alarmsSincePrompt = 0;
        return deliver(handle, req.payload).pipe(
          Effect.exit,
          Effect.flatMap((exit) => replier.complete(req, exit)),
        );
      }
      case "Resolve": {
        const req = request as Envelope.Request<typeof ResolveRpc>;
        return resolveCommand(handle, req.payload).pipe(
          Effect.exit,
          Effect.flatMap((exit) => replier.complete(req, exit)),
        );
      }
      case "Alarm": {
        const req = request as Envelope.Request<typeof AlarmRpc>;
        alarmsSincePrompt += 1;
        return alarmOccurrence(handle, req.payload, () => { alarmsSincePrompt = 0; }).pipe(
          Effect.exit,
          Effect.flatMap((exit) => replier.complete(req, exit)),
        );
      }
      case "Read": {
        const req = request as Envelope.Request<typeof ReadRpc>;
        return Effect.forkIn(
          readProjection(handle, req.payload).pipe(
            Effect.exit,
            Effect.flatMap((exit) => replier.complete(req, exit)),
          ),
          handle.scope,
        ).pipe(Effect.asVoid);
      }
    }
  };

  const failShutdown = (request: SessionRequest): Effect.Effect<void> => {
    const failure = new AdmissionFailure({ code: "shutdown" });
    switch (request.tag) {
      case "Deliver":
        return replier.fail(request as Envelope.Request<typeof DeliverRpc>, failure);
      case "Resolve":
        return replier.fail(request as Envelope.Request<typeof ResolveRpc>, failure);
      case "Alarm":
        return replier.fail(request as Envelope.Request<typeof AlarmRpc>, failure);
      case "Read":
        return replier.fail(request as Envelope.Request<typeof ReadRpc>, failure);
    }
  };

  const drainOnClose = Effect.gen(function* () {
    handle.closing.current = true;
    const leftovers = [...buffer, ...(yield* Queue.clear(queue))];
    buffer.length = 0;
    yield* Effect.forEach(leftovers, failShutdown, { discard: true });
  });

  const loop = Effect.gen(function* () {
    for (;;) {
      const request = yield* select;
      yield* serve(request);
    }
  });

  return loop.pipe(Effect.ensuring(drainOnClose)) as Effect.Effect<never>;
}

export function createSessionEntityLayer(drainConfig: AlarmDrainConfig) {
  return SessionEntity.toLayerQueue(
    Effect.gen(function* () {
      const env = yield* SessionEntityContext;
      yield* env.ports.ready ?? Effect.void;
      const address = yield* Entity.CurrentAddress;
      const sessionId = address.entityId;
      const store = env.openSession(sessionId);
      yield* Effect.addFinalizer(() => Effect.sync(() => store.close()));
      const kernel = SessionHandleStore.createSessionKernel(store, env.catalog);
      const authority: SessionEntityAuthority = {
        sessionId,
        owner: env.owner,
        fence: rotateActivationFence(env, kernel, sessionId),
      };
      yield* adoptFence(kernel, authority).pipe(Effect.orDie);
      const scope = yield* Effect.scope;
      const gate = yield* Semaphore.make(1);
      const clusterServices = yield* Effect.context<Sharding.Sharding | Entity.CurrentAddress>();
      const makeClient = yield* SessionEntity.client;
      const client = makeClient(sessionId);
      const handle: ActivationHandle = {
        env,
        kernel,
        authority,
        drain: drainConfig,
        scope,
        gate,
        live: { current: undefined },
        closing: { current: false },
        keepAlive: (enabled) =>
          Effect.suspend(() => {
            env.ports.onKeepAlive?.(enabled);
            if (handle.closing.current) return Effect.void;
            return Entity.keepAlive(enabled).pipe(Effect.provideContext(clusterServices));
          }),
        resumeSend: (occurrence) =>
          client.Alarm(occurrence, { discard: true }).pipe(
            Effect.provideContext(clusterServices),
            Effect.catchCause((cause) =>
              Effect.logError(`resume occurrence send failed: ${sessionId}`, cause),
            ),
          ),
      };
      yield* Effect.addFinalizer(() => armResumeOnPassivation(handle));
      const releaseLive = env.ports.onLive?.(sessionId, {
        arm: entityArmVerb(handle),
        ownsTurn: (turnId) => kernel.latestOpenTurn(sessionId)?.turnId === turnId,
      });
      if (releaseLive !== undefined) yield* Effect.addFinalizer(() => Effect.sync(releaseLive));
      yield* logRestoredHistory(kernel, sessionId, env.clock);
      yield* resendArmedAlarms(handle);
      yield* drain(handle).pipe(Effect.orDie);
      return (queue: Queue.Dequeue<SessionRequest>, replier: SessionReplier) =>
        writerLoop(handle, queue, replier);
    }),
    { maxIdleTime: drainConfig.idleMs },
  );
}

export { type SessionKernel, type SessionEntityEnv, SessionEntityContext, SessionEntity, type ActivationHandle, retryRevision } from "./entity-activation";
export { createSessionEntityRunTurn } from "./entity-delivery";
