import type { BusEvent, FoldCheckpoint } from "@openomni/protocol";
import { Actor, Operational } from "@openomni/protocol";
import type { AgentBudget, ResolvedAgentBudget } from "../ports/types";

export interface BudgetState {
  startTime: number;
  turns: number;
  toolCalls: number;
  toolRuntimeMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

export function createBudgetState(now: () => number): BudgetState {
  return {
    startTime: now(),
    turns: 0,
    toolCalls: 0,
    toolRuntimeMs: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
  };
}

/** A reactivated turn resumes its checkpointed counters; the wall slice is rebased so downtime is free. */
export function restoreBudgetState(checkpointed: FoldCheckpoint.BudgetState, now: () => number): BudgetState {
  return {
    startTime: now() - (checkpointed.chargedAt - checkpointed.startTime),
    turns: checkpointed.turns,
    toolCalls: checkpointed.toolCalls,
    toolRuntimeMs: checkpointed.toolRuntimeMs,
    totalInputTokens: checkpointed.totalInputTokens,
    totalOutputTokens: checkpointed.totalOutputTokens,
  };
}

export function effectiveBudgetThresholds(budget?: Actor.Profile.BudgetThresholdInput): {
  reassuranceThreshold: number;
  warningThreshold: number;
} {
  return {
    reassuranceThreshold:
      budget?.reassuranceThreshold ?? Actor.Profile.DEFAULT_REASSURANCE_THRESHOLD,
    warningThreshold: budget?.warningThreshold ?? Actor.Profile.DEFAULT_WARNING_THRESHOLD,
  };
}

type BudgetStatus = "ok" | "reassurance" | "warning" | "exceeded";

/** Explicit budget wins per field; unset fields read the policy's `defaultBudget`, no literal. */
export function resolveAgentBudget(
  defaults: ResolvedAgentBudget,
  explicit?: AgentBudget,
): ResolvedAgentBudget {
  return {
    ...explicit,
    maxTurns: explicit?.maxTurns ?? defaults.maxTurns,
    maxToolCalls: explicit?.maxToolCalls ?? defaults.maxToolCalls,
    maxWallTimeMs: explicit?.maxWallTimeMs ?? defaults.maxWallTimeMs,
    maxToolRuntimeMs: explicit?.maxToolRuntimeMs ?? defaults.maxToolRuntimeMs,
  };
}

type ExceededLimit = "wall time" | "turns" | "tool calls" | "tool wall time";

interface BudgetEvaluation {
  readonly status: BudgetStatus;
  readonly elapsedMs: number;
  readonly maxRatio: number;
  readonly exceededLimit?: ExceededLimit;
}

/** Exported because the turn's step cap subtracts from this exact pool (-1 = unlimited). */
export function effectiveMaxToolCalls(budget: ResolvedAgentBudget): number {
  return budget.maxToolCalls;
}

/** -1 = unlimited; shared with the wave-level enforcement. */
function effectiveMaxToolRuntimeMs(budget: ResolvedAgentBudget): number {
  return budget.maxToolRuntimeMs;
}

/** Reads the clock, mutates nothing, emits nothing. */
export function evaluateBudget(state: BudgetState, now: () => number, budget: ResolvedAgentBudget): BudgetEvaluation {
  const { warningThreshold: warningRatio, reassuranceThreshold: reassuranceRatio } =
    effectiveBudgetThresholds(budget);
  const elapsedMs = now() - state.startTime;
  const limits: readonly [ExceededLimit, number, number][] = [
    ["wall time", elapsedMs, budget.maxWallTimeMs],
    ["turns", state.turns, budget.maxTurns],
    ["tool calls", state.toolCalls, effectiveMaxToolCalls(budget)],
    ["tool wall time", state.toolRuntimeMs, effectiveMaxToolRuntimeMs(budget)],
  ];
  const ratios: number[] = [];
  for (const [exceededLimit, consumed, maximum] of limits) {
    if (maximum === -1) continue;
    if (consumed >= maximum) {
      return { status: "exceeded", elapsedMs, maxRatio: 1, exceededLimit };
    }
    ratios.push(consumed / maximum);
  }

  if (ratios.length === 0) return { status: "ok", elapsedMs, maxRatio: 0 };

  const maxRatio = Math.max(...ratios);
  if (maxRatio >= warningRatio) return { status: "warning", elapsedMs, maxRatio };
  if (maxRatio >= reassuranceRatio) return { status: "reassurance", elapsedMs, maxRatio };
  return { status: "ok", elapsedMs, maxRatio };
}

/** Invoked from the per-turn lifecycle check so the event fires once per turn, not per policy. */
export function publishBudgetTelemetry(
  state: BudgetState,
  run: { readonly traceId: string; readonly sessionId: string },
  events: BusEvent.Sink,
  now: () => number,
  budget: ResolvedAgentBudget,
): BudgetStatus {
  const evaluation = evaluateBudget(state, now, budget);

  if (evaluation.status === "exceeded") {
    events.publish(Operational.Events.Warn, {
      traceId: run.traceId,
      sessionId: run.sessionId,
      time: now(),
      component: "agent.budget",
      msg: `budget exceeded: ${evaluation.exceededLimit}`,
      context: {
        type: "exceeded",
        turns: state.turns,
        toolCalls: state.toolCalls,
        wallTimeMs: evaluation.elapsedMs,
        ...(evaluation.exceededLimit === "tool wall time"
          ? { toolRuntimeMs: state.toolRuntimeMs }
          : {}),
      },
    });
    return evaluation.status;
  }
  if (evaluation.status === "warning") {
    events.publish(Operational.Events.Warn, {
      traceId: run.traceId,
      sessionId: run.sessionId,
      time: now(),
      component: "agent.budget",
      msg: "budget threshold warning",
      context: {
        type: "warning",
        remaining: describeBudgetRemaining(state, now, budget),
        ratio: evaluation.maxRatio.toFixed(2),
      },
    });
    return evaluation.status;
  }
  if (evaluation.status === "reassurance") {
    events.publish(Operational.Events.Info, {
      traceId: run.traceId,
      sessionId: run.sessionId,
      time: now(),
      component: "agent.budget",
      msg: "budget threshold reassurance",
      context: {
        type: "reassurance",
        remaining: describeBudgetRemaining(state, now, budget),
        ratio: evaluation.maxRatio.toFixed(2),
      },
    });
  }
  return evaluation.status;
}

export function describeBudgetRemaining(state: BudgetState, now: () => number, budget: ResolvedAgentBudget): string {
  const parts: string[] = [];

  const maxTurns = budget.maxTurns;
  if (maxTurns === -1) {
    parts.push("unlimited turns remaining");
  } else {
    const remaining = maxTurns - state.turns;
    parts.push(`${remaining} turn${remaining !== 1 ? "s" : ""} remaining`);
  }

  const maxToolCalls = effectiveMaxToolCalls(budget);
  if (maxToolCalls !== -1) {
    const remaining = maxToolCalls - state.toolCalls;
    parts.push(`${remaining} tool call${remaining !== 1 ? "s" : ""} remaining`);
  }

  const maxWallTimeMs = budget.maxWallTimeMs;
  if (maxWallTimeMs !== -1) {
    const elapsed = now() - state.startTime;
    const remaining = Math.max(0, maxWallTimeMs - elapsed);
    parts.push(`${Math.round(remaining / 1000)}s wall time remaining`);
  }

  const maxToolRuntimeMs = effectiveMaxToolRuntimeMs(budget);
  if (maxToolRuntimeMs !== -1) {
    const remaining = Math.max(0, maxToolRuntimeMs - state.toolRuntimeMs);
    parts.push(`${Math.round(remaining / 1000)}s tool wall time remaining`);
  }

  return parts.join(", ");
}

export function recordTurn(state: BudgetState): BudgetState {
  return { ...state, turns: state.turns + 1 };
}

export function recordToolCall(state: BudgetState, durationMs: number): BudgetState {
  return {
    ...state,
    toolCalls: state.toolCalls + 1,
    toolRuntimeMs: state.toolRuntimeMs + durationMs,
  };
}

export function recordTokenUsage(
  state: BudgetState,
  inputTokens: number,
  outputTokens: number,
): BudgetState {
  return {
    ...state,
    totalInputTokens: state.totalInputTokens + inputTokens,
    totalOutputTokens: state.totalOutputTokens + outputTokens,
  };
}
