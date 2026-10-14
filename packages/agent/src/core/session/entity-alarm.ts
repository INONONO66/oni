import type { LedgerError } from "../store/errors";
import { parsePlainJson } from "../store/storage/sqlite-l0-rows";
import { canonicalJson, PlainValueSchema } from "@openomni/protocol";
import { Effect, Schema } from "effect";
import { AdmissionFailure, type AlarmOccurrence, type AlarmReceipt, DeadlineAlarmBody } from "../journal/messages";
import { alarmDisposition, firedAction, MAX_OCCURRENCE_STRIKES, type AlarmFired, type AlarmWakeContext, AlarmWakeError } from "../ports/alarm";
import { isReservedAlarmPurpose } from "@openomni/protocol";
import { armedChainReads, commitIn, entityArmVerb, retryRevision, sendQuietTick, type ActivationHandle } from "./entity-activation";
import { appendReceived, deliver, drain, requestCommand } from "./entity-delivery";

const decodeDeadlineBody = Schema.decodeUnknownSync(DeadlineAlarmBody);

export function alarmOccurrence(
  handle: ActivationHandle,
  occurrence: AlarmOccurrence,
  promptReceived: () => void,
): Effect.Effect<AlarmReceipt, AdmissionFailure> {
  return Effect.gen(function* () {
    if (occurrence.purpose === "rescan") return { outcome: "delivered" as const };
    const quietTick = occurrence.tick !== undefined;
    if (quietTick && !tickIsCurrent(handle, occurrence)) return { outcome: "stale" as const };
    const disposition =
      handle.kernel.actionById(`${occurrence.alarmId}:arm:${occurrence.armSeq}`) === undefined
        ? { op: "skip" as const, reason: "unknown" as const }
        : alarmDisposition(armedChainReads(handle), occurrence);
    if (disposition.op === "skip") {
      if (!quietTick) yield* appendFiredAlarm(handle, occurrence, "stale");
      return { outcome: "stale" as const };
    }
    const strikes = handle.kernel.strikeArmedAlarm(occurrence.occurrenceId);
    if (strikes !== undefined && strikes >= MAX_OCCURRENCE_STRIKES) {
      yield* appendFiredAlarm(handle, occurrence, "exhausted");
      return { outcome: "delivered" as const };
    }
    if (isReservedAlarmPurpose(occurrence.purpose)) {
      if (occurrence.purpose === "deadline") yield* expireDeadline(handle, occurrence);
      yield* appendFiredAlarm(handle, occurrence, "delivered");
      yield* drain(handle).pipe(Effect.orDie);
      return { outcome: "delivered" as const };
    }
    return yield* capabilityWake(handle, occurrence, promptReceived);
  }).pipe(Effect.catchIf(
    (error): error is LedgerError => !(error instanceof AdmissionFailure),
    (error) => Effect.die(error),
  ));
}

function tickIsCurrent(handle: ActivationHandle, occurrence: AlarmOccurrence): boolean {
  const armed = handle.kernel.armedAlarms().find((row) => row.occurrenceId === occurrence.occurrenceId);
  return armed !== undefined && armed.fireAt === occurrence.tick;
}

function expireDeadline(
  handle: ActivationHandle,
  occurrence: AlarmOccurrence,
): Effect.Effect<void, AdmissionFailure> {
  return Effect.suspend(() => {
    const body = decodeDeadlineBody(parsePlainJson(occurrence.payload));
    const request = handle.kernel.requestById(body.requestId);
    if (request === undefined || request.state !== "open") return Effect.void;
    return requestCommand(handle, body.requestId, `${body.requestId}:deadline`, {
      kind: "request.timeout",
      requestId: body.requestId,
    }).pipe(Effect.asVoid);
  });
}

function capabilityWake(
  handle: ActivationHandle,
  occurrence: AlarmOccurrence,
  promptReceived: () => void,
): Effect.Effect<AlarmReceipt, LedgerError | AdmissionFailure> {
  return Effect.gen(function* () {
    const capability = handle.env.ports.alarmCapability;
    if (capability === undefined || !capability.purposes.includes(occurrence.purpose)) {
      yield* appendFiredAlarm(handle, occurrence, "stale");
      return { outcome: "stale" as const };
    }
    const fired: AlarmFired = {
      occurrenceId: occurrence.occurrenceId,
      purpose: occurrence.purpose,
      alarmId: occurrence.alarmId,
      armSeq: occurrence.armSeq,
      sourceKey: occurrence.sourceKey,
      payload: occurrence.payload,
      fireAt: occurrence.fireAt,
      ...(occurrence.tick === undefined ? {} : { tick: occurrence.tick }),
    };
    const wake = yield* capability.wake(fired, wakeContext(handle, occurrence, promptReceived)).pipe(
      Effect.catchTag("AlarmWakeError", (error) =>
        Effect.logWarning(`alarm wake failed: ${occurrence.occurrenceId} (${error.reason})`).pipe(
          Effect.as("stale" as const),
        ),
      ),
    );
    if (wake === "stale") {
      yield* appendFiredAlarm(handle, occurrence, "stale");
      return { outcome: "stale" as const };
    }
    if (typeof wake !== "string") {
      // Move the occurrence forward in the index and re-send it keyed on the new time;
      // a re-send keyed on the current time would fold into this delivery and end the chain.
      const at = Math.max(wake.at, (occurrence.tick ?? occurrence.fireAt) + 1);
      if (handle.kernel.requeueArmedAlarm(occurrence.occurrenceId, at))
        yield* sendQuietTick(handle, { ...fired, tick: at });
      return { outcome: "delivered" as const };
    }
    yield* appendFiredAlarm(handle, occurrence, wake);
    if (wake === "delivered") yield* drain(handle).pipe(Effect.orDie);
    return { outcome: "delivered" as const };
  });
}

function wakeContext(handle: ActivationHandle, occurrence: AlarmOccurrence, promptReceived: () => void): AlarmWakeContext {
  return {
    sessionId: handle.authority.sessionId,
    reads: armedChainReads(handle),
    arm: entityArmVerb(handle),
    now: handle.env.clock(),
    deliver: (input) => Effect.suspend(() => {
      if (input.kind === "prompt") promptReceived();
      return deliver(handle, input);
    }),
    prompt: (input) =>
      appendReceived(handle, "prompt", {
        messageId: `${occurrence.occurrenceId}:prompt`,
        content: input.content,
        origin: canonicalJson(PlainValueSchema.parse({
          kind: "alarm",
          alarmId: occurrence.alarmId,
          occurrenceId: occurrence.occurrenceId,
          purpose: occurrence.purpose,
          sourceKey: occurrence.sourceKey,
          ...(input.payload === undefined ? {} : { payload: input.payload }),
        })),
      }).pipe(
        Effect.map((receipt) => ({ seq: receipt.ordinal })),
        Effect.mapError(() => new AlarmWakeError({ purpose: occurrence.purpose, reason: "prompt_commit" })),
      ),
  };
}

function appendFiredAlarm(
  handle: ActivationHandle,
  occurrence: AlarmOccurrence,
  outcome: "delivered" | "stale" | "exhausted",
): Effect.Effect<void, LedgerError | AdmissionFailure> {
  const { kernel, authority, env } = handle;
  const id = `${occurrence.occurrenceId}:${outcome}`;
  return retryRevision(() =>
    Effect.suspend(() => {
      if (kernel.actionById(id) !== undefined) return Effect.void;
      const row = kernel.row(authority.sessionId);
      const now = env.clock();
      return commitIn(handle, {
        sessionId: authority.sessionId,
        owner: authority.owner,
        fence: authority.fence,
        now,
        expectedRevision: row.revision,
        actions: [
          firedAction({
            parentId: kernel.latestAction(authority.sessionId)?.id ?? null,
            sessionId: authority.sessionId,
            purpose: occurrence.purpose,
            alarmId: occurrence.alarmId,
            occurrenceId: occurrence.occurrenceId,
            outcome,
            ts: now,
          }),
        ],
        state: row.state,
      }).pipe(Effect.asVoid);
    }),
  );
}
