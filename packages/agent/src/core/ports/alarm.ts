import { Effect, Schema } from "effect";
import { port } from "./capability";
import { interruptOn } from "./ports";
import { Alarm, canonicalJson, RESERVED_ALARM_PURPOSES, type LedgerAction, type PlainObject } from "@openomni/protocol";
import type { CommitFailed } from "./failure";
import type { AdmissionFailure, DeliverReceipt, DeliverRefused } from "../journal/messages";

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

/**
 * Timer plane over cluster DeliverAt (): a persisted timer message is
 * never cancelled in storage. Supersede = commit the winning `arm` row first;
 * a later delivery consults the chain through `alarmDisposition` and folds to
 * a recorded `fired{stale}` fact with zero execution.
 */

/** The four loop-reserved purposes, re-exported for the capability port. */
export const RESERVED_PURPOSES = RESERVED_ALARM_PURPOSES;

/** Why a delivered occurrence is skipped instead of run. */
export type AlarmSkipReason = "superseded" | "settled" | "unknown";

export type AlarmDisposition =
  | { readonly op: "run" }
  | { readonly op: "skip"; readonly reason: AlarmSkipReason };

/** The latest committed `arm` row view for one alarm chain. */
export interface AlarmArmView {
  readonly occurrenceId: string;
  /** Epoch ms, or null when the arm retired the chain. */
  readonly at: number | null;
}

/** Chain reads one alarm delivery decides over; the entity supplies its kernel's read ports. */
export interface AlarmChainReads {
  /** Latest `alarm{arm}` row for `alarmId`, or undefined when the chain has none. */
  latestArm(alarmId: string): AlarmArmView | undefined;
  /** True when a `fired{delivered|exhausted}` row exists for the occurrence. */
  settled(occurrenceId: string): boolean;
}

/**
 * The one chain guard (): an occurrence is fresh iff the latest `arm`
 * row for its alarm still names its `occurrenceId`, the arm is not retired
 * (`at !== null`), and no accepted (`delivered|exhausted`) firing settled it.
 */
export function alarmDisposition(
  reads: AlarmChainReads,
  occurrence: { readonly alarmId: string; readonly occurrenceId: string },
): AlarmDisposition {
  const arm = reads.latestArm(occurrence.alarmId);
  if (arm === undefined) return { op: "skip", reason: "unknown" };
  if (arm.occurrenceId !== occurrence.occurrenceId || arm.at === null)
    return { op: "skip", reason: "superseded" };
  if (reads.settled(occurrence.occurrenceId)) return { op: "skip", reason: "settled" };
  return { op: "run" };
}

function appendAlarm(input: {
  readonly id: string;
  readonly parentId: string | null;
  readonly sessionId: string;
  readonly intent: PlainObject;
  readonly effect: PlainObject;
  readonly revert?: PlainObject;
  readonly ts: number;
}): LedgerAction.Append {
  return {
    id: input.id,
    parentId: input.parentId,
    sessionId: input.sessionId,
    kind: "alarm",
    intent: { encodingVersion: 1, value: input.intent },
    effect: { encodingVersion: 1, value: input.effect },
    ...(input.revert === undefined
      ? { irreversible: true as const }
      : { revert: { encodingVersion: 1 as const, value: input.revert } }),
    ts: input.ts,
  };
}

/**
 * One `alarm{arm}` row (): mints the occurrence id from the arm's own
 * journal sequence (`armSeq`) inside the committing transaction. An
 * `at: null` arm retires the chain; `supersedes` names the previous
 * occurrence this arm replaces.
 */
export function armAction(input: {
  readonly parentId: string | null;
  readonly sessionId: string;
  readonly purpose: string;
  readonly at: number | null;
  readonly supersedes: string | null;
  readonly alarmId: string;
  readonly sourceKey: string;
  readonly payload: PlainObject;
  readonly armSeq: number;
  readonly ts: number;
}): { readonly action: LedgerAction.Append; readonly occurrenceId: string } {
  const occurrenceId = Alarm.occurrenceId(input.sessionId, input.alarmId, input.armSeq, input.sourceKey);
  return {
    occurrenceId,
    action: appendAlarm({
      id: `${input.alarmId}:arm:${input.armSeq}`,
      parentId: input.parentId,
      sessionId: input.sessionId,
      intent: {
        op: "arm",
        purpose: input.purpose,
        at: input.at,
        supersedes: input.supersedes,
        alarmId: input.alarmId,
        sourceKey: input.sourceKey,
        payload: input.payload,
      },
      effect: { occurrenceId },
      ts: input.ts,
    }),
  };
}

/** One `alarm{fired}` row (); idempotent per `<occurrenceId>:<outcome>` chain key. */
export function firedAction(input: {
  readonly parentId: string | null;
  readonly sessionId: string;
  readonly purpose: string;
  readonly alarmId: string;
  readonly occurrenceId: string;
  readonly outcome: "delivered" | "stale" | "exhausted";
  readonly ts: number;
}): LedgerAction.Append {
  return appendAlarm({
    id: `${input.occurrenceId}:${input.outcome}`,
    parentId: input.parentId,
    sessionId: input.sessionId,
    intent: {
      op: "fired",
      occurrenceId: input.occurrenceId,
      outcome: input.outcome,
      purpose: input.purpose,
      alarmId: input.alarmId,
    },
    effect: { op: "fired", occurrenceId: input.occurrenceId, outcome: input.outcome },
    ts: input.ts,
  });
}

/**
 * Boot alarm sweep config ( S3; nested inside `AlarmDrainConfig` at S4).
 * `full: true` rescans every session at boot; `full: false` rescans
 * `has_armed` sessions plus sessions idle for at least `idleDays` days.
 * Values come from the composition root's config, never from core constants.
 */
export interface AlarmSweepConfig {
  readonly full: boolean;
  readonly idleDays: number;
}

/** Loop consumption defaults ( S4, D3): typed in core, VALUES supplied by */
export interface AlarmDrainConfig {
  readonly alarmsBeforePrompt: number;
  readonly maxArmed: number;
  readonly idleMs: number;
  readonly sweep: AlarmSweepConfig;
  /** Bound the store-close finalizer waits for an in-flight arm's permit before closing anyway (default 5000). */
  readonly armCloseWaitMs?: number;
}

/**
 * Delivery attempts one occurrence may consume: the pre-execution strike reaching this count
 * folds `fired{exhausted}` unexecuted. A core constant (poison boundary), not drain configuration.
 */
export const MAX_OCCURRENCE_STRIKES = 3;


/** The fired occurrence view a capability's `wake` receives. */
export interface AlarmFired {
  readonly occurrenceId: string;
  readonly purpose: string;
  readonly alarmId: string;
  readonly armSeq: number;
  readonly sourceKey: string;
  /** Canonical JSON of the arm's payload. */
  readonly payload: string;
  readonly fireAt: number;
  /** Fire time of a quiet re-send (widens the dedupe key); absent on the committed occurrence. */
  readonly tick?: number;
}

/** Typed `arm` refusal (): the body's `deny{reason: alarm_budget}` is */
export class ArmRefused extends Schema.TaggedError<ArmRefused>(
  "@openomni/agent/core/ArmRefused",
)("ArmRefused", {
  code: Schema.Literals([
    "alarm_budget",
    "unknown_purpose",
    "reserved_purpose",
    "not_live",
    "stale_turn",
    "stale_activation",
    "revision",
  ]),
}) {}

/** The arm verb a capability schedules through; never a direct journal append. */
export type ArmVerb = (input: {
  readonly purpose: string;
  readonly at: number | null;
  readonly payload: PlainObject;
  readonly alarmId?: string;
  readonly supersedes?: string;
  readonly sourceKey: string;
}) => Effect.Effect<
  { readonly alarmId: string; readonly occurrenceId: string; readonly armSeq: number },
  ArmRefused
>;

/** Typed send refusal ( H2): the composed send door reports a PERMANENT */
export class AlarmSendRefused extends Schema.TaggedError<AlarmSendRefused>(
  "@openomni/agent/core/AlarmSendRefused",
)("AlarmSendRefused", {
  reason: Schema.String,
}) {}

/**
 * Everything one committed `alarm{arm}` row carries, reported post-commit by
 * the entity's arm verb ( H1). The composition root keeps native source
 * handles aligned with the chain: a re-arm moves the holder onto the new
 * occurrence at the commit, a retiring arm (`at: null`) closes it.
 */
export interface AlarmArmNotice {
  readonly sessionId: string;
  readonly purpose: string;
  readonly alarmId: string;
  readonly occurrenceId: string;
  readonly armSeq: number;
  readonly at: number | null;
  readonly supersedes: string | null;
  readonly sourceKey: string;
  readonly payload: PlainObject;
}

/**
 * The accepted outcome a capability's wake returns (): the core records
 * `fired{outcome: <returned>}` through `firedAction` — a capability never
 * builds an `alarm` append literal itself.
 */
export type AlarmWakeOutcome = "delivered" | "exhausted" | AlarmQuiet;

/** A fire that produced nothing: the occurrence moves to `at` (strikes reset) and is re-sent with no journal row. */
interface AlarmQuiet {
  readonly outcome: "quiet";
  readonly at: number;
}

/** Typed wake failure a capability's purpose handler reports. */
export class AlarmWakeError extends Schema.TaggedError<AlarmWakeError>(
  "@openomni/agent/core/AlarmWakeError",
)("AlarmWakeError", {
  purpose: Schema.String,
  reason: Schema.String,
}) {}

/** What one wake dispatch hands a registered purpose handler. */
export interface AlarmWakeContext {
  readonly sessionId: string;
  /** Kernel chain reads (chain page by alarmId). */
  readonly reads: AlarmChainReads;
  readonly arm: ArmVerb;
  readonly now: number;
  /** Reentrant intake on the owning writer; avoids an RPC to the writer handling this wake. */
  readonly deliver?: (input: {
    readonly kind: string;
    readonly body: string;
    readonly source: string;
    readonly idempotencyKey: string;
  }) => Effect.Effect<DeliverReceipt, DeliverRefused | AdmissionFailure>;
  /**
   *  S4: appends one `prompt{origin: "alarm"}` input row through the
   * entity's writer path; `seq` is the committed revision. The origin is
   * fixed by the core — a capability never owns a prompt write path.
   */
  readonly prompt: (input: {
    readonly content: string;
    readonly payload?: PlainObject;
  }) => Effect.Effect<{ readonly seq: number }, AlarmWakeError>;
}

/** One alarm capability: declared purposes plus their wake dispatch. */
export interface AlarmCapability {
  readonly purposes: readonly string[];
  readonly wake: (fired: AlarmFired, ctx: AlarmWakeContext) => Effect.Effect<AlarmWakeOutcome, AlarmWakeError>;
}

/** purpose → owning bundle; the core's four reserved purposes are always present. */
export type AlarmPurposeRegistry = ReadonlyMap<string, string>;

/** Durable retry schedule over the alarm chain ( S4): `arm` commits one */
export function createRetryAlarmPort(deps: RetryAlarmDeps): RetryAlarmPort {
  const alarmIdOf = (actionId: string) => `${actionId}:retry`;
  return {
    arm: (input) => {
      const alarmId = alarmIdOf(input.id);
      const armSeq = 2 * input.attempt - 1;
      const supersedes =
        input.attempt > 1
          ? Alarm.occurrenceId(deps.sessionId, alarmId, 2 * (input.attempt - 1) - 1, "retry")
          : null;
      const payload = { attempt: input.attempt, reason: input.reason };
      const { action, occurrenceId } = armAction({
        parentId: null,
        sessionId: deps.sessionId,
        purpose: "retry",
        at: input.fireAt,
        supersedes,
        alarmId,
        sourceKey: "retry",
        payload,
        armSeq,
        ts: input.fireAt,
      });
      // Chain evidence strictly before the persisted rearm: a crash between
      // the two resumes from the chain on activation; a crash inside the wait
      // is woken by the redelivered occurrence, folded by the chain guard.
      return deps.commitArm(action).pipe(
        Effect.flatMap(() =>
          deps.send({
            occurrenceId,
            purpose: "retry",
            alarmId,
            armSeq,
            sourceKey: "retry",
            payload: canonicalJson(payload),
            fireAt: input.fireAt,
          }),
        ),
      );
    },
    wait: (fireAt, signal) =>
      Effect.suspend(() => {
        const sleep = Effect.sleep(Math.max(0, fireAt - deps.clock()));
        if (signal === undefined) return sleep;
        return sleep.pipe(Effect.raceFirst(interruptOn(signal)));
      }),
    settle: (input) => {
      const alarmId = alarmIdOf(input.id);
      const { action } = armAction({
        parentId: null,
        sessionId: deps.sessionId,
        purpose: "retry",
        at: null,
        supersedes: Alarm.occurrenceId(deps.sessionId, alarmId, 2 * input.attempt - 1, "retry"),
        alarmId,
        sourceKey: "retry",
        payload: { attempt: input.attempt },
        armSeq: 2 * input.attempt,
        ts: deps.clock(),
      });
      return deps.commitArm(action);
    },
  };
}

/**
 * The alarm capability's tag: the identity a declaration requiring
 * `"alarm"` resolves against at compose.
 */
export const AlarmPort = port("@openomni/agent/capability/alarm");
