import { canonicalDigest, PlainValueSchema, SessionTurn, FoldCheckpoint, type LedgerAction, type LedgerSession } from "@openomni/protocol";
import { Effect } from "effect";
import { checkpointPolicy, foldHistoryState, foldSessionHistory, readHistoryCheckpoint } from "../../inspect/history";
import type { CompactionPortService } from "../ports/compaction-ports";
import { AgentInvariantViolation } from "../ports/failure";
import type { SessionKernel } from "../session/entity";
import { actionPayloadBytes } from "../store/action-hash";
import { SchemaRefused, type LedgerError } from "../store/errors";
import type { CommitReceipt } from "../store/services";

/** Fails closed: a compaction append without the composed port cannot be pinned. */
function requireNoCompactionPin(action: LedgerAction.Append): LedgerAction.Append {
  if (action.kind === "compaction")
    throw new AgentInvariantViolation("compaction append without a composed compaction port");
  return action;
}

/** Pins through the composed port, or fails closed on an unpinnable compaction append. */
function pinThroughPort(
  compaction: Pick<CompactionPortService, "pinAction"> | undefined,
  kernel: SessionKernel,
  action: LedgerAction.Append,
  state: FoldCheckpoint.State,
  sourceRevision: number,
): LedgerAction.Append {
  return compaction !== undefined
    ? compaction.pinAction(kernel, action, state, sourceRevision)
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

/**
 * Synchronous decoration preserves durable admission's existing suspension schedule. A checkpoint lands
 * at `everyActions` or when the tail bytes would pass `maxTailBytes`, so no restore meets a tail this writer
 * let grow. State past the row cap never checkpoints again: the typed `row_bytes` refusal is logged, the caller's rows commit, later commits refold the full tail.
 */
export function commitFoldBatch(
  kernel: SessionKernel,
  input: LedgerSession.Commit,
  // The composed compaction port decorates compaction appends with
  // their successor proof. Absent port + compaction append = typed defect —
  // the kernel never pins without the capability, and never commits unpinned.
  compaction?: Pick<CompactionPortService, "pinAction">,
): Effect.Effect<CommitReceipt, LedgerError> {
  return Effect.gen(function* () {
    const { everyActions, maxTailBytes } = checkpointPolicy(kernel, input.sessionId);
    const checkpoint = readHistoryCheckpoint(kernel, input.sessionId, input.expectedRevision);
    const incoming = input.actions.filter((action) => action.kind !== "fold.checkpoint").length;
    const incomingBytes = input.actions.reduce((total, action) => total + actionPayloadBytes(action), 0);
    const tailBytes = checkpoint.tailBytes();
    if (
      checkpoint.nonCheckpointActions + incoming < everyActions &&
      tailBytes + incomingBytes <= maxTailBytes &&
      !input.actions.some(needsProjection)
    )
      return yield* kernel.commit(input);
    const hydrated = checkpoint.hydrate();
    const seed = { state: hydrated.state, count: hydrated.nonCheckpointActions, bytes: tailBytes };
    const policy = { everyActions, maxTailBytes };
    const planned = planFoldBatch(kernel, compaction, input, seed, policy, true);
    return yield* kernel.commit({ ...input, actions: planned.actions }).pipe(
      Effect.catchIf(
        (error): error is SchemaRefused =>
          error instanceof SchemaRefused &&
          error.reason === "row_bytes" &&
          error.actionId !== undefined &&
          planned.added.has(error.actionId),
        (refused) => {
          const row = planned.added.get(refused.actionId ?? "");
          return Effect.annotateLogs(
            Effect.logWarning(`fold checkpoint refused (row_bytes): ${input.sessionId}`),
            {
              sessionId: input.sessionId,
              checkpointId: refused.actionId,
              checkpointBytes: row === undefined ? null : actionPayloadBytes(row),
            },
          ).pipe(
            Effect.andThen(
              kernel.commit({ ...input, actions: planFoldBatch(kernel, compaction, input, seed, policy, false).actions }),
            ),
          );
        },
      ),
    );
  });
}

type FoldPlan = {
  readonly actions: LedgerAction.Append[];
  /** The interval/compaction checkpoint rows this writer added, by id. */
  readonly added: ReadonlyMap<string, LedgerAction.Append>;
};

/**
 * Pin the caller's drafts against the running fold and, with `checkpoints`, interleave the
 * checkpoint rows policy asks for; without it the plan is the pinned drafts alone (refused-checkpoint fallback).
 */
function planFoldBatch(
  kernel: SessionKernel,
  compaction: Pick<CompactionPortService, "pinAction"> | undefined,
  input: LedgerSession.Commit,
  seed: { readonly state: FoldCheckpoint.State; readonly count: number; readonly bytes: number },
  policy: { readonly everyActions: number; readonly maxTailBytes: number },
  checkpoints: boolean,
): FoldPlan {
  let state = seed.state;
  let count = seed.count;
  let bytes = seed.bytes;
  const actions: LedgerAction.Append[] = [];
  const added = new Map<string, LedgerAction.Append>();
  const past = () => count >= policy.everyActions || bytes > policy.maxTailBytes;
  const add = (parentId: string | null, revision: number, reason: "interval" | "compaction") => {
    if (!checkpoints) return;
    const interval = foldCheckpointAction({ sessionId: input.sessionId, parentId, revision, at: input.now, reason, state });
    actions.push(interval);
    added.set(interval.id, interval);
    count = 0;
    bytes = actionPayloadBytes(interval);
  };
  for (const draft of input.actions) {
    const sourceRevision = input.expectedRevision + actions.length;
    const contextPinned = pinContext(draft, state, sourceRevision);
    const action = pinThroughPort(compaction, kernel, contextPinned, state, sourceRevision);
    actions.push(action);
    const ordinal = input.expectedRevision + actions.length;
    state = foldHistoryState(
      input.sessionId,
      [{ ...action, ordinal, prevHash: "", actionHash: "" }],
      state,
    );
    if (action.kind !== "fold.checkpoint") count += 1;
    bytes += actionPayloadBytes(action);
    if (executedCompactionResult(action)) add(action.id, ordinal, "compaction");
    else if (past()) add(action.id, ordinal, "interval");
  }
  if (actions.length === 0 && past())
    add(kernel.latestAction(input.sessionId, input.expectedRevision)?.id ?? null, input.expectedRevision, "interval");
  return { actions, added };
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
