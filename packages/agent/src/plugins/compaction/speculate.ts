import { Deferred, Effect, Exit, Fiber } from "effect";
import { isWarmCandidateValid, latestCompactionAnchorId, planAnchoredCut } from "./candidate";
import { prepareSummarizerInput } from "./estimate";
import { withSummarizerDeadline } from "./summary";
import type { CompactionOptions } from "./compact";

// #1307: the candidate shape is a seam type (the kernel passes it through
// dispatch); the core owns it and this module re-exports the old name.
export type { CompactionCandidate } from "../../core/api";
import type { CompactionCandidate, CompactionSessionConfig, CompactionSessionPort } from "../../core/api";

const MAX_PREPARE_FAILURES = 2;

/** Speculation is a child of the owning run Scope, never a detached Promise. */
export class CompactionSession implements CompactionSessionPort {
  readonly #protectRecentMessages: number;
  readonly #summarize: NonNullable<CompactionOptions["onSummarize"]>;
  #candidate: CompactionCandidate | undefined;
  #inFlight = false;
  #failureStreak = 0;
  #generation = 0;
  #preparation: Fiber.Fiber<void, never> | undefined;
  /** Resolved once a preparation has entered its summarizer call; resolved before any prepare. */
  #entered = Deferred.makeUnsafe<void>();

  constructor(config: CompactionSessionConfig) {
    this.#protectRecentMessages = config.protectRecentMessages;
    this.#summarize = withSummarizerDeadline(config.summarize, config.summarizerDeadlineMs);
    Deferred.doneUnsafe(this.#entered, Exit.void);
  }

  prepare: CompactionSessionPort["prepare"] = (messages, contextTokens, prepareTokens, contextWindowTokens, onFailure) => {
    return Effect.suspend(() => {
      if (this.#failureStreak >= MAX_PREPARE_FAILURES) return Effect.void;
      if (this.#candidate !== undefined && !isWarmCandidateValid(this.#candidate, messages))
        this.#candidate = undefined;
      if (this.#inFlight || this.#candidate !== undefined || contextTokens < prepareTokens)
        return Effect.void;
      const plan = planAnchoredCut(messages, this.#protectRecentMessages);
      const firstKept = messages[plan?.prefixIds.length ?? -1];
      if (plan === undefined || plan.summarizerInput.length === 0 || firstKept === undefined)
        return Effect.void;
      const prepared = prepareSummarizerInput(plan.summarizerInput, contextWindowTokens, plan.previousAnchor);
      if (prepared.messages.length === 0) return Effect.void;
      this.#inFlight = true;
      // A preparation aborted before its summarizer call leaves `#entered` unresolved; the waiters it
      // collected are owed the next entry, so a fresh Deferred is allotted only after the previous one resolved.
      const entered = Deferred.isDoneUnsafe(this.#entered) ? Deferred.makeUnsafe<void>() : this.#entered;
      this.#entered = entered;
      const generation = this.#generation;
      const work = Effect.suspend(() => {
        Deferred.doneUnsafe(entered, Exit.void);
        return this.#summarize(prepared.messages, plan.previousAnchor, prepared.budget);
      }).pipe(
        Effect.match({
          onSuccess: (summary) => {
            if (generation !== this.#generation) return;
            this.#failureStreak = 0;
            this.#candidate = summary.trim().length === 0 ? undefined : {
              prefixIds: plan.prefixIds,
              prefixFingerprint: plan.prefixFingerprint,
              firstKeptId: firstKept.info.id,
              compactionAnchorId: latestCompactionAnchorId(messages),
              anchorBody: summary,
            };
          },
          onFailure: (error) => {
            if (generation !== this.#generation) return;
            this.#candidate = undefined;
            this.#failureStreak += 1;
            onFailure?.(error, this.#failureStreak);
          },
        }),
        Effect.ensuring(Effect.sync(() => {
          if (generation === this.#generation) this.#inFlight = false;
        })),
      );
      return Effect.forkScoped(work).pipe(Effect.tap((fiber) => Effect.sync(() => {
        this.#preparation = fiber;
      })), Effect.asVoid);
    });
  };

  candidate(): CompactionCandidate | undefined { return this.#candidate; }
  inFlight(): boolean { return this.#inFlight; }
  consume(): void { this.#candidate = undefined; }

  disable(): Effect.Effect<void> {
    return Effect.suspend(() => {
      this.#failureStreak = MAX_PREPARE_FAILURES;
      return this.abort();
    });
  }

  /**
   * Run-settle abort. v3 flushed the scheduler queue at every async
   * resumption, so a preparation forked before the run's last async boundary
   * always entered (its summarizer call was issued, then aborted) before the
   * run's finalizer ran. v4 resumes fibers directly, bypassing the dispatcher
   * queue, so grant the one start tick v3 guaranteed before interrupting.
   * Direct abort() stays tick-free: v3 never started a fork that was aborted
   * in the same synchronous continuation.
   */
  settleAbort(): Effect.Effect<void> {
    return Effect.yieldNow.pipe(Effect.andThen(this.abort()));
  }

  abort(): Effect.Effect<void> {
    return Effect.suspend(() => {
      this.#generation += 1;
      this.#candidate = undefined;
      this.#inFlight = false;
      return this.#preparation === undefined ? Effect.void : Fiber.interrupt(this.#preparation).pipe(Effect.asVoid);
    });
  }

  started(): Effect.Effect<void> {
    return Effect.suspend(() => Deferred.await(this.#entered));
  }

  settled(): Effect.Effect<void> {
    return Effect.suspend(() => this.#preparation === undefined ? Effect.void : Fiber.join(this.#preparation));
  }
}
