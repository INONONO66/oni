import { type BusEvent, type TraceContext, Operational } from "@oni/protocol";
import { RunEvents } from "./run-events";
import type { AgentResult, TokenUsage } from "../ports/types";
import type { RetryReason, TerminalReason } from "../ports/reason-codes";
import type { RunState } from "../loop/state";

/** The runner builds one run identity from a trace it refused to mint; nothing else may. */
export interface AgentRunBase {
  readonly traceId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly actorId: string;
}

export function emitRunStarted(
  events: BusEvent.Sink,
  trace: TraceContext.Type,
  modelId: string,
  now: () => number,
): void {
  events.publish(Operational.Events.Info, {
    traceId: trace.traceId,
    time: now(),
    sessionId: trace.sessionId,
    component: "agent",
    msg: "agent.run.started",
    context: { model: modelId },
  });
}

export function emitTurnStart(
  events: BusEvent.Sink,
  state: RunState,
  agentBase: AgentRunBase,
  now: () => number,
): void {
  events.publish(RunEvents.TurnStart, {
    ...agentBase,
    time: now(),
    turnIndex: state.turnIndex,
  });
}

export function emitTurnComplete(
  events: BusEvent.Sink,
  state: RunState,
  agentBase: AgentRunBase,
  turnUsage: TokenUsage,
  now: () => number,
): void {
  events.publish(RunEvents.TurnComplete, {
    ...agentBase,
    time: now(),
    turnIndex: state.turnIndex,
    usage: {
      inputTokens: turnUsage.inputTokens,
      outputTokens: turnUsage.outputTokens,
      totalTokens: turnUsage.totalTokens,
    },
  });
}

export function emitRunCompleted(
  events: BusEvent.Sink,
  state: RunState,
  agentBase: AgentRunBase,
  finishReason: AgentResult["finishReason"],
  now: () => number,
): void {
  const time = now();
  events.publish(Operational.Events.Info, {
    traceId: agentBase.traceId,
    time,
    sessionId: agentBase.sessionId,
    component: "agent",
    msg: "agent.run.completed",
    context: {
      finishReason,
      turns: state.budgetState.turns,
      durationMs: time - state.startTime,
    },
  });
}

export function emitErrorRetry(
  events: BusEvent.Sink,
  agentBase: AgentRunBase,
  options: {
    readonly attempt: number;
    readonly maxAttempts: number;
    readonly error: string;
    readonly reason: RetryReason;
    readonly backoffMs: number;
  },
  now: () => number,
): void {
  events.publish(RunEvents.ErrorRetry, {
    ...agentBase,
    time: now(),
    attempt: options.attempt,
    maxAttempts: options.maxAttempts,
    error: options.error,
    reason: options.reason,
    backoffMs: options.backoffMs,
  });
}

/**
 * Carries `reason`/`maxAttempts` because on a first-attempt terminal failure no `ErrorRetry`
 * precedes this and the narrowed budget exists nowhere else.
 */
export function emitRunFailed(
  events: BusEvent.Sink,
  agentBase: AgentRunBase,
  error: string,
  decision: {
    readonly reason: TerminalReason;
    readonly attempt: number;
    readonly maxAttempts: number;
  },
  now: () => number,
): void {
  events.publish(Operational.Events.Error, {
    traceId: agentBase.traceId,
    time: now(),
    sessionId: agentBase.sessionId,
    component: "agent",
    msg: "agent.run.failed",
    error,
    context: { ...decision },
  });
}
