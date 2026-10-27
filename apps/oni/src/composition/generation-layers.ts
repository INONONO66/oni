import { Core, Bundle } from "@oni/agent";
const Entropy = Core.Entropy;
type Entropy = Core.Entropy;
const AgentFailure = Core.AgentFailure;
const GenerationLayers = Core.GenerationLayers;
const GenerationUnavailable = Core.GenerationUnavailable;
const GenerationHandlers = Bundle.GenerationHandlers;
const ObservationSink = Core.ObservationSink;
type ObservationSink = Core.ObservationSink;
const SessionLayer = Core.SessionLayer;
const ToolCatalog = Core.ToolCatalog;
const makeObservationBus = Core.makeObservationBus;
const makeSessionGenerations = Core.makeSessionGenerations;
const scopeObservation = Core.scopeObservation;
type GenerationBundle = Core.GenerationBundle;
type SessionError = Core.SessionError;
type SessionRuntimeOptions = Core.SessionRuntimeOptions;

import { LedgerAction, type AnyToolDefinition, type LedgerSession, type PlainValue, type SessionGeneration } from "@oni/protocol";
import { type Clock, Context, Effect, Layer, Option, Scope, Semaphore } from "effect";

import { catalogDelegationReads, delegationGuardHandlers } from "../bundles/delegation-policy/index";
import { AppLedger, type SessionReadModel } from "./cluster-runtime";
import { ComposedGeneration, type ComposedContext } from "./composed";
import { AppPointTable } from "./point-table";
import { captureNow } from "./platform";

/**
 * The live `GenerationHandlers` for one composed generation (#1255 P3): the
 * kernel's built-in handlers plus every handler the generation's capabilities
 * and bundles registered. A handler with an `apply` function is a transformer;
 * anything else is an obligation marker. Kernel names win a collision — the
 * generation's `kernel/*` registrations are declarations of intent to use
 * them, not replacements.
 */
function composedPolicyRegistry(
  generation: Bundle.Generation,
  consultants: readonly Core.NamedConsultant[],
  live: Readonly<Record<string, { decide: Core.NamedGuard["decide"] }>> = {},
): Core.HandlerTable {
  const transformers = [...Core.KERNEL_POLICY_REGISTRY.transformers];
  const obligations = [...Core.KERNEL_POLICY_REGISTRY.obligations];
  const known = new Set(
    [...transformers, ...obligations, ...consultants].map((entry) => entry.name),
  );
  const guards = [...(Core.KERNEL_POLICY_REGISTRY.guards ?? [])];
  // #1258: a bundle contract's guard face is a declaration; the composition
  // binds the live doors here (catalog reads), like catalog tool ports. They
  // register unconditionally so a persisted consult row always compiles — the
  // row itself only exists while its bundle is composed on.
  for (const [name, guard] of Object.entries(live)) {
    if (known.has(name)) continue;
    known.add(name);
    guards.push({ name, decide: guard.decide });
  }
  for (const [name, handler] of generation.handlers) {
    if (known.has(name)) continue;
    known.add(name);
    if ("apply" in handler && typeof handler.apply === "function")
      transformers.push({ name, apply: handler.apply as Core.NamedTransformer["apply"] });
    else if ("decide" in handler && typeof handler.decide === "function")
      // A consulted gate guard (#1258): the handler decides per input.
      guards.push({ name, decide: handler.decide as Core.NamedGuard["decide"] });
    else obligations.push({ name });
  }
  return { transformers, obligations, consultants, guards };
}

/**
 * The Effect Clock hook consult deadlines run on when a composition injects
 * one (#1256 r5 H-2): tests mount a TestClock here so a hook call's timeout
 * advances deterministically. Absent, deadlines ride the fiber's own clock.
 */
export class HookConsultClock extends Context.Service<HookConsultClock, Clock.Clock>()(
  "@oni/oni/HookConsultClock",
) {}

/**
 * The generation's asynchronous consultants (#1256 r2 H-1): each registered
 * `ConsultantHandler` (the hook capability's `hook/process`) acquires inside
 * the generation Layer's Scope — the PID lifetime — with the rows that name
 * it. A factory failure (e.g. a hook command that cannot spawn) is the typed
 * candidate failure that refuses the generation.
 */
function acquireConsultants(
  generation: Bundle.Generation,
  ports: Pick<Bundle.ConsultantSeed, "late" | "cursor" | "clock">,
): Effect.Effect<readonly Core.NamedConsultant[], Core.SessionError, Scope.Scope> {
  return Effect.gen(function* () {
    const consultants: Core.NamedConsultant[] = [];
    for (const [name, handler] of generation.handlers) {
      if (!Bundle.isConsultantHandler(handler)) continue;
      const rows = generation.rows.filter((row) => row.how.ref === name);
      const consult = yield* handler
        .consultant({ name, rows, ...ports })
        .pipe(
          Effect.mapError(
            (cause) => new AgentFailure({ operation: "generation.consultant", cause: String(cause) }),
          ),
        );
      consultants.push({ name, consult });
    }
    return consultants;
  });
}

/**
 * The app's per-boot generation inputs. The core port still carries per-role
 * tool arrays; every app tool is bundle-owned (#1561), so they must be empty
 * and `initialize` refuses anything else.
 */
export interface GenerationDefinitions extends Readonly<Record<LedgerSession.Role, readonly AnyToolDefinition[]>> {
  /**
   * #1256 H-3: the late-result door. A hook payload that settles AFTER its
   * call timed out re-enters THIS session through the entity `deliver` path
   * as an `action` row; absent means late results are dropped.
   */
  readonly deliverLate?: (sessionId: string, payload: PlainValue, after: number | undefined) => void;
}

/**
 * The composed ON bundles' Layers over the seed, in composition order, each
 * provided the seed plus every earlier bundle's outputs. A bundle Layer fails
 * only with the typed `SessionError` its contract declares (`Bundle.BundleLayer`);
 * a defect stays a defect.
 */
function bundleLayerStack<E>(
  context: ComposedContext,
  seed: Layer.Layer<Core.BundleLayerServices, E>,
): Layer.Layer<Core.BundleLayerServices, E | Core.SessionError> {
  let stack: Layer.Layer<Core.BundleLayerServices, E | Core.SessionError> = seed;
  for (const name of context.generation.bundles) {
    const layer = context.manifest.bundles.find((bundle) => bundle.name === name)?.layer;
    if (layer === undefined) continue;
    stack = layer.pipe(Layer.provideMerge(stack));
  }
  return stack;
}

/** The app owns construction; the package manager alone owns acquired contexts. */
export const GenerationLayersLive = Layer.effect(GenerationLayers, Effect.gen(function* () {
  const scope = yield* Effect.scope;
  const plane = yield* AppLedger;
  const pointTable = yield* AppPointTable;
  const composed = yield* ComposedGeneration;
  const process = yield* Effect.context<Entropy | ObservationSink>();
  const root = Context.get(process, ObservationSink);
  const entropy = Context.get(process, Entropy);
  const now = yield* captureNow;
  const lock = yield* Semaphore.make(1);
  const managers = new Map<string, Effect.Success<ReturnType<typeof makeSessionGenerations>>>();
  let definitions: Pick<GenerationDefinitions, "deliverLate"> | undefined;
  let stopping = false;

  function bundle(sessionId: string, snapshot: SessionGeneration.Snapshot): Effect.Effect<GenerationBundle, SessionError> {
    return Effect.gen(function* () {
      if (definitions === undefined) return yield* new AgentFailure({ operation: "generation.initialize", cause: "not_initialized" });
      const generation = composed.current().generation;
      const role = plane.read.session(sessionId).row(sessionId).role;
      const offered = new Set(snapshot.tools.map((tool) => tool.name));
      // #1561: every tool is bundle-owned. Compose already refused two bundles
      // declaring one name (typed `duplicate`), so the generation's tool table
      // is the whole catalog; the snapshot's journaled faces pick this session's.
      const source = definitions;
      const catalog = Layer.sync(ToolCatalog, () => ({
        definitions: Core.filterLoadout(generation.tools, offered, role),
      }));
      let active = false;
      // One PubSub bus per generation (#1249): built in the generation Layer's
      // Scope, whose closure shuts the PubSub down and interrupts every
      // subscriber drain; the finalizer gates publishes off first.
      const observations = Layer.effect(ObservationSink, Effect.gen(function* () {
        const bus = yield* makeObservationBus({ id: entropy.id, now });
        yield* Effect.addFinalizer(() => Effect.sync(() => { active = false; }));
        const sink: Context.Service.Shape<typeof ObservationSink> = {
          publish: (event, data) => { if (active) { bus.sink.publish(event, data); root.publish(event, data); } },
          subscribe: bus.sink.subscribe,
          scope: (identity) => scopeObservation(sink, identity, { id: entropy.id, now }),
        };
        return sink;
      }));
      const seed = Layer.mergeAll(Layer.succeedContext(process), catalog, observations);
      // #1256 r2 H-1: consultants (the hook PIDs) acquire in THIS generation
      // Layer's Scope; rotation drains and kills them with the generation.
      const seeded = Layer.effect(
        GenerationHandlers,
        Effect.gen(function* () {
          // #1256 H-3: the consultant seed's session-scoped ports — the
          // journal-head cursor captured at call time and the late door.
          const late = source.deliverLate;
          const consultClock = yield* Effect.serviceOption(HookConsultClock);
          const consultants = yield* acquireConsultants(generation, {
            cursor: () => plane.read.session(sessionId).latestAction(sessionId)?.ordinal ?? 0,
            ...(Option.isSome(consultClock) ? { clock: consultClock.value } : {}),
            ...(late === undefined
              ? {}
              : {
                  late: (payload: PlainValue) => {
                    const after =
                      payload !== null && typeof payload === "object" && !Array.isArray(payload) && typeof payload.after === "number"
                        ? payload.after
                        : undefined;
                    late(sessionId, payload, after);
                  },
                }),
          });
          return composedPolicyRegistry(generation, consultants, delegationGuardHandlers(catalogDelegationReads(
            plane.read.sessions.list,
            // #1258 M-4: a child is active while work is in flight — an open
            // turn or an undelivered input, both durable journal facts.
            (childId) => {
              const kernel = plane.read.session(childId);
              return kernel.latestOpenTurn(childId) !== undefined ||
                kernel.pendingMessages(childId).length > 0;
            },
          )));
        }),
      ).pipe(Layer.provideMerge(seed));
      // #1255 P3: the composed ON bundles' Layers acquire INSIDE this
      // generation's Scope in composition order, each provided the seed plus
      // every earlier bundle's outputs — the per-generation resource semantics
      // the deleted runtime bundle plane carried. Acquisition failure is the
      // typed candidate failure `configure`/`capture` unwinds on.
      const registry = bundleLayerStack(composed.current(), seeded);
      const layer = Layer.unwrap(Effect.gen(function* () {
        const registry = yield* GenerationHandlers;
        const policy = yield* Effect.try({
          try: () => Core.bind(Core.compile({ rows: plane.read.session(sessionId).policyRows(snapshot.policyGeneration), generation: snapshot.policyGeneration, kinds: LedgerAction.Kind.options, table: pointTable }, registry)),
          catch: String,
        }).pipe(Effect.mapError((cause) => new AgentFailure({ operation: "generation.policy", cause })));
        return Layer.succeed(SessionLayer, { snapshot, policy });
      })).pipe(Layer.provideMerge(registry));
      return { id: { sessionId, generation: snapshot.generation }, snapshot, layer, activate: Effect.sync(() => { active = true; }) };
    });
  }

  // Draining refuses the same way the core's generation manager does once
  // its own drain began: `GenerationUnavailable`, which the session drain
  // reads as "defer, the committed row stays pending" rather than a defect.
  function manager(id: SessionGeneration.Id) {
    return lock.withPermits(1)(Effect.gen(function* () {
      if (stopping) return yield* new GenerationUnavailable({ generation: id.generation });
      let owner = managers.get(id.sessionId);
      if (owner === undefined) {
        const initial = yield* bundle(id.sessionId, plane.read.session(id.sessionId).latestGenerationFor(id.sessionId));
        owner = yield* makeSessionGenerations(initial).pipe(Scope.provide(scope));
        managers.set(id.sessionId, owner);
      }
      return owner;
    }));
  }

  return {
    initialize: (input: GenerationDefinitions) => Effect.suspend(() => {
      if (definitions !== undefined) return Effect.fail(new AgentFailure({ operation: "generation.initialize", cause: "already_initialized" }));
      if (input.resident.length > 0 || input.child.length > 0)
        return Effect.fail(new AgentFailure({ operation: "generation.initialize", cause: "tools_are_bundle_owned" }));
      definitions = Object.freeze({ deliverLate: input.deliverLate });
      return Effect.void;
    }),
    capture: (id: SessionGeneration.Id) => Effect.gen(function* () {
      const owner = yield* manager(id);
      const snapshot = plane.read.session(id.sessionId).generationFor(id.sessionId, id.generation);
      if (snapshot === undefined) return yield* new GenerationUnavailable({ generation: id.generation });
      return yield* owner.capture(yield* bundle(id.sessionId, snapshot));
    }),
    configure: <A>(id: SessionGeneration.Id, snapshot: SessionGeneration.Snapshot, commit: Effect.Effect<A, SessionError>) => Effect.gen(function* () {
      if (id.generation !== snapshot.generation) return yield* new AgentFailure({ operation: "generation.configure", cause: "snapshot_identity_mismatch" });
      const owner = yield* manager(id);
      return yield* owner.configure(yield* bundle(id.sessionId, snapshot), commit);
    }),
    settle: Effect.suspend(() =>
      Effect.forEach([...managers.values()], (owner) => owner.settle, { discard: true }),
    ),
    drain: lock.withPermits(1)(Effect.gen(function* () {
      stopping = true;
      yield* Effect.forEach(managers.values(), (owner) => owner.drain, { discard: true });
    })),
  };
}));

/**
 * The app's `session.configure` authority: evaluate the session's captured
 * generation Layer's pinned pre-policy. Deny (or any non-allow verdict) fails
 * closed; there is no callback fallback.
 */
export function configureAuthority(
  generations: Context.Service.Shape<typeof GenerationLayers>,
  readSession: (sessionId: string) => SessionReadModel,
): SessionRuntimeOptions["authorizeConfigure"] {
  return (input) => Effect.scoped(Effect.gen(function* () {
    const captured = yield* generations.capture({
      sessionId: input.sessionId,
      generation: readSession(input.sessionId).latestGenerationFor(input.sessionId).generation,
    });
    const { policy } = yield* captured.provide(SessionLayer);
    const evaluationInput = {
      kind: "session.configure", phase: "pre" as const, op: input.operation,
      role: input.role, sessionId: input.sessionId,
      value: { op: input.operation, generation: input.generation },
    };
    // #1256 r2: session.open hook rows consult asynchronously; a snapshot
    // without the effectful path evaluates synchronously as before.
    const evaluated = policy.evaluateEffect === undefined
      ? policy.evaluate(evaluationInput)
      : yield* policy.evaluateEffect(evaluationInput);
    return evaluated.verdict === "allow";
  }));
}
