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
 * What this writer last committed on one kernel, valid only while the session revision still equals
 * `revision`: the tail counters since the latest checkpoint, the fold state through `revision` when a
 * pinning commit computed it (`state` plus the `suffix` committed after it), and whether a checkpoint
 * was refused at the row cap.
 */
type WriterTail = {
  readonly revision: number;
  readonly count: number;
  readonly bytes: number;
  readonly refused: boolean;
  readonly state: FoldCheckpoint.State | undefined;
  readonly suffix: readonly LedgerAction.Node[];
};

const writerTails = new WeakMap<SessionKernel, Map<string, WriterTail>>();

function tailsOf(kernel: SessionKernel): Map<string, WriterTail> {
  const existing = writerTails.get(kernel);
  if (existing !== undefined) return existing;
  const created = new Map<string, WriterTail>();
  writerTails.set(kernel, created);
  return created;
}

/** Takes the carried tail when it still describes `expectedRevision`, else reads it from the latest checkpoint. */
function resolveTail(
  kernel: SessionKernel,
  tails: Map<string, WriterTail>,
  input: LedgerSession.Commit,
  external: boolean,
) {
  const carried = tails.get(input.sessionId);
  tails.delete(input.sessionId);
  if (!external && carried?.revision === input.expectedRevision)
    return { memo: carried, checkpoint: undefined, count: carried.count, bytes: carried.bytes, refused: carried.refused };
  const checkpoint = readHistoryCheckpoint(kernel, input.sessionId, input.expectedRevision);
  return {
    memo: undefined,
    checkpoint,
    count: checkpoint.nonCheckpointActions,
    bytes: checkpoint.tailBytes(),
    refused: false,
  };
}

/**
 * Synchronous decoration preserves durable admission's existing suspension schedule. A checkpoint lands
 * at `everyActions` or when the tail bytes would pass `maxTailBytes`. The tail counters and fold state
 * carry across commits on the same kernel, so a commit below both thresholds reads no history and verifies
 * no checkpoint seed. A checkpoint past the row cap is refused typed (`row_bytes`), logged, and the caller's
 * rows commit without it; the writer then stops planning interval checkpoints for the session (only an
 * executed compaction result, which can shrink the state, is checkpointed again), so the restore tail is
 * unbounded until one lands and the activation restore refuses it with `RestoreRefused{code:"budget"}`.
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
    const tails = tailsOf(kernel);
    const external = input.actions.some((action) => action.kind === "fold.checkpoint");
    const { memo, checkpoint, count, bytes: tailBytes, refused } = resolveTail(kernel, tails, input, external);
    const incoming = input.actions.filter((action) => action.kind !== "fold.checkpoint").length;
    const incomingBytes = input.actions.reduce((total, action) => total + actionPayloadBytes(action), 0);
    if (
      (refused || (count + incoming < everyActions && tailBytes + incomingBytes <= maxTailBytes)) &&
      !input.actions.some(needsProjection)
    ) {
      const receipt = yield* kernel.commit(input);
      if (!external)
        tails.set(input.sessionId, {
          revision: receipt.row.revision,
          count: count + incoming,
          bytes: tailBytes + incomingBytes,
          refused,
          state: memo?.state,
          suffix: memo?.state === undefined ? [] : [...memo.suffix, ...receipt.receipts.map((committed) => committed.action)],
        });
      return receipt;
    }
    const state =
      memo?.state === undefined
        ? (checkpoint ?? readHistoryCheckpoint(kernel, input.sessionId, input.expectedRevision)).hydrate().state
        : foldHistoryState(input.sessionId, memo.suffix, memo.state);
    const seed = { state, count, bytes: tailBytes };
    const policy = { everyActions, maxTailBytes };
    const remember = (plan: FoldPlan, refusedNow: boolean) => (receipt: CommitReceipt) =>
      Effect.sync(() => {
        if (!external)
          tails.set(input.sessionId, {
            revision: receipt.row.revision,
            count: plan.count,
            bytes: plan.bytes,
            refused: refusedNow || (refused && plan.added.size === 0),
            state: plan.state,
            suffix: [],
          });
      });
    const planned = planFoldBatch(kernel, compaction, input, seed, policy, refused ? "compaction" : "all");
    return yield* kernel.commit({ ...input, actions: planned.actions }).pipe(
      Effect.tap(remember(planned, false)),
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
              Effect.suspend(() => {
                const fallback = planFoldBatch(kernel, compaction, input, seed, policy, "none");
                return kernel.commit({ ...input, actions: fallback.actions }).pipe(Effect.tap(remember(fallback, true)));
              }),
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
  /** The fold state and tail counters through the plan's last row. */
  readonly state: FoldCheckpoint.State;
  readonly count: number;
  readonly bytes: number;
};

/**
 * Pin the caller's drafts against the running fold and interleave the checkpoint rows `checkpoints`
 * admits: every row policy asks for, only those after an executed compaction result (after a row-cap
 * refusal), or none (the refused-checkpoint fallback, the pinned drafts alone).
 */
function planFoldBatch(
  kernel: SessionKernel,
  compaction: Pick<CompactionPortService, "pinAction"> | undefined,
  input: LedgerSession.Commit,
  seed: { readonly state: FoldCheckpoint.State; readonly count: number; readonly bytes: number },
  policy: { readonly everyActions: number; readonly maxTailBytes: number },
  checkpoints: "all" | "compaction" | "none",
): FoldPlan {
  let state = seed.state;
  let count = seed.count;
  let bytes = seed.bytes;
  const actions: LedgerAction.Append[] = [];
  const added = new Map<string, LedgerAction.Append>();
  const past = () => count >= policy.everyActions || bytes > policy.maxTailBytes;
  const add = (parentId: string | null, revision: number, reason: "interval" | "compaction") => {
    if (checkpoints === "none" || (checkpoints === "compaction" && reason === "interval")) return;
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
  return { actions, added, state, count, bytes };
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
