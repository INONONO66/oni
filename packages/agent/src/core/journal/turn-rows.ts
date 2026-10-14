import { PlainValueSchema, SessionTurn, type LedgerAction, type PlainValue, type SessionGeneration } from "@openomni/protocol";
import type { SessionRunnerResult } from "../session/run";

interface TurnEnvelopeActionInput {
  readonly id: string;
  readonly parentId: string | null;
  readonly sessionId: string;
  readonly generation: SessionGeneration.Snapshot;
  readonly at: number;
}

interface TurnPinnedInput {
  readonly generation: SessionGeneration.Snapshot;
  readonly resultId: string;
  readonly resumeCount: number;
  readonly boundaryActionId: string | null;
}

function pinnedTurn(
  input: TurnPinnedInput,
): Omit<SessionTurn.Intent, "phase" | "deliveryIds" | "context"> {
  return {
    resultId: input.resultId,
    toolsGeneration: input.generation.generation,
    toolsHash: input.generation.toolsHash,
    systemHash: input.generation.systemHash,
    policyGeneration: input.generation.policyGeneration,
    resumeCount: input.resumeCount,
    boundaryActionId: input.boundaryActionId,
  };
}

function turnEnvelopeAction(
  input: TurnEnvelopeActionInput,
  intent: SessionTurn.DecodeIntent | SessionTurn.DecodeResume,
): LedgerAction.Append {
  return {
    id: input.id,
    parentId: input.parentId,
    sessionId: input.sessionId,
    kind: "turn",
    intent: { encodingVersion: 1, value: PlainValueSchema.parse(intent) },
    effect: { encodingVersion: 1, value: SessionTurn.Pending.parse({ phase: "pending" }) },
    irreversible: true,
    ts: input.at,
  };
}

export function turnIntentAction(input: {
  readonly id: string;
  readonly parentId: string | null;
  readonly sessionId: string;
  readonly resultId: string;
  readonly deliveryIds: readonly string[];
  /**  H-3: stale `action` inputs this turn closes WITHOUT execution (`turn.consumed.stale`). */
  readonly consumedStale?: readonly string[];
  readonly generation: SessionGeneration.Snapshot;
  readonly resumeCount: number;
  readonly boundaryActionId: string | null;
  readonly at: number;
}): LedgerAction.Append {
  return turnEnvelopeAction(
    input,
    SessionTurn.DecodeIntent.parse({
      phase: "intent",
      deliveryIds: [...input.deliveryIds],
      ...(input.consumedStale === undefined || input.consumedStale.length === 0
        ? {}
        : { consumedStale: [...input.consumedStale] }),
      ...pinnedTurn(input),
    }),
  );
}

export function turnResumeAction(input: {
  readonly id: string;
  readonly parentId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly resultId: string;
  readonly generation: SessionGeneration.Snapshot;
  readonly resumeCount: number;
  readonly boundaryActionId: string | null;
  readonly at: number;
}): LedgerAction.Append {
  return turnEnvelopeAction(
    input,
    SessionTurn.DecodeResume.parse({
      phase: "resume",
      turnId: input.turnId,
      ...pinnedTurn(input),
    }),
  );
}

export function turnCheckpointAction(input: {
  readonly id: string;
  readonly parentId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly resultId: string;
  readonly resumeCount: number;
  readonly boundaryActionId: string;
  readonly boundary: SessionTurn.Boundary;
  /** Consumed input seqs at this boundary (): the turn's `turn.consumed` record. */
  readonly deliveryIds: readonly string[];
  /**  H-1 (r3): stale `action` inputs this boundary closes WITHOUT execution (`turn.consumed.stale`). */
  readonly consumedStale?: readonly string[];
  readonly at: number;
}): LedgerAction.Append {
  return {
    id: input.id,
    parentId: input.parentId,
    sessionId: input.sessionId,
    kind: "turn",
    intent: {
      encodingVersion: 1,
      value: {
        phase: "checkpoint",
        turnId: input.turnId,
        deliveryIds: [...input.deliveryIds],
        ...(input.consumedStale === undefined || input.consumedStale.length === 0
          ? {}
          : { consumedStale: [...input.consumedStale] }),
      },
    },
    effect: {
      encodingVersion: 1,
      value: {
        phase: "checkpoint",
        turnId: input.turnId,
        resultId: input.resultId,
        resumeCount: input.resumeCount,
        boundaryActionId: input.boundaryActionId,
        boundary: input.boundary,
      },
    },
    irreversible: true,
    ts: input.at,
  };
}

export function turnTerminalAction(input: {
  readonly id: string;
  readonly parentId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly result: SessionRunnerResult;
  readonly resumeCount: number;
  readonly boundaryActionId: string | null;
  readonly at: number;
}): LedgerAction.Append {
  return {
    id: input.id,
    parentId: input.parentId,
    sessionId: input.sessionId,
    kind: "turn",
    intent: { encodingVersion: 1, value: { phase: "terminal", turnId: input.turnId } },
    effect: {
      encodingVersion: 1,
      value: {
        phase: "terminal",
        turnId: input.turnId,
        kind: input.result.kind,
        ...(input.result.kind === "waiting"
          ? { reason: input.result.reason, alarmIds: [...input.result.alarmIds] }
          : {}),
        text: input.result.text ?? "",
        boundaryActionId: input.boundaryActionId,
        resumeCount: input.resumeCount,
      },
    },
    irreversible: true,
    ts: input.at,
  };
}

/** The gate's turn-stop row (): constructed here, the turn kind's single writer. */
export function turnStopAction(input: {
  readonly id: string;
  readonly parentId: string | null;
  readonly sessionId: string;
  readonly generation: number;
  readonly verdict: PlainValue;
  readonly state: PlainValue;
  readonly ts: number;
}): LedgerAction.Append {
  return {
    id: input.id,
    parentId: input.parentId,
    sessionId: input.sessionId,
    kind: "turn",
    intent: {
      encodingVersion: 1,
      value: { phase: "stop", generation: input.generation },
    },
    effect: {
      encodingVersion: 1,
      value: { phase: "stop", verdict: input.verdict, state: input.state },
    },
    irreversible: true,
    ts: input.ts,
  };
}
