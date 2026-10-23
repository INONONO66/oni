import type { Model } from "@oni/protocol";
import { Effect } from "effect";
import { Auth } from "../auth";
import { classifyFailure, retryAfterMs } from "../classify";
import type { LlmError } from "../errors";
import type { Provider } from "../provider";
import type { run, Run, RunInput } from "../run";
import type { Sink } from "../sink";
import { attempt } from "./attempt";
import { reference } from "./chain";
import * as Circuit from "./circuit";
import * as Credentials from "./credentials";
import { decide, type Decision, type RoutingFact, type RoutingFacts } from "./decide";
import { type Pin, touch } from "./pin";

export interface RoutingCall {
  readonly input: RunInput;
  readonly sink: Sink;
  readonly dependencies: Parameters<typeof run>[2];
  readonly binding: {
    readonly authFilePath: string;
    readonly resolveModel: (ref: Model.Ref, now: () => number) => Effect.Effect<Provider.Model, LlmError>;
  };
  readonly state: {
    readonly circuits: Map<string, Circuit.Circuit>;
    readonly credentials: Map<string, Credentials.CredentialState>;
    readonly pins: Map<string, Pin>;
    readonly streaks: Map<string, number>;
  };
  readonly facts: RoutingFact[];
  readonly primary: string;
  readonly turn: string;
  readonly previous: Pin | undefined;
  readonly slots: readonly Credentials.CredentialSlot[];
  readonly routing: (selected?: string) => RoutingFacts;
  billingPin: boolean;
}

type Slot = { readonly auth: Auth.Info; readonly key: string };
interface Candidate {
  readonly selector: string;
  readonly model: Provider.Model;
  readonly slots: readonly Slot[];
  transientSwaps: number;
  billingFailures: number;
  resetAt?: number;
  hintMs?: number;
}
type Result = Effect.Success<ReturnType<typeof attempt>>;
type Failed = Omit<Result, "outcome"> & {
  readonly outcome: Extract<Result["outcome"], { readonly type: "error" | "failure" }>;
};
type Step = Run.Outcome | { readonly type: "next_slot" | "next_model" };

function slots(call: RoutingCall, provider: string) {
  const configured = call.slots.filter((slot) => slot.provider === provider);
  if (configured.length > 0) return Effect.succeed(configured.map((slot) => slot.auth));
  const input = call.input;
  return Auth.resolve(provider, call.binding.authFilePath, input.auth,
    input.authProvider ?? input.model.providerID, input.allowAuthFallback).pipe(Effect.map((auth) => [auth]));
}

function open(call: RoutingCall, candidate: Candidate, hintMs?: number): void {
  const circuits = call.state.circuits;
  circuits.set(candidate.selector, Circuit.open(circuits.get(candidate.selector) ?? Circuit.closed, call.input.now(), {
    hintMs: hintMs ?? candidate.hintMs, resetAt: candidate.resetAt,
  }));
}

function block(call: RoutingCall, candidate: Candidate, failure: {
  readonly slot: Slot;
  readonly reason: NonNullable<Decision["block"]>;
  readonly hint?: number;
}): void {
  const state = Credentials.block(failure.reason, call.input.now(), failure.hint);
  call.state.credentials.set(failure.slot.key, state);
  if (failure.hint !== undefined) candidate.hintMs = Math.min(candidate.hintMs ?? Infinity, failure.hint);
  if (failure.reason === "transient") candidate.transientSwaps += 1;
  if (failure.reason !== "billing") return;
  if (failure.hint === undefined) candidate.billingFailures += 1;
  else candidate.resetAt = Math.min(candidate.resetAt ?? Infinity, state.blockedUntil);
}

function failureStep(call: RoutingCall, candidate: Candidate, settled: {
  readonly result: Failed;
  readonly slot: Slot;
  readonly started: number;
}): Effect.Effect<Step, LlmError> {
  const { result, slot, started } = settled;
  const { outcome, phase } = result;
  const error = outcome.error;
  const failure = classifyFailure({ error, now: call.input.now(), contextWindow: candidate.model.limit?.context });
  const instantServer = phase === "pre_request" && failure.kind === "retryable"
    && failure.providerReason === "server_error" && !failure.instant
    && failure.reason !== "timeout" && call.input.now() - started < 2000;
  const streak = instantServer ? (call.state.streaks.get(candidate.selector) ?? 0) + 1 : 0;
  call.state.streaks.set(candidate.selector, streak);
  const hint = "retryAfterMs" in error ? error.retryAfterMs : retryAfterMs(error, call.input.now);
  let decision = decide(failure, phase, hint);
  const remaining = candidate.slots.slice(candidate.slots.indexOf(slot) + 1);
  const sibling = remaining.some((entry) => Credentials.lease(call.state.credentials.get(entry.key) ?? Credentials.ready, call.input.now()) !== undefined);
  if (decision.block === "transient" && (candidate.transientSwaps > 0 || !sibling)) decision = { action: "surface" };
  call.facts.push({ candidate: candidate.selector, credential: slot.key, failure, action: decision.action });
  if (decision.pin !== undefined) call.state.pins.set(call.input.trace.sessionId, {
    primary: call.primary, candidate: candidate.selector, credential: slot.key, turn: call.turn, reason: decision.pin,
  });
  if (decision.action === "swap_credential" && decision.block !== undefined) {
    block(call, candidate, { slot, reason: decision.block, hint });
    return Effect.succeed({ type: "next_slot" });
  }
  if (decision.action === "swap_model") {
    open(call, candidate, hint);
    return Effect.succeed({ type: "next_model" });
  }
  if (streak >= 3) open(call, candidate, hint);
  result.flush();
  return outcome.type === "failure" ? Effect.fail(error) : Effect.succeed({
    ...outcome, routing: call.routing(phase === "streaming" ? candidate.selector : undefined),
  });
}

function runSlot(call: RoutingCall, candidate: Candidate, slot: Slot): Effect.Effect<Step, LlmError> {
  const { input, state } = call;
  const started = input.now();
  call.facts.push({ candidate: candidate.selector, credential: slot.key, action: "try" });
  // Transport and provider options belong to the original route, never a fallback.
  const { transport, providerOptions, ...base } = input;
  return attempt({
    ...base, model: candidate.model, auth: slot.auth, authProvider: candidate.model.providerID,
    ...(candidate.selector === call.primary ? { transport, providerOptions } : {}),
    authFilePath: call.binding.authFilePath,
  }, call.sink, { ...call.dependencies, onDelta: () => {
    state.circuits.set(candidate.selector, Circuit.closed);
    state.credentials.set(slot.key, Credentials.ready);
  } }).pipe(
    Effect.flatMap((result): Effect.Effect<Step, LlmError> => {
      const outcome = result.outcome;
      switch (outcome.type) {
        case "error":
        case "failure":
          return failureStep(call, candidate, { result: { ...result, outcome }, slot, started });
        case "aborted":
          call.facts.push({ candidate: candidate.selector, credential: slot.key, action: "abort" });
          result.flush();
          return Effect.succeed({ ...outcome, routing: call.routing() });
        case "stop":
        case "continue":
          state.credentials.set(slot.key, Credentials.ready);
          state.circuits.set(candidate.selector, Circuit.closed);
          state.streaks.delete(candidate.selector);
          state.pins.set(input.trace.sessionId, touch(call.previous, {
            primary: call.primary, candidate: candidate.selector, credential: slot.key, turn: call.turn,
            ...(call.billingPin ? { reason: "billing" } : {}),
          }));
          call.facts.push({ candidate: candidate.selector, credential: slot.key, action: "selected" });
          result.flush();
          return Effect.succeed({ ...outcome, routing: call.routing(candidate.selector) });
        default:
          return outcome satisfies never;
      }
    }),
    Effect.ensuring(Effect.sync(() => {
      const current = state.credentials.get(slot.key) ?? Credentials.ready;
      state.credentials.set(slot.key, { ...current, probing: false });
    })),
  );
}

export function runCandidate(call: RoutingCall, selector: string): Effect.Effect<Run.Outcome | undefined, LlmError> {
  return Effect.gen(function* () {
    const ref = reference(selector);
    const model = selector === call.primary ? call.input.model : yield* call.binding.resolveModel(ref, call.input.now);
    const auths = yield* slots(call, ref.provider);
    const preferred = call.previous?.candidate === selector ? call.previous.credential : undefined;
    const ordered = auths.map((auth) => ({ auth, key: `${ref.provider}:${Auth.reference(auth).fingerprint}` }));
    ordered.sort((a, b) => Number(b.key === preferred) - Number(a.key === preferred));
    const candidate: Candidate = { selector, model, slots: ordered, transientSwaps: 0, billingFailures: 0 };
    for (const slot of ordered) {
      const credential = Credentials.lease(call.state.credentials.get(slot.key) ?? Credentials.ready, call.input.now());
      if (credential === undefined) continue;
      call.state.credentials.set(slot.key, credential);
      const step = yield* runSlot(call, candidate, slot);
      switch (step.type) {
        case "next_model": return undefined;
        case "next_slot": break;
        default: return step;
      }
    }
    if (selector === call.primary && candidate.billingFailures === ordered.length) call.billingPin = true;
    open(call, candidate);
    call.facts.push({ candidate: selector, action: "swap_model" });
    return undefined;
  });
}
