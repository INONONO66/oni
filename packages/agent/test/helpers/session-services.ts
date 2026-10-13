import { LlmLive } from "../../src/model";
import { createPolicyCompiler, KERNEL_POLICY_REGISTRY } from "../../src/core/gate/compile";
import { canonicalDigest, Delivery, LedgerAction, SessionTransition, type LedgerSession, type ObservationSink as ObservationPort, type SessionGeneration } from "@openomni/protocol";
import { Clock, type Context, Effect, Layer, Scope, Semaphore } from "effect";
import { GenerationHandlers } from "../../src/core/compose";
import type { SessionKernel } from "../../src/core/entity";
import { GenerationUnavailable, type SessionError } from "../../src/core/failure";
import { AgentGenerationLive } from "./generation-layer";
import { makeSessionGenerations, type GenerationBundle } from "../../src/core/run";
import type { SessionRuntime } from "../../src/core/run";
import { Entropy, GenerationLayers, ObservationSink, type SessionEntryServices } from "../../src/core/ports";
import { isolatedLedger } from "./isolated";
import { fixtureCompactionSeam } from "./fixture-compaction";
import { observationService } from "./service-layers";
import { entropySource, fixedClock } from "./time";
import type { SessionRunnerResult } from "../../src/core/run";

/**
 * Seam stub for `SessionRuntime.settleChild`: core fixtures exercise the settlement SEAM only. The shipped
 * delegation-policy fold lives in apps/openomni/src/bundles/delegation-policy and is tested from
 * apps/openomni/test; this stub answers the last parent-origin input with a minimal settled reply and never
 * claims to mirror the shipped policy.
 */
function fixtureSettleChild(
  kernel: SessionKernel,
  row: LedgerSession.Row,
  terminal: LedgerAction.Append,
  result: SessionRunnerResult,
): SessionTransition.OutboundMessage | undefined {
  if (row.parentId === null || result.kind === "waiting") return undefined;
  const origin = kernel.inputMessages(row.id)
    .map((item) => Delivery.MessageOrigin.safeParse(item.origin.value))
    .flatMap((parsed) => parsed.success && parsed.data.senderSessionId === row.parentId ? [parsed.data] : [])
    .at(-1);
  if (origin === undefined) return undefined;
  const message = {
    messageId: `${terminal.id}:reply`,
    sourceSessionId: row.id,
    sourceActionId: terminal.id,
    destinationSessionId: row.parentId,
    requestId: origin.sourceActionId,
    replyTo: origin.replyTo ?? origin.messageId,
    terminal: result.kind === "result" ? ("completed" as const) : result.kind,
    content: result.text ?? "",
  };
  return SessionTransition.OutboundMessage.parse({ ...message, digest: canonicalDigest(message) });
}
import { TEST_APPROVAL_POLICY } from "./approval-policy";

/** Tests grant configure EXPLICITLY; production composition wires the real pinned pre-policy. */
export const allowConfigure: SessionRuntime["authorizeConfigure"] = () => Effect.succeed(true);

export interface SessionFixture extends SessionRuntime {
  readonly clock?: () => number;
  readonly entropy?: () => string;
  readonly observations: ObservationPort;
}

/** The kernel plane every fixture rides inside `isolated()`: the isolation's shared kernel, resolved lazily. */
export function isolatedRuntime(): Pick<SessionRuntime, "openKernel" | "listSessions" | "settleChild" | "approvalPolicy"> {
  return kernelRuntime(() => isolatedLedger().kernel);
}

/** The silent isolated session runtime at t=20 whose ids are `${prefix}-N` under process `processId`. */
export function silentRuntime(prefix: string, processId: string, extra: Partial<SessionFixture> = {}): SessionFixture {
  let sequence = 0;
  return {
    authorizeConfigure: allowConfigure,
    observations: { publish: () => undefined, subscribe: () => () => undefined },
    clock: () => 20,
    entropy: () => `${prefix}-${++sequence}`,
    processId,
    ...isolatedRuntime(),
    ...extra,
  };
}

/** Caps an effect at the suite-wide two-second deadline. */
export const boundedBy2s = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.timeout("2 seconds"));

/** A runtime kernel plane over one explicit kernel handle (crash children own their stores). */
export function kernelRuntime(kernel: () => SessionKernel): Pick<SessionRuntime, "openKernel" | "listSessions" | "settleChild" | "compaction" | "approvalPolicy"> {
  // Child settlements are composition-injected; fixtures ride a seam stub.
  // The compaction seam and the approval policy ride stubs too.
  return { openKernel: () => kernel(), listSessions: () => kernel().listRows(), settleChild: fixtureSettleChild, compaction: fixtureCompactionSeam, approvalPolicy: TEST_APPROVAL_POLICY };
}

const fixtures = new WeakMap<Scope.Scope, WeakMap<SessionFixture, Context.Context<SessionEntryServices>>>();

/** Test composition uses the real manager and durable snapshots, with no policy bypass. */
function sessionServices(fixture: SessionFixture) {
  return Effect.gen(function* () {
    const scope = yield* Effect.scope;
    let cache = fixtures.get(scope);
    if (cache === undefined) { cache = new WeakMap(); fixtures.set(scope, cache); }
    const cached = cache.get(fixture);
    if (cached !== undefined) return cached;
    const lock = yield* Semaphore.make(1);
    const managers = new Map<string, Effect.Success<ReturnType<typeof makeSessionGenerations>>>();
    const observations = observationService(fixture.observations);
    const compiler = createPolicyCompiler({ registry: KERNEL_POLICY_REGISTRY, kinds: LedgerAction.Kind.options,
      source: { rows: (generation?: number) => fixture.openKernel("policy").policyRows(generation) } });
    function bundle(sessionId: string, snapshot: SessionGeneration.Snapshot): GenerationBundle {
      return {
        id: { sessionId, generation: snapshot.generation }, snapshot, activate: Effect.void,
        layer: Layer.mergeAll(
          AgentGenerationLive({ snapshot, policy: compiler.pin(snapshot.policyGeneration), definitions: [] }),
          Layer.succeed(ObservationSink, observations), Layer.succeed(GenerationHandlers, KERNEL_POLICY_REGISTRY),
        ),
      };
    }
    function manager(sessionId: string) {
      return lock.withPermits(1)(Effect.gen(function* () {
        let value = managers.get(sessionId);
        if (value === undefined) {
          value = yield* makeSessionGenerations(bundle(sessionId, fixture.openKernel(sessionId).latestGenerationFor(sessionId))).pipe(Effect.provideService(Scope.Scope, scope));
          managers.set(sessionId, value);
        }
        return value;
      }));
    }
    const generations: Context.Service.Shape<typeof GenerationLayers> = {
      initialize: () => Effect.void,
      capture: (id: SessionGeneration.Id) => Effect.gen(function* () {
        const snapshot = fixture.openKernel(id.sessionId).generationFor(id.sessionId, id.generation);
        if (snapshot === undefined) return yield* new GenerationUnavailable({ generation: id.generation });
        const owner = yield* manager(id.sessionId);
        return yield* owner.capture(bundle(id.sessionId, snapshot));
      }),
      configure: <A>(id: SessionGeneration.Id, snapshot: SessionGeneration.Snapshot, commit: Effect.Effect<A, SessionError>) =>
        Effect.flatMap(manager(id.sessionId), (owner: Effect.Success<ReturnType<typeof makeSessionGenerations>>) => owner.configure(bundle(id.sessionId, snapshot), commit)),
      settle: Effect.suspend(() => Effect.forEach(managers.values(), (owner: Effect.Success<ReturnType<typeof makeSessionGenerations>>) => owner.settle, { discard: true })),
      drain: Effect.suspend(() => Effect.forEach(managers.values(), (owner: Effect.Success<ReturnType<typeof makeSessionGenerations>>) => owner.drain, { discard: true })),
    };
    const live = yield* Clock.clockWith(Effect.succeed);
    const context = yield* Layer.buildWithScope(Layer.mergeAll(
      LlmLive,
      Layer.succeed(Clock.Clock, fixture.clock === undefined ? live : fixedClock(fixture.clock)),
      Layer.succeed(Entropy, fixture.entropy === undefined ? entropySource("session") : { id: fixture.entropy, random: () => 0 }),
      Layer.succeed(ObservationSink, observations), Layer.succeed(GenerationLayers, generations),
    ), scope);
    cache.set(fixture, context);
    return context;
  });
}

export function withSessionServices<A, E, R>(work: Effect.Effect<A, E, R>, fixture: SessionFixture) {
  return Effect.flatMap(sessionServices(fixture), (context: Context.Context<SessionEntryServices>) => Effect.provide(work, context));
}
