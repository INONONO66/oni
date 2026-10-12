import type { CommitReceipt } from "./store/services";
import type { LedgerError } from "./store/errors";
import { Effect } from "effect";
import type { SessionKernel } from "./entity";
import {
  canonicalDigest,
  type ConsumptionSettings,
  type ConsumptionWidth,
  JournalKind,
  PlainValueSchema,
  SessionTurn,
  FoldCheckpoint,
  type LedgerAction,
  type LedgerSession,
  SessionGeneration,
  type Delivery,
  type PlainValue,
} from "@openomni/protocol";
import { checkpointPolicy, foldHistoryState, foldSessionHistory, readHistoryCheckpoint } from "../inspect/history";
import type { CompactionSeamService } from "./compaction-ports";
import type * as SessionHandleStore from "./store/fence";
import { z } from "zod";
import { RunReasonCode } from "./reason-codes";
import { AgentInvariantViolation, GenerationUnavailable } from "./failure";
import { SessionPolicyRefusal } from "./messages";
import type { SessionRunnerResult, SessionTool } from "./run";

// ─── from session-fold-commit.ts (#1247) ───
/** Fails closed: a compaction append without the composed seam cannot be pinned. */
function requireNoCompactionPin(action: LedgerAction.Append): LedgerAction.Append {
  if (action.kind === "compaction")
    throw new AgentInvariantViolation("compaction append without a composed compaction seam");
  return action;
}

/** Pins through the composed seam, or fails closed on an unpinnable compaction append. */
function pinThroughSeam(
  seam: Pick<CompactionSeamService, "pinAction"> | undefined,
  kernel: SessionKernel,
  action: LedgerAction.Append,
  state: FoldCheckpoint.State,
  sourceRevision: number,
): LedgerAction.Append {
  return seam !== undefined
    ? seam.pinAction(kernel, action, state, sourceRevision)
    : requireNoCompactionPin(action);
}

/** An executed compaction result forces an immediate checkpoint after it. */
function executedCompactionResult(action: LedgerAction.Append): boolean {
  const effect = action.effect.value;
  return (
    action.kind === "compaction" &&
    effect !== null &&
    typeof effect === "object" &&
    !Array.isArray(effect) &&
    effect.phase === "result" &&
    effect.terminal === "executed"
  );
}

/** Synchronous decoration preserves durable admission's existing suspension schedule. */
export function commitFoldBatch(
  kernel: SessionKernel,
  input: LedgerSession.Commit,
  // #1307: the composed compaction seam decorates compaction appends with
  // their successor proof. Absent seam + compaction append = typed defect —
  // the kernel never pins without the capability, and never commits unpinned.
  seam?: Pick<CompactionSeamService, "pinAction">,
): Effect.Effect<CommitReceipt, LedgerError> {
  return Effect.gen(function* () {
    const { everyActions } = checkpointPolicy(kernel, input.sessionId);
    const checkpoint = readHistoryCheckpoint(kernel, input.sessionId, input.expectedRevision);
    const incoming = input.actions.filter((action) => action.kind !== "fold.checkpoint").length;
    if (checkpoint.nonCheckpointActions + incoming < everyActions && !input.actions.some(needsProjection))
      return yield* kernel.commit(input);
    const hydrated = checkpoint.hydrate();
    let state = hydrated.state;
    let count = hydrated.nonCheckpointActions;
    const actions: LedgerAction.Append[] = [];
    for (const draft of input.actions) {
      const sourceRevision = input.expectedRevision + actions.length;
      const contextPinned = pinContext(draft, state, sourceRevision);
      const action = pinThroughSeam(seam, kernel, contextPinned, state, sourceRevision);
      actions.push(action);
      const ordinal = input.expectedRevision + actions.length;
      state = foldHistoryState(
        input.sessionId,
        [{ ...action, ordinal, prevHash: "", actionHash: "" }],
        state,
      );
      if (action.kind !== "fold.checkpoint") count += 1;
      const compaction = executedCompactionResult(action);
      if (count < everyActions && !compaction) continue;
      actions.push(
        foldCheckpointAction({
          sessionId: input.sessionId,
          parentId: action.id,
          revision: ordinal,
          at: input.now,
          reason: compaction ? "compaction" : "interval",
          state,
        }),
      );
      count = 0;
    }
    if (actions.length === 0 && count >= everyActions) {
      actions.push(
        foldCheckpointAction({
          sessionId: input.sessionId,
          parentId: kernel.latestAction(input.sessionId, input.expectedRevision)?.id ?? null,
          revision: input.expectedRevision,
          at: input.now,
          reason: "interval",
          state,
        }),
      );
    }
    return yield* kernel.commit({ ...input, actions });
  });
}

function needsProjection(action: LedgerAction.Append): boolean {
  if (action.kind === "compaction") return true;
  if (action.kind !== "turn") return false;
  const value = action.intent.value;
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value.phase === "intent" || value.phase === "resume")
  );
}

function pinContext(
  action: LedgerAction.Append,
  state: FoldCheckpoint.State,
  sourceRevision: number,
): LedgerAction.Append {
  if (action.kind !== "turn") return action;
  const value = action.intent.value;
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value.phase !== "intent" && value.phase !== "resume")
  )
    return action;
  const projection = foldSessionHistory(action.sessionId, [], state);
  const context = {
    snapshotActionId: action.id,
    sourceRevision,
    foldVersion: 1,
    projectionHash: canonicalDigest({
      foldVersion: 1,
      projection: PlainValueSchema.parse(projection),
    }),
    messageIds: projection.map((message) => message.info.id),
    successorActionId: state.successorActionId,
    projection,
  };
  const pinned = { ...value, context };
  const intent =
    value.phase === "intent" ? SessionTurn.Intent.parse(pinned) : SessionTurn.Resume.parse(pinned);
  return { ...action, intent: { encodingVersion: 1, value: PlainValueSchema.parse(intent) } };
}

// ─── from session-record.ts (#1247) ───
export function foldCheckpointAction(input: {
  readonly sessionId: string;
  readonly parentId: string | null;
  readonly revision: number;
  readonly at: number;
  readonly reason: "interval" | "compaction";
  readonly state: FoldCheckpoint.State;
}): LedgerAction.Append {
  const state = PlainValueSchema.parse(input.state);
  return {
    id: `${input.sessionId}:fold:${input.revision}`,
    sessionId: input.sessionId,
    parentId: input.parentId,
    kind: "fold.checkpoint",
    intent: {
      encodingVersion: 1,
      value: PlainValueSchema.parse(
        FoldCheckpoint.Intent.parse({
          phase: "checkpoint",
          foldVersion: 1,
          revision: input.revision,
          reason: input.reason,
        }),
      ),
    },
    effect: {
      encodingVersion: 1,
      value: PlainValueSchema.parse(
        FoldCheckpoint.Effect.parse({
          phase: "result",
          terminal: "executed",
          result: {
            foldVersion: 1,
            revision: input.revision,
            state,
            stateHash: canonicalDigest({ foldVersion: 1, state }),
          },
        }),
      ),
    },
    irreversible: true,
    ts: input.at,
  };
}

export function toolSnapshot(tool: SessionTool): SessionGeneration.Tool {
  return SessionGeneration.Tool.parse(tool);
}

export function internalOrigin(sessionId: string): Delivery.Origin {
  return { encodingVersion: 1, value: { kind: "session", id: sessionId } };
}

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
  /** #1256 H-3: stale `action` inputs this turn closes WITHOUT execution (`turn.consumed.stale`). */
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
  /** Consumed input seqs at this boundary (#1253): the turn's `turn.consumed` record. */
  readonly deliveryIds: readonly string[];
  /** #1256 H-1 (r3): stale `action` inputs this boundary closes WITHOUT execution (`turn.consumed.stale`). */
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

/**
 * The journal row kind one delivered input lands as (#1252): `prompt` and
 * `action` inputs are rows of their own kind; interrupt/resume control is a
 * `signal` row. The single mapping both the admission constructor and the
 * delivery constructor share.
 */
export function inputRowKind(kind: Delivery.Kind): "prompt" | "signal" | "action" {
  return kind === "prompt" || kind === "action" ? kind : "signal";
}

export function deliveryActions(
  items: readonly Delivery.Row[],
  target: { readonly kind: "turn"; readonly turnId: string } | { readonly kind: "pending" },
  boundary: SessionTurn.Boundary,
  parentId: string | null,
): LedgerAction.Append[] {
  let parent = parentId;
  return items.map((item) => {
    const action: LedgerAction.Append = {
      id: `${item.id}:delivery`,
      parentId: parent,
      sessionId: item.sessionId,
      // #1252: a delivered input is a journal row of its own kind — `prompt`
      // for turn inputs, `signal` for interrupt/resume control. The retired
      // input-queue delivery kind had one writer here; this constructor keeps it.
      kind: inputRowKind(item.kind),
      intent: {
        encodingVersion: 1,
        value:
          item.kind === "interrupt" || item.kind === "resume" || item.kind === "cancel"
            ? { deliveryId: item.id, control: item.kind }
            : { deliveryId: item.id, delivery: item.delivery ?? JournalKind.DEFAULT_DELIVERY },
      },
      effect: {
        encodingVersion: 1,
        value: {
          phase: "delivery",
          turnId: target.kind === "turn" ? target.turnId : item.id,
          deliveryId: item.id,
          kind: item.kind,
          content: item.content,
          origin: item.origin,
          boundary,
        },
      },
      irreversible: true,
      ts: item.createdAt,
    };
    parent = action.id;
    return action;
  });
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

/** The gate's turn-stop row (#1252): constructed here, the turn kind's single writer. */
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

export function policyRefusalResult(reason: string): SessionRunnerResult {
  const cause = new SessionPolicyRefusal(reason);
  return { kind: "error", text: cause.message, cause };
}

export function sessionRunnerResultValue(result: SessionRunnerResult): PlainValue {
  if (result.kind === "waiting") return { ...result, alarmIds: [...result.alarmIds] };
  if (result.kind === "interrupted") {
    return { kind: result.kind, ...(result.text === undefined ? {} : { text: result.text }) };
  }
  if (result.kind === "error") {
    return {
      kind: result.kind,
      text: result.text,
      ...(result.reported === undefined ? {} : { reported: result.reported }),
    };
  }
  return {
    kind: result.kind,
    text: result.text,
    ...(result.finishReason === undefined ? {} : { finishReason: result.finishReason }),
    ...(result.usage === undefined
      ? {}
      : {
          usage: {
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            totalTokens: result.usage.totalTokens,
            ...(result.usage.reasoningTokens === undefined
              ? {}
              : { reasoningTokens: result.usage.reasoningTokens }),
            ...(result.usage.cacheReadTokens === undefined
              ? {}
              : { cacheReadTokens: result.usage.cacheReadTokens }),
            ...(result.usage.cacheWriteTokens === undefined
              ? {}
              : { cacheWriteTokens: result.usage.cacheWriteTokens }),
          },
        }),
  };
}

const SessionUsage = z.strictObject({
  inputTokens: z.number(),
  outputTokens: z.number(),
  totalTokens: z.number(),
  reasoningTokens: z.number().optional(),
  cacheReadTokens: z.number().optional(),
  cacheWriteTokens: z.number().optional(),
});

const SessionResult = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("result"),
    text: z.string(),
    finishReason: z.enum(["stop", "max-steps", RunReasonCode.Stalled]).optional(),
    usage: SessionUsage.optional(),
  }),
  z.strictObject({
    kind: z.literal("waiting"),
    text: z.string(),
    reason: z.literal("live_wait"),
    alarmIds: z.array(z.string()).nonempty(),
  }),
  z.strictObject({ kind: z.literal("interrupted"), text: z.string().optional() }),
  z.strictObject({
    kind: z.literal("error"),
    text: z.string(),
    reported: z.literal(true).optional(),
  }),
]);

export function sessionRunnerResultFromValue(value: PlainValue): SessionRunnerResult | undefined {
  const result = SessionResult.safeParse(value);
  return result.success ? result.data : undefined;
}

export function generationForOpen(
  kernel: SessionKernel,
  open: SessionHandleStore.OpenTurn,
): Effect.Effect<SessionGeneration.Snapshot, GenerationUnavailable> {
  const snapshot = kernel.generationFor(open.action.sessionId, open.toolsGeneration);
  if (
    snapshot === undefined ||
    snapshot.toolsHash !== open.toolsHash ||
    snapshot.systemHash !== open.systemHash ||
    snapshot.policyGeneration !== open.policyGeneration
  ) {
    return Effect.fail(new GenerationUnavailable({ generation: open.toolsGeneration }));
  }
  return Effect.succeed(snapshot);
}

/** The durable chain action for one received message: the chain itself is the input queue. */
export function receivedMessageAction(input: {
  readonly id: string;
  readonly sessionId: string;
  readonly kind: Delivery.Kind;
  readonly content: string;
  readonly origin: Delivery.Origin;
  readonly parentActionId: string | null;
  readonly at: number;
  /** Loop-consumption delivery the input row carries (#1253); absent folds to the `followUp` default. */
  readonly delivery?: JournalKind.Delivery;
}): LedgerAction.Append {
  return {
    id: input.id,
    parentId: input.parentActionId,
    sessionId: input.sessionId,
    // #1252: control inputs (interrupt/resume) are signal rows; prompts are prompt rows.
    kind: inputRowKind(input.kind),
    intent: input.origin,
    effect: {
      encodingVersion: 1,
      value: {
        deliveryKind: input.kind,
        content: input.content,
        ...(input.delivery === undefined ? {} : { delivery: input.delivery }),
      },
    },
    irreversible: true,
    ts: input.at,
  };
}

/**
 * #1256 H-3: the staleness split a turn start applies to its backlog. A
 * deferred `action` input carries the journal ordinal (`after`) its payload
 * was computed against; one pointing BEFORE the latest executed compaction
 * reasons about a context that no longer exists, so it is never consumed —
 * the turn closes it via `turn.consumed.stale`. Everything else is live.
 */
export function staleActionBacklog(
  backlog: readonly Delivery.Row[],
  compactionHead: number,
): { readonly live: Delivery.Row[]; readonly stale: Delivery.Row[] } {
  const live: Delivery.Row[] = [];
  const stale: Delivery.Row[] = [];
  for (const row of backlog) {
    const isStale = row.kind === "action" && row.after !== undefined && row.after < compactionHead;
    (isStale ? stale : live).push(row);
  }
  return { live, stale };
}

/** Current behavior when no configure row pins widths: every boundary consumes all eligible rows. */
export const DEFAULT_CONSUMPTION: ConsumptionSettings = { steering: "all", followUp: "all" };

/**
 * The `all|one` consumption widths (#1253): settings data folded from the
 * latest `session.configure` row carrying `intent.settings`, not code.
 */
export function consumptionSettings(kernel: SessionKernel, sessionId: string): ConsumptionSettings {
  return kernel.latestSettings(sessionId) ?? DEFAULT_CONSUMPTION;
}

/**
 * The loop boundary consumption rule (#1253): control signals
 * (interrupt/resume) are consumed at every boundary; `delivery: steer` input
 * rows at `tool.post` (`after_tools`) boundaries and at turn end; `delivery:
 * followUp` rows only at turn end. How many rows one boundary consumes per
 * mode is the settings widths (`all|one`). Returns the consumed subset in
 * backlog order.
 */
export function boundaryConsumption(
  backlog: readonly Delivery.Row[],
  boundary: SessionTurn.Boundary | "turn_end",
  settings: ConsumptionSettings,
  /** #1256 H-1 (r3): the latest executed compaction's ordinal; EVERY boundary closes stale actions, not just turn start. */
  compactionHead: number,
): { readonly consumed: Delivery.Row[]; readonly stale: Delivery.Row[] } {
  const { live, stale } = staleActionBacklog(backlog, compactionHead);
  const width = (rows: readonly Delivery.Row[], mode: ConsumptionWidth) =>
    mode === "one" ? rows.slice(0, 1) : rows;
  const inputs = live.filter((item) => item.kind === "prompt" || item.kind === "action");
  const steer = inputs.filter(
    (item) => (item.delivery ?? JournalKind.DEFAULT_DELIVERY) === "steer",
  );
  const followUp = inputs.filter(
    (item) => (item.delivery ?? JournalKind.DEFAULT_DELIVERY) === "followUp",
  );
  const chosen = new Set(
    [
      ...live.filter(
        (item) => item.kind === "interrupt" || item.kind === "cancel" || item.kind === "resume",
      ),
      ...(boundary === "after_tools" || boundary === "turn_end"
        ? width(steer, settings.steering)
        : []),
      ...(boundary === "turn_end" ? width(followUp, settings.followUp) : []),
    ].map((item) => item.id),
  );
  return { consumed: live.filter((item) => chosen.has(item.id)), stale };
}
