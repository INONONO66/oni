import type { Effect } from "effect";
import type { LedgerAction } from "@openomni/protocol";
import type { CommitFailed } from "./failure";
import type { AlarmFired } from "./alarm";

/** Pure contracts the kernel takes without defaults; implementations live in `core/alarm.ts`. */

/**
 * `arm` commits the `alarm{arm}` chain row then forwards the occurrence; `wait` keeps the
 * in-process residual sleep; `settle` retires the chain so a completed attempt leaves no open
 * alarm.
 */
export interface RetryAlarmPort {
  arm(input: {
    /** The chain id is `<id>:retry`. */
    readonly id: string;
    readonly attempt: number;
    readonly reason: string;
    readonly fireAt: number;
  }): Effect.Effect<void, CommitFailed>;
  wait(fireAt: number, signal?: AbortSignal): Effect.Effect<void>;
  settle(input: {
    readonly id: string;
    readonly attempt: number;
  }): Effect.Effect<void, CommitFailed>;
}

export interface RetryAlarmDeps {
  readonly sessionId: string;
  readonly commitArm: (action: LedgerAction.Append) => Effect.Effect<void, CommitFailed>;
  /** Default void. */
  readonly send: (occurrence: AlarmFired) => Effect.Effect<void, CommitFailed>;
  readonly clock: () => number;
}
