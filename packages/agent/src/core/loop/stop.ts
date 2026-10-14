import { Effect } from "effect";

import { canonicalDigest, type LedgerAction, type PlainValue } from "@openomni/protocol";

import { type ExecutionError, AgentFailure } from "../ports/failure";

import type { PolicyEvaluation } from "../gate/compile";

import { turnStopAction } from "../journal/turn-rows";

import type { ResolvedExecutorOptions } from "./invocation";



export interface StopObservation {
  readonly text: string;
  readonly toolCalls: number;
  readonly calls?: readonly { readonly tool: string; readonly input: PlainValue }[];
  readonly continueRequested?: boolean;
  readonly interrupted: boolean;
  readonly exhausted: boolean;
  readonly progress: boolean;
  readonly blocked: boolean;
  readonly openIntent: readonly string[];
  readonly alarmIds: readonly string[];
}

export interface StopState {
  readonly outputHash?: string;
  readonly repetition: number;
  readonly stall: number;
  readonly blocked: number;
  readonly continuation: number;
}

export type StopMetric = "exact_repeat" | "toolless_stall" | "blocked_recurrence" | "continuation";

export type StopVerdict =
  | { readonly kind: "interrupted"; readonly reason: "abort" }
  | { readonly kind: "result"; readonly reason: "completion" }
  | { readonly kind: "waiting"; readonly reason: "live_wait"; readonly alarmIds: readonly string[] }
  | { readonly kind: "continue"; readonly reason: "continue" }
  | { readonly kind: "error"; readonly reason: "budget" | StopMetric };

export function stopState(): StopState {
  return { repetition: 0, stall: 0, blocked: 0, continuation: 0 };
}

function advanceStopState(previous: StopState, observation: StopObservation): StopState {
  const outputHash = canonicalDigest({
    text: observation.text,
    calls: observation.calls ?? [],
  });
  return {
    outputHash,
    repetition: observation.progress
      ? 0
      : outputHash === previous.outputHash ? previous.repetition + 1 : 1,
    stall: observation.progress || observation.toolCalls > 0 ? 0 : previous.stall + 1,
    blocked: observation.blocked && !observation.progress ? previous.blocked + 1 : 0,
    // This is the per-invocation step budget, independent of progress and repeat detection.
    continuation: previous.continuation + 1,
  };
}

function completionEligible(observation: StopObservation): boolean {
  return observation.text.length > 0 && observation.toolCalls === 0 && !observation.continueRequested;
}

/** Invocation is not effect/state progress. */
function judgeStop<E, R>(
  previous: StopState,
  observation: StopObservation,
  limit: (metric: StopMetric) => Effect.Effect<number, E, R>,
  completion: () => Effect.Effect<boolean, E, R>,
): Effect.Effect<{ state: StopState; verdict: StopVerdict }, E, R> {
  return Effect.gen(function* () {
  const state = advanceStopState(previous, observation);
  const done = (verdict: StopVerdict) => ({ state, verdict });
  if (observation.interrupted) return done({ kind: "interrupted", reason: "abort" });
  if (observation.exhausted) return done({ kind: "error", reason: "budget" });
  if (completionEligible(observation)) {
    const permitted = yield* completion();
    if (permitted && observation.openIntent.length === 0 && !observation.blocked)
      return done({ kind: "result", reason: "completion" });
  }
  if (state.repetition >= (yield* limit("exact_repeat")))
    return done({ kind: "error", reason: "exact_repeat" });
  if (state.stall >= (yield* limit("toolless_stall")))
    return done({ kind: "error", reason: "toolless_stall" });
  if (state.blocked >= (yield* limit("blocked_recurrence")))
    return done({ kind: "error", reason: "blocked_recurrence" });
  if (observation.alarmIds.length > 0)
    return done({ kind: "waiting", reason: "live_wait", alarmIds: observation.alarmIds });
  if (state.continuation >= (yield* limit("continuation")))
    return done({ kind: "error", reason: "continuation" });
  return done({ kind: "continue", reason: "continue" });
  });
}

export function createStopJudge(
  options: ResolvedExecutorOptions,
  decide: (op: string, value: PlainValue) => Effect.Effect<PolicyEvaluation, ExecutionError>,
  commit: (action: LedgerAction.Append) => Effect.Effect<LedgerAction.Receipt, ExecutionError>,
) {
  return (state: StopState, observation: StopObservation) => Effect.gen(function* () {
    function limit(metric: StopMetric): Effect.Effect<number, ExecutionError> {
      return Effect.gen(function* () {
      const op = metric === "continuation" ? "continue" : metric;
      const decision = yield* decide(op, { metric });
      const rows = decision.obligations.filter(
        (row) => row.ref === "kernel/budget-clamp" && row.metric === metric,
      );
      const row = rows[0];
      if (
        decision.verdict === "deny" ||
        decision.verdict === "require_approval" ||
        decision.verdict === "transform" ||
        decision.generation !== options.policy.generation ||
        rows.length !== 1 ||
        row === undefined ||
        row.limit <= 0 ||
        !Number.isInteger(row.limit)
      )
        return yield* new AgentFailure({ operation: "stop.policy", cause: `invalid_stop_policy:${metric}` });
      return row.limit;
      });
    }
    const result = yield* judgeStop(state, observation, limit, () => Effect.gen(function* () {
      const completion = yield* decide("completion", {
        text: observation.text,
        openIntent: [...observation.openIntent],
      });
      return completion.verdict === "allow";
    }));
    yield* commit(turnStopAction({
      id: options.entropy(),
      sessionId: options.identity.sessionId,
      parentId: options.identity.parentActionId,
      generation: options.policy.generation,
      verdict:
        result.verdict.kind === "waiting"
          ? { kind: "waiting", reason: "live_wait", alarmIds: [...result.verdict.alarmIds] }
          : { ...result.verdict },
      state: { ...result.state },
      ts: options.clock(),
    }));
    return result;
  });
}
