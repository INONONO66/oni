import { Effect, Result, Scope } from "effect";
import type { Message } from "@openomni/protocol";
import type {
  CompactionOutcome,
  CompactionPort,
  CompactionReason,
  CompactionRunBinding,
  CompactionWindow,
  Entropy,
  PinCompactionAction,
  PrepareCompactionRestore,
  RunState,
} from "../../core/api";
import { Compaction } from "./compact";
import {
  DEFAULT_PROTECT_RECENT,
  DEFAULT_TOOL_OUTPUT_ELISION,
  type CompactionCandidate,
  type CompactionExecutionOutcome,
  type CompactionGeometry,
  type CompactionSessionPort,
  type ResolvedCompactionOptions,
} from "./contract";
import { estimateMessagesTokens } from "./estimate";
import { executeCompaction } from "./execute-cut";
import { resolveCompactionGeometry } from "./geometry";
import { CompactionSession } from "./speculate";

interface RunPorts {
  readonly pinAction: PinCompactionAction;
  readonly prepareRestore: PrepareCompactionRestore;
}

/** Binds one run: the speculative session is a child of the run Scope and settles when it closes. */
export function bindCompactionRun(
  binding: CompactionRunBinding,
  ports: RunPorts,
): Effect.Effect<CompactionPort, never, Scope.Scope> {
  return Effect.gen(function* () {
    const session = createSession(binding);
    // Preparations fork into a child scope opened BEFORE the settle finalizer: finalizers
    // run newest-first, so the run settles (one start tick, interrupt, await) ahead of the
    // child's own fiber teardown instead of after it.
    const preparations = yield* Scope.fork(yield* Scope.Scope);
    if (session !== undefined) yield* Effect.addFinalizer(() => session.settleAbort());
    const run = new CompactionRun(binding, session);
    return {
      maybeCompact: (state, reason) =>
        run.maybeCompact(state, reason).pipe(Effect.provideService(Scope.Scope, preparations)),
      window: (state) => run.window(state),
      pinAction: ports.pinAction,
      prepareRestore: ports.prepareRestore,
    };
  });
}

function createSession(binding: CompactionRunBinding): CompactionSessionPort | undefined {
  const options = binding.options;
  if (options?.onSummarize === undefined || options.speculate === false) return undefined;
  return new CompactionSession({
    protectRecentMessages: options.protectRecentMessages ?? DEFAULT_PROTECT_RECENT,
    summarize: options.onSummarize,
    summarizerDeadlineMs: options.summarizerDeadlineMs,
  });
}

/** One run's policy; tests inject a session directly. */
export class CompactionRun {
  constructor(
    private readonly binding: CompactionRunBinding,
    private readonly session: CompactionSessionPort | undefined,
  ) {}

  /** Reads the real window even with no options bound: admission is a window fact, not a strategy. */
  window(state: RunState): CompactionWindow | undefined {
    const options = this.resolved(state) ?? this.windowOnly(state);
    if (options === undefined) return undefined;
    return {
      yieldAt: Math.floor(this.geometry(state, options).thresholdTokens),
      measure: estimateMessagesTokens,
    };
  }

  private windowOnly(state: RunState): ResolvedCompactionOptions | undefined {
    return state.contextWindowTokens === undefined ? undefined : { contextWindowTokens: state.contextWindowTokens };
  }

  maybeCompact(state: RunState, reason: CompactionReason): Effect.Effect<CompactionOutcome, never, Entropy | Scope.Scope> {
    const run = this;
    return Effect.gen(function* () {
      const options = run.resolved(state);
      if (options === undefined) return "skipped";
      const measuredTokens = state.lastCallContextTokens;
      const geometry = run.geometry(state, options);
      yield* run.prepare(state, options, geometry, measuredTokens);
      if (reason === "threshold" && run.belowThreshold(state, options, geometry, measuredTokens)) return "skipped";
      const candidate = run.session?.candidate();
      const executed = yield* Effect.result(executeCompaction({
        history: state.messages,
        options,
        identity: run.binding.identity,
        events: run.binding.events,
        executor: run.binding.executor,
        signal: run.binding.signal,
        dispatch: {
          trigger: reason === "threshold" ? "threshold" : "yield",
          ...(measuredTokens === undefined ? {} : { measuredTokens }),
          ...(candidate === undefined ? {} : { candidate }),
        },
      }));
      if (Result.isFailure(executed)) return { failed: executed.failure };
      yield* run.settle(state, executed.success, candidate);
      return "completed";
    });
  }

  /** Below the threshold, or still below grace while a speculative cut is in flight: wait for it. */
  private belowThreshold(
    state: RunState,
    options: ResolvedCompactionOptions,
    geometry: CompactionGeometry,
    measuredTokens: number | undefined,
  ): boolean {
    if (measuredTokens === undefined) return true;
    if (!Compaction.shouldCompact(measuredTokens, options, state.lastCompactionYield)) return true;
    return this.session?.inFlight() === true && measuredTokens < geometry.graceTokens;
  }

  private prepare(
    state: RunState,
    options: ResolvedCompactionOptions,
    geometry: CompactionGeometry,
    measuredTokens: number | undefined,
  ): Effect.Effect<void, never, Scope.Scope> {
    if (this.session === undefined || measuredTokens === undefined) return Effect.void;
    return this.session.prepare(state.messages, measuredTokens, geometry.prepareTokens, options.contextWindowTokens);
  }

  private settle(
    state: RunState,
    result: CompactionExecutionOutcome,
    candidate: CompactionCandidate | undefined,
  ): Effect.Effect<void> {
    const session = this.session;
    return Effect.gen(function* () {
      if (candidate !== undefined) session?.consume();
      state.lastCompactionIneffective = result.ineffective;
      if (result.yield !== undefined) state.lastCompactionYield = result.yield;
      if (result.summarizerFailed === true && session !== undefined) yield* session.disable();
      if (result.compacted) replaceRunMessages(state, result.messages);
    });
  }

  private resolved(state: RunState): ResolvedCompactionOptions | undefined {
    const options = this.binding.options;
    if (options === undefined) return undefined;
    const contextWindowTokens = options.contextWindowTokens ?? state.contextWindowTokens;
    if (contextWindowTokens === undefined) return undefined;
    return {
      elideToolOutputs: DEFAULT_TOOL_OUTPUT_ELISION,
      ...options,
      contextWindowTokens,
    };
  }

  private geometry(state: RunState, options: ResolvedCompactionOptions): CompactionGeometry {
    return resolveCompactionGeometry({
      contextWindowTokens: options.contextWindowTokens,
      ...(options.reserveTokens === undefined ? {} : { reserveTokens: options.reserveTokens }),
      ...(state.lastCompactionYield === undefined ? {} : { previousYield: state.lastCompactionYield }),
    });
  }
}

function replaceRunMessages(state: RunState, messages: Message.WithParts[]): void {
  state.messages = messages;
  // The measurement described the window this rewrite just changed; clearing it
  // stops the next check re-firing on a number about history that no longer exists.
  state.lastCallContextTokens = undefined;
  state.compactionCount += 1;
}
