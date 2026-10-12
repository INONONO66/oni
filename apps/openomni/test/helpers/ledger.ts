import { Core } from "@openomni/agent";
const adoptSessionAuthority = Core.adoptSessionAuthority;
const decideSessionAdmission = Core.decideSessionAdmission;
const Entropy = Core.Entropy;
const AgentFailure = Core.AgentFailure;
const GenerationLayers = Core.GenerationLayers;
const ObservationSink = Core.ObservationSink;
type SessionEntryServices = Core.SessionEntryServices;
type SessionError = Core.SessionError;
type SessionRuntime = Core.SessionRuntime;
type LedgerError = Core.LedgerError;
import type { ObservationSink as ObservationSinkPort, SessionTurn } from "@openomni/protocol";
import { Clock, Context, Effect, type Scope } from "effect";
import {
  AppLedger,
  type AppLedgerPlane,
  reportObservationPublishFailure,
  type SessionKernel,
  withChannelStores,
} from "../../src/composition/cluster-runtime";
import { ComposedGeneration } from "../../src/composition/composed";
import { localDeliveryCommit } from "../../src/process-entry";
import type { AppRuntime } from "../../src/runtime";
import { runRuntimeEffect } from "./effect";
import { testClock } from "./test-entropy";

export interface AppLedgerOptions {
  readonly now: () => number;
  /** Catalog SQLite file; absent = an in-memory catalog. */
  readonly catalogPath?: string;
  /** Directory of per-session ledger files; absent = in-memory session stores. */
  readonly sessionsDir?: string;
  readonly observationSink?: ObservationSinkPort;
  readonly onObservationFailure?: Core.ObservationFailurePort;
}

/**
 * The app plane without the cluster host (the shape `appLedgerLayer` builds
 * over `Core.Ledger`, with the app's incident log as the failure port),
 * opened synchronously; the fixture owns `close`.
 */
export function createAppLedger(options: AppLedgerOptions): AppLedgerPlane {
  return withChannelStores(
    Core.openLedgerPlane({
      now: options.now,
      ...(options.catalogPath === undefined ? {} : { catalog: { path: options.catalogPath } }),
      ...(options.sessionsDir === undefined ? {} : { sessions: { dir: options.sessionsDir } }),
      ...(options.observationSink === undefined ? {} : { observationSink: options.observationSink }),
      onObservationFailure: options.onObservationFailure ?? reportObservationPublishFailure,
    }),
    options.now,
  );
}

/** A standalone app ledger plane for fixtures that never boot the runtime. */
export function testPlane(options: Partial<AppLedgerOptions> = {}): AppLedgerPlane {
  return createAppLedger({ ...options, now: options.now ?? testClock() });
}

/** The booted runtime's own plane — the one the entity and boot share. */
export function planeOf(runtime: AppRuntime): Promise<AppLedgerPlane> {
  return runRuntimeEffect(runtime, Effect.map(AppLedger, (plane) => plane));
}

/** Strictly-newer fence adoption on a fixture kernel (the entity's own CAS). */
export function adoptTestFence(
  kernel: SessionKernel,
  sessionId: string,
  owner: string,
): Effect.Effect<number, LedgerError> {
  return adoptSessionAuthority(kernel, sessionId, owner);
}

/**
 * A cluster-free delivery commit for fixtures: the process child's own local
 * delivery (src/process-entry.ts), bound to a fixture plane and owner.
 */
export function localDelivery(
  plane: AppLedgerPlane,
  owner = "test-delivery",
  clock: () => number = () => Date.now(),
) {
  return localDeliveryCommit(plane, owner, clock);
}

export type ResolvedTestRuntime = Core.ResolvedSessionRuntime;

/** The app's runtime resolution, replayed for fixtures over a built service context. */
export function resolvedRuntimeFor(
  runtime: SessionRuntime,
  context: Context.Context<SessionEntryServices>,
): ResolvedTestRuntime {
  return {
    ...runtime,
    clock: Context.get(context, Clock.Clock).currentTimeMillisUnsafe,
    entropy: Context.get(context, Entropy).id,
    observations: Context.get(context, ObservationSink),
    generations: Context.get(context, GenerationLayers),
    services: context,
  };
}

/**
 * The entity's backlog drain, minus the mailbox (mirrors the process child):
 * adopt the fence once, then run admitted decisions until the chain says
 * stop. Returns the latest turn terminal the drain settled.
 */
export function drainSession(deps: {
  readonly plane: AppLedgerPlane;
  readonly sessionId: string;
  readonly runner: Core.SessionRunner;
  readonly runtime: ResolvedTestRuntime;
  readonly scope: Scope.Scope;
  readonly owner?: string;
}): Effect.Effect<SessionTurn.Terminal | undefined, SessionError | LedgerError, ComposedGeneration> {
  const owner = deps.owner ?? "test-drain";
  const kernel = deps.plane.openKernel(deps.sessionId);
  const runTurn = deps.plane.turnPort(deps.runner, deps.runtime, deps.scope);
  return Effect.gen(function* () {
    // Admission refuses a snapshot with no declared kinds; the drain states
    // the composed generation's kinds like the process child does.
    const composed = yield* ComposedGeneration;
    const fence = yield* adoptTestFence(kernel, deps.sessionId, owner);
    const authority = { sessionId: deps.sessionId, owner, fence };
    for (;;) {
      const row = kernel.row(deps.sessionId);
      const open = kernel.latestOpenTurn(deps.sessionId);
      const terminal = kernel.latestTurnTerminal(deps.sessionId);
      const snapshot = {
        row,
        pending: kernel.pendingMessages(deps.sessionId),
        ...(open === undefined ? {} : { open }),
        ...(terminal === undefined ? {} : { terminal }),
        capabilityKinds: Object.keys(composed.current().generation.kinds),
      };
      const decision = decideSessionAdmission(snapshot);
      switch (decision.kind) {
        case "stop":
          return kernel.latestTurnTerminal(deps.sessionId)?.effect;
        case "refused":
          return yield* new AgentFailure({ operation: "session.admission", cause: "invalid_state" });
        case "consume":
          // The consume fold is entity-owned; a fixture reaching it is a
          // wiring defect, not backlog to silently drop.
          return yield* new AgentFailure({ operation: "session.admission", cause: "consume_in_fixture" });
        case "start":
          // Inline detach: this drain owns the whole turn's lifetime itself.
          yield* runTurn({ authority, kernel, decision: { kind: "start" }, snapshot, detach: (body) => body });
          continue;
        default:
          yield* runTurn({ authority, kernel, decision, snapshot, detach: (body) => body });
          continue;
      }
    }
  });
}
