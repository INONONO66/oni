import { Effect } from "effect";
import { classifyFailure, retryAfterMs } from "../classify";
import { type LlmError, ModelUnavailable } from "../errors";
import { run, type Run, type RunInput } from "../run";
import type { Sink } from "../sink";
import { runCandidate, type RoutingCall } from "./candidate";
import { candidates, type ChainRow, parseRows } from "./chain";
import * as Circuit from "./circuit";
import type { CredentialSlot } from "./credentials";
import { decide, type RoutingFact } from "./decide";
import { order } from "./pin";

interface RouterOptions {
  readonly chains?: readonly ChainRow[];
  readonly credentials?: readonly CredentialSlot[];
}

function tryCandidate(call: RoutingCall, selector: string): Effect.Effect<Run.Outcome | undefined, LlmError> {
  const { circuits } = call.state;
  const leased = Circuit.lease(circuits.get(selector) ?? Circuit.closed, call.input.now());
  if (leased === undefined) {
    call.facts.push({ candidate: selector, action: "skip_circuit" });
    return Effect.succeed(undefined);
  }
  circuits.set(selector, leased);
  return runCandidate(call, selector).pipe(
    Effect.catch((error: LlmError) => {
      const failure = classifyFailure({ error, now: call.input.now() });
      const decision = decide(failure, "pre_request", retryAfterMs(error, call.input.now));
      if (decision.action !== "swap_model" && decision.action !== "swap_credential") return Effect.fail(error);
      call.facts.push({ candidate: selector, failure, action: "swap_model" });
      circuits.set(selector, Circuit.open(leased, call.input.now()));
      return Effect.succeed(undefined);
    }),
    Effect.ensuring(Effect.sync(() => {
      const state = circuits.get(selector) ?? Circuit.closed;
      circuits.set(selector, { ...state, halfOpenLeased: false });
    })),
  );
}

export function createRouter(binding: RoutingCall["binding"], options: RouterOptions = {}) {
  const rows = parseRows(options.chains ?? []);
  const state: RoutingCall["state"] = {
    circuits: new Map(), credentials: new Map(), pins: new Map(), streaks: new Map(),
  };
  return function route(input: RunInput, sink: Sink, dependencies?: Parameters<typeof run>[2]): Effect.Effect<Run.Outcome, LlmError> {
    const primary = `${input.model.providerID}/${input.model.id}`;
    const chain = candidates(rows, primary, input.routing?.category);
    if (!chain.configured) return run({ ...input, authFilePath: binding.authFilePath }, sink, dependencies);
    return Effect.gen(function* () {
      const facts: RoutingFact[] = [];
      const call: RoutingCall = {
        input, sink, dependencies, binding, state, facts, primary,
        slots: options.credentials ?? [], billingPin: false,
        turn: input.routing?.turn ?? input.trace.runId,
        previous: state.pins.get(input.trace.sessionId),
        routing: (selected) => ({
          category: chain.category, requested: primary, attempts: [...facts],
          ...(selected === undefined ? {} : { selected }),
        }),
      };
      for (const selector of order(chain.selectors, call.previous, call)) {
        if (input.signal?.aborted) return { type: "aborted", routing: call.routing() };
        const outcome = yield* tryCandidate(call, selector);
        if (outcome !== undefined) return outcome;
      }
      return yield* new ModelUnavailable({
        category: chain.category, nearestFallback: chain.nearestFallback,
        openUntil: Math.min(...chain.selectors.map((selector) => state.circuits.get(selector)?.openUntil ?? input.now())),
        routing: call.routing(),
      });
    });
  };
}
