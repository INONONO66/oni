import { Effect, type Scope } from "effect";
import type { ExecutionError } from "./failure";
import type {
  CompactionCandidate,
  CompactionExecutionOutcome,
  CompactionSeamService,
  CompactionSessionPort,
  ResolvedCompactionOptions,
} from "./compaction-ports";
import type { ObservedChatAgentConfig as ChatAgentConfig } from "./types";
import type { Message } from "@openomni/protocol";
import type { AgentRunBase, RunState } from "./turn";
import type { Entropy } from "./ports";

type CompactionApplyResult = "compacted" | "deferred" | "none";

function resolvedCompaction(
  state: RunState,
  config: ChatAgentConfig,
): ResolvedCompactionOptions | undefined {
  if (config.compaction === undefined) return undefined;
  const contextWindowTokens = config.compaction.contextWindowTokens ?? state.contextWindowTokens;
  if (contextWindowTokens === undefined) return undefined;
  return { ...config.compaction, contextWindowTokens };
}

export function prepareCompactionAfterContinue(
  state: RunState,
  config: ChatAgentConfig,
  compaction: CompactionSessionPort | undefined,
): Effect.Effect<void, never, Scope.Scope> {
  return Effect.suspend(() => {
  const seam = config.compactionSeam;
  const options = resolvedCompaction(state, config);
  const measuredTokens = state.lastCallContextTokens;
  if (seam === undefined || options === undefined || measuredTokens === undefined || compaction === undefined)
    return Effect.void;
  const geometry = compactionGeometry(seam, state, options);
  return compaction.prepare(
    state.messages,
    measuredTokens,
    geometry.prepareTokens,
    options.contextWindowTokens,
  );
  });
}

function compactionGeometry(
  seam: CompactionSeamService,
  state: RunState,
  options: ResolvedCompactionOptions,
) {
  return seam.geometry({
    contextWindowTokens: options.contextWindowTokens,
    ...(options.reserveTokens === undefined ? {} : { reserveTokens: options.reserveTokens }),
    ...(state.lastCompactionYield === undefined
      ? {}
      : { previousYield: state.lastCompactionYield }),
  });
}

function deferCompaction(measuredTokens: number | undefined, compaction: CompactionSessionPort | undefined, graceTokens: number): boolean {
  return measuredTokens !== undefined && compaction?.inFlight() === true && measuredTokens < graceTokens;
}

function thresholdNotReached(
  seam: Pick<CompactionSeamService, "shouldCompact">,
  state: RunState,
  options: ResolvedCompactionOptions,
  measuredTokens: number | undefined,
): boolean {
  return (
    measuredTokens === undefined ||
    !seam.shouldCompact(measuredTokens, options, state.lastCompactionYield)
  );
}

function settleCompactionResult(
  state: RunState,
  compaction: CompactionSessionPort | undefined,
  result: CompactionExecutionOutcome,
  candidate: CompactionCandidate | undefined,
): Effect.Effect<CompactionApplyResult> {
  return Effect.gen(function* () {
    if (candidate !== undefined) compaction?.consume();
    state.lastCompactionIneffective = result.ineffective;
    if (result.yield !== undefined) state.lastCompactionYield = result.yield;
    if (result.summarizerFailed === true && compaction !== undefined) yield* compaction.disable();
    if (!result.compacted) return "none";
    applyCompactionMessages(state, result.messages);
    return "compacted";
  });
}

export function applyCompaction(
  state: RunState,
  config: ChatAgentConfig,
  agentBase: AgentRunBase,
  compaction: CompactionSessionPort | undefined,
  trigger: "threshold" | "yield",
): Effect.Effect<CompactionApplyResult, ExecutionError, Entropy> {
  return Effect.gen(function* () {
  // No seam = the capability is off: the kernel skips and records nothing new.
  const seam = config.compactionSeam;
  if (seam === undefined) return "none";
  const options = resolvedCompaction(state, config);
  if (options === undefined) return "none";
  const measuredTokens = state.lastCallContextTokens;
  const geometry = compactionGeometry(seam, state, options);
  if (trigger === "threshold" && thresholdNotReached(seam, state, options, measuredTokens))
    return "none";
  if (deferCompaction(measuredTokens, compaction, geometry.graceTokens)) return "deferred";

  const candidate = compaction?.candidate();
  const result = yield* seam.execute({
    history: state.messages,
    options,
    identity: agentBase,
    events: config.events,
    executor: config.executor,
    signal: config.signal,
    dispatch: {
      trigger,
      ...(measuredTokens === undefined ? {} : { measuredTokens }),
      ...(candidate === undefined ? {} : { candidate }),
    },
  });
  return yield* settleCompactionResult(state, compaction, result, candidate);
  });
}

function replaceRunMessages(state: RunState, messages: Message.WithParts[]): void {
  state.messages = messages;
  // The measurement described the window this rewrite just changed; clearing it
  // stops the next check re-firing on a number about history that no longer exists.
  state.lastCallContextTokens = undefined;
}

function applyCompactionMessages(state: RunState, messages: Message.WithParts[]): number {
  const messagesBefore = state.messages.length;
  replaceRunMessages(state, messages);
  state.compactionCount += 1;
  return messagesBefore;
}
