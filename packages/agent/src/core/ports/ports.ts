import { Context, Layer, Effect, type Scope } from "effect";
import { listenForAbort, type AnyToolDefinition, type ObservationSink as ObservationPort, type SessionGeneration } from "@oni/protocol";
import type { CompiledPolicySnapshot } from "../gate/compile";
import type { Llm } from "./llm";
import type { SessionError } from "./failure";
import type { GenerationHandlers } from "../composition/compose";
import type { GenerationRawSlots } from "../session/run";
import type { ToolDispatchDefinition } from "../loop/tool";
import type { LedgerPlane } from "../session/host";

/** Package code never reads ambient crypto or random sources itself. */
export interface EntropySource {
  readonly id: () => string;
  /** Uniform in `[0, 1)`. */
  readonly random: () => number;
}

export class Entropy extends Context.Service<Entropy, EntropySource>()("@oni/agent/Entropy") {
  static readonly layer = (source: EntropySource): Layer.Layer<Entropy> => Layer.succeed(Entropy, source);
}

/** Bounded, never "unbounded". */
export const BOUNDED_CONCURRENCY = 16;

/** Interrupting the waiter detaches the listener. */
export function onAbort<A, E = never>(signal: AbortSignal, outcome: Effect.Effect<A, E>): Effect.Effect<A, E> {
  return Effect.callback<A, E>((resume) => Effect.sync(listenForAbort(signal, () => resume(outcome))));
}

export function interruptOn(signal: AbortSignal): Effect.Effect<never> {
  return onAbort(signal, Effect.interrupt);
}

export type ProcessServices = Entropy | ObservationSink;
export type GenerationServices = SessionLayer | ToolCatalog | ObservationSink | GenerationHandlers;
/** Provided before any bundle layer acquires. */
export type BundleLayerServices = Entropy | ObservationSink | ToolCatalog | GenerationHandlers;
export type SessionEntryServices = ProcessServices | Llm | GenerationLayers;
export type RunnerServices = ProcessServices | SessionLayer | ToolCatalog | Llm | GenerationOwnership;

export interface CapturedGeneration {
  readonly id: SessionGeneration.Id;
  readonly snapshot: SessionGeneration.Snapshot;
  provide<A, E, R>(work: Effect.Effect<A, E, R>): Effect.Effect<A, E, Exclude<R, GenerationServices | GenerationRawSlots | GenerationOwnership>>;
  isSelected(): boolean;
  retain(): () => void;
}

export class GenerationOwnership extends Context.Service<GenerationOwnership, CapturedGeneration>()("@oni/agent/GenerationOwnership") {}

export interface GenerationLayersService {
  initialize(definitions: Readonly<Record<import("@oni/protocol").LedgerSession.Role, readonly AnyToolDefinition[]>>): Effect.Effect<void, SessionError>;
  capture(id: SessionGeneration.Id): Effect.Effect<CapturedGeneration, SessionError, Scope.Scope>;
  configure<A>(id: SessionGeneration.Id, snapshot: SessionGeneration.Snapshot, commit: Effect.Effect<A, SessionError>): Effect.Effect<A, SessionError>;
  readonly settle: Effect.Effect<void>;
  readonly drain: Effect.Effect<void, SessionError>;
}

export class GenerationLayers extends Context.Service<GenerationLayers, GenerationLayersService>()("@oni/agent/GenerationLayers") {}

export class ObservationSink extends Context.Service<
  ObservationSink,
  ObservationPort & Required<Pick<ObservationPort, "subscribe" | "scope">>
>()("@oni/agent/ObservationSink") {}

export class SessionLayer extends Context.Service<
  SessionLayer,
  { readonly snapshot: SessionGeneration.Snapshot; readonly policy: CompiledPolicySnapshot }
>()("@oni/agent/SessionLayer") {}

export class ToolCatalog extends Context.Service<
  ToolCatalog,
  { readonly definitions: readonly ToolDispatchDefinition[] }
>()("@oni/agent/ToolCatalog") {}

export class Ledger extends Context.Service<Ledger, LedgerPlane>()("@oni/agent/core/Ledger") {}
