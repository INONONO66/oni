import { Delivery, PlainObjectSchema, type PlainValue, type LedgerAction, type LedgerSession, L0Observation, type PolicyRow, SessionHistory, SessionTransition, SessionTurn, type ObservationSink } from "@oni/protocol";
import { z } from "zod";
import { latestGenerationForIn } from "./configure";
import { LedgerInvariant, SessionNotFound, StorageUnavailable } from "./errors";
import type { SessionKernelContext } from "./fence";

/** The seed and its high-water mark belong to the same SQLite read snapshot. */
export function latestFoldCheckpointIn(
  context: SessionKernelContext,
  sessionId: string,
  throughRevision?: number,
) {
  return context.stores().transaction(() => {
    const revision = Math.min(
      rowIn(context, sessionId).revision,
      throughRevision ?? Number.MAX_SAFE_INTEGER,
    );
    return {
      revision,
      checkpoint: requiredActionsIn(context).latestFoldCheckpoint(sessionId, revision),
    };
  });
}

export function openTurnsPageIn(
  context: SessionKernelContext,
  sessionId: string,
  cursor = 0,
  limit = 256,
): OpenTurn[] {
  const actions = requiredActionsIn(context);
  return actions.openTurnsPage(sessionId, cursor, limit).flatMap((intent) => {
    const update = actions.latestTurnUpdate(sessionId, intent.id);
    return openTurns(update === undefined ? [intent] : [intent, update]);
  });
}

export function latestOpenTurnIn(context: SessionKernelContext, sessionId: string): OpenTurn | undefined {
  let cursor = 0;
  let latest: OpenTurn | undefined;
  for (;;) {
    const page = openTurnsPageIn(context, sessionId, cursor);
    latest = page.at(-1) ?? latest;
    if (page.length < 256 || latest === undefined) return latest;
    const intent = requiredActionsIn(context).actionById(latest.turnId);
    if (intent === undefined)
      throw new LedgerInvariant({
        operation: "session.openTurns",
        message: `open turn intent missing: ${latest.turnId}`,
      });
    cursor = intent.ordinal;
  }
}

export function resultForIn(context: SessionKernelContext, sessionId: string, parentId: string) {
  const actions = requiredActionsIn(context);
  const result = actions.resultFor(sessionId, parentId);
  if (result === undefined) return undefined;
  const parent = actions.actionById(parentId);
  const outcome = SessionHistory.Outcome.safeParse(
    PlainObjectSchema.parse(result.effect.value).terminal,
  );
  if (
    parent?.sessionId !== sessionId ||
    parent.kind !== result.kind ||
    PlainObjectSchema.parse(result.intent.value).phase !== "result" ||
    !outcome.success ||
    outcome.data === "pending"
  )
    throw new LedgerInvariant({
      operation: "session.resultFor",
      message: `invalid result identity: ${result.id}`,
    });
  return result;
}


/**
 * Authoritative, bounded read of committed history after `afterRevision`. The
 * row revision and the slice come from one transaction, so a watcher that saw a
 * gap resynchronizes from its last revision without inventing or skipping events.
 */
export function historyPageIn(
  context: SessionKernelContext,
  sessionId: string,
  request: SessionHistory.PageRequest = {},
): SessionHistory.Page {
  const { afterRevision, limit } = SessionHistory.PageRequest.parse(request);
  return context.stores().transaction(() => {
    const headRevision = rowIn(context, sessionId).revision;
    const actions = requiredActionsIn(context).range(sessionId, afterRevision, limit);
    const last = actions.at(-1)?.ordinal ?? afterRevision;
    return SessionHistory.Page.parse({
      sessionId,
      afterRevision,
      headRevision,
      actions,
      nextRevision: last < headRevision ? last : null,
    });
  });
}

export function stateEffect(action: LedgerAction.Node, label: "outbound" | "state" = "state") {
  const effect = action.effect.value;
  if (effect === null || typeof effect !== "object" || Array.isArray(effect))
    throw new LedgerInvariant({
      operation: "session.stateEffect",
      message: `invalid ${label} action effect`,
    });
  return effect;
}

export function requestStatesPageIn(
  context: SessionKernelContext,
  sessionId?: string,
  cursor = "",
  limit = 256,
) {
  return requiredActionsIn(context)
    .requestStatesPage(sessionId, cursor, limit)
    .map((action) => SessionTransition.Request.parse(stateEffect(action).request));
}

export function requestRowsIn(
  context: SessionKernelContext,
  sessionId?: string,
): SessionTransition.Request[] {
  const requests: SessionTransition.Request[] = [];
  let cursor = "";
  for (;;) {
    const page = requestStatesPageIn(context, sessionId, cursor);
    requests.push(...page);
    if (page.length < 256) return requests;
    cursor = page.at(-1)?.requestId ?? cursor;
  }
}

export function outboundStatesPageIn(
  context: SessionKernelContext,
  sessionId: string,
  cursor = "",
  limit = 256,
) {
  return requiredActionsIn(context)
    .outboundStatesPage(sessionId, cursor, limit)
    .map((action) => SessionTransition.Outbound.parse(stateEffect(action, "outbound").outbound));
}

export function outboundRowsIn(
  context: SessionKernelContext,
  sessionId: string,
): SessionTransition.Outbound[] {
  const outbound: SessionTransition.Outbound[] = [];
  let cursor = "";
  for (;;) {
    const page = outboundStatesPageIn(context, sessionId, cursor);
    outbound.push(...page);
    if (page.length < 256) return outbound;
    cursor = page.at(-1)?.message.messageId ?? cursor;
  }
}

const ReceivedEffect = z.object({
  deliveryKind: Delivery.Kind,
  content: z.string(),
  delivery: z.enum(["steer", "followUp"]).optional(),
});

/**
 * `prompt` actions with a delivered-input payload no delivery row references yet, folded from the
 * chain — there is no input-queue table.
 */
/** The ONE typed owner of the deferred `action` cursor projection. */
const AfterCursorIntent = z.looseObject({ after: z.number().int().nonnegative().optional() });
function afterCursorOf(intent: PlainValue): number | undefined {
  const parsed = AfterCursorIntent.safeParse(intent);
  return parsed.success ? parsed.data.after : undefined;
}

/** Status comes from the same delivery-reference rule the pending read uses. */
export function inputMessagesIn(context: SessionKernelContext, sessionId: string): Delivery.Row[] {
  const pending = new Set(
    requiredActionsIn(context)
      .pendingMessages(sessionId)
      .map((action) => action.id),
  );
  return requiredActionsIn(context)
    .inputMessages(sessionId)
    .map((action, index) => {
      return openDeliveryRow(action, index, {
        status: pending.has(action.id) ? "pending" : "consumed",
      });
    });
}

function openDeliveryRow(
  action: LedgerAction.Node,
  index: number,
  extra: { readonly status: "pending" | "consumed"; readonly after?: number },
): Delivery.Row {
  const effect = ReceivedEffect.parse(action.effect.value);
  return Delivery.Row.parse({
    id: action.id,
    sessionId: action.sessionId,
    kind: effect.deliveryKind,
    content: effect.content,
    origin: action.intent,
    ...(effect.delivery === undefined ? {} : { delivery: effect.delivery }),
    ...extra,
    consumedBy: null,
    consumedAt: null,
    createdAt: action.ts,
    ordinal: index + 1,
  });
}

export function pendingMessagesIn(context: SessionKernelContext, sessionId: string): Delivery.Row[] {
  return requiredActionsIn(context)
    .pendingMessages(sessionId)
    .map((action, index) => {
      const after = afterCursorOf(action.intent.value);
      return openDeliveryRow(action, index, {
        status: "pending",
        ...(after === undefined ? {} : { after }),
      });
    });
}

/** One exact pending set and the chain ordinal it was read through. */
export interface PendingSnapshot { readonly rows: readonly Delivery.Row[]; readonly ordinal: number }

const INPUT_ROW_KINDS: ReadonlySet<string> = new Set(["prompt", "signal", "action"]);
const TailFacts = z.looseObject({
  deliveryKind: z.unknown().optional(),
  deliveryId: z.string().optional().catch(undefined),
  consumedStale: z.array(z.string().nullable().catch(null)).optional().catch(undefined),
});
const tailFacts = (value: PlainValue) => TailFacts.safeParse(value).data ?? {};
const idsOf = (values: readonly (string | null | undefined)[]) => values.filter((id) => typeof id === "string");

function tailFact(action: LedgerAction.Node): { readonly arrival: boolean; readonly consumes: readonly string[] } {
  const intent = tailFacts(action.intent.value);
  if (action.kind === "turn") return { arrival: false, consumes: idsOf(intent.consumedStale ?? []) };
  if (!INPUT_ROW_KINDS.has(action.kind)) return { arrival: false, consumes: [] };
  const kind = tailFacts(action.effect.value).deliveryKind;
  return { arrival: kind !== undefined && kind !== null, consumes: idsOf([intent.deliveryId]) };
}

function tailSince(context: SessionKernelContext, sessionId: string, after: number) {
  const arrived: LedgerAction.Node[] = [];
  const consumed = new Set<string>();
  for (let ordinal = after; ; ) {
    const page = requiredActionsIn(context).range(sessionId, ordinal, 256);
    for (const action of page) {
      const fact = tailFact(action);
      if (fact.arrival) arrived.push(action);
      for (const id of fact.consumes) consumed.add(id);
    }
    ordinal = page.at(-1)?.ordinal ?? ordinal;
    if (page.length < 256) return { arrived, consumed, ordinal };
  }
}

/** pending(head) = pending(since) + arrivals - consumed over (since, head]; without `since`, the full read and its head. */
export function pendingMessagesSinceIn(context: SessionKernelContext, sessionId: string, since?: PendingSnapshot): PendingSnapshot {
  return context.stores().transaction(() => {
    const actions = requiredActionsIn(context);
    if (since === undefined) return { rows: pendingMessagesIn(context, sessionId), ordinal: actions.latestAction(sessionId, Number.MAX_SAFE_INTEGER)?.ordinal ?? 0 };
    const { arrived, consumed, ordinal } = tailSince(context, sessionId, since.ordinal);
    const opened = arrived.map((action, index) => {
      const after = afterCursorOf(action.intent.value);
      return openDeliveryRow(action, index, { status: "pending", ...(after === undefined ? {} : { after }) });
    });
    const rows = [...since.rows, ...opened].filter((row) => !consumed.has(row.id)).map((row, index) => ({ ...row, ordinal: index + 1 }));
    return { rows, ordinal };
  });
}

export function rowIn(context: SessionKernelContext, sessionId: string): LedgerSession.Row {
  const current = requiredSessionsIn(context).get(sessionId);
  if (current === undefined) throw new SessionNotFound({ sessionId });
  return current;
}

export function policyRowsIn(context: SessionKernelContext, generation?: number): PolicyRow.Row[] {
  const policies = context.stores().policies;
  if (policies === undefined) throw new StorageUnavailable({ capability: "policies" });
  return policies.rows(generation);
}


export function turnIntent(
  action: LedgerAction.Node | undefined,
): SessionTurn.DecodeIntent | undefined {
  if (action?.kind !== "turn") return undefined;
  const parsed = SessionTurn.DecodeIntent.safeParse(action.intent.value);
  return parsed.success ? parsed.data : undefined;
}

export function turnResume(
  action: LedgerAction.Node | undefined,
): SessionTurn.DecodeResume | undefined {
  if (action?.kind !== "turn") return undefined;
  const parsed = SessionTurn.DecodeResume.safeParse(action.intent.value);
  return parsed.success ? parsed.data : undefined;
}

export function turnCheckpoint(
  action: LedgerAction.Node | undefined,
): SessionTurn.Checkpoint | undefined {
  if (action?.kind !== "turn") return undefined;
  const parsed = SessionTurn.Checkpoint.safeParse(action.effect.value);
  return parsed.success ? parsed.data : undefined;
}

export function turnTerminal(
  action: LedgerAction.Node | undefined,
): SessionTurn.Terminal | undefined {
  if (action?.kind !== "turn") return undefined;
  const parsed = SessionTurn.Terminal.safeParse(action.effect.value);
  return parsed.success ? parsed.data : undefined;
}

const DELIVERY_KINDS: ReadonlySet<string> = new Set(["prompt", "signal", "action"]);

export function delivery(action: LedgerAction.Node | undefined): SessionTurn.Delivery | undefined {
  if (action === undefined || !DELIVERY_KINDS.has(action.kind)) return undefined;
  const parsed = SessionTurn.Delivery.safeParse(action.effect.value);
  return parsed.success ? parsed.data : undefined;
}

export interface OpenTurn {
  readonly turnId: string;
  readonly resultId: string;
  readonly resumeCount: number;
  readonly boundaryActionId: string | null;
  readonly toolsGeneration: number;
  readonly toolsHash: string;
  readonly systemHash: string;
  readonly policyGeneration: number;
  readonly action: LedgerAction.Node;
}

export function openTurns(actions: readonly LedgerAction.Node[]): OpenTurn[] {
  const opened = new Map<string, OpenTurn>();
  for (const action of actions) {
    const intent = turnIntent(action);
    if (intent !== undefined) {
      opened.set(action.id, {
        turnId: action.id,
        resultId: intent.resultId,
        resumeCount: intent.resumeCount,
        boundaryActionId: intent.boundaryActionId,
        toolsGeneration: intent.toolsGeneration,
        toolsHash: intent.toolsHash,
        systemHash: intent.systemHash,
        policyGeneration: intent.policyGeneration,
        action,
      });
      continue;
    }
    const resume = turnResume(action);
    if (resume !== undefined) {
      const current = opened.get(resume.turnId);
      if (current !== undefined) {
        opened.set(resume.turnId, {
          ...current,
          resultId: resume.resultId,
          resumeCount: resume.resumeCount,
          boundaryActionId: resume.boundaryActionId,
          toolsGeneration: resume.toolsGeneration,
          toolsHash: resume.toolsHash,
          systemHash: resume.systemHash,
          policyGeneration: resume.policyGeneration,
          action,
        });
      }
      continue;
    }
    const checkpoint = turnCheckpoint(action);
    if (checkpoint !== undefined) {
      const current = opened.get(checkpoint.turnId);
      if (current !== undefined) {
        opened.set(checkpoint.turnId, {
          ...current,
          resultId: checkpoint.resultId,
          resumeCount: checkpoint.resumeCount,
          boundaryActionId: checkpoint.boundaryActionId,
          action,
        });
      }
      continue;
    }
    const terminal = turnTerminal(action);
    if (terminal !== undefined) opened.delete(terminal.turnId);
  }
  return [...opened.values()];
}

export function getSnapshotIn(
  context: SessionKernelContext,
  sessionId: string,
  turns = 1,
): SessionTurn.Snapshot {
  if (!Number.isInteger(turns) || turns < 0)
    throw new LedgerInvariant({
      operation: "session.snapshot",
      message: "turn count must be non-negative",
    });
  return context.stores().transaction(() => snapshotFor(context, rowIn(context, sessionId), turns));
}

function snapshotFor(
  context: SessionKernelContext,
  current: LedgerSession.Row,
  turns: number,
): SessionTurn.Snapshot {
  const sessionId = current.id;
  void latestGenerationForIn(requiredActionsIn(context), sessionId);
  const open = latestOpenTurnIn(context, sessionId);
  return SessionTurn.Snapshot.parse({
    id: current.id,
    parentId: current.parentId,
    role: current.role,
    revision: current.revision,
    state: current.state,
    lease: {
      owner: current.fenceOwner,
      fence: current.fence,
    },
    toolsGeneration: current.toolsGeneration,
    systemHash: current.systemHash,
    policyGeneration: current.policyGeneration,
    ...(open === undefined ? {} : { openTurnId: open.turnId }),
    turns: turnTails(context, sessionId, current.revision, turns),
  });
}

export function watchSnapshotIn(
  context: SessionKernelContext,
  sessionId: string,
  turns: number,
  observations: ObservationSink,
): SessionTurn.Watch {
  const subscribeObservation = observations.subscribe;
  if (subscribeObservation === undefined) {
    throw new LedgerInvariant({
      operation: "session.watch",
      message: "session watch requires a subscribable observation sink",
    });
  }
  return context.stores().transaction(() => {
    let revision = 0;
    let closed = false;
    const handlers = new Set<(observation: SessionTurn.Observation) => void>();
    const stop = subscribeObservation(
      L0Observation.ActionCommittedEvent,
      (event) => {
        const observation: SessionTurn.Observation =
          event.revision > revision + 1
            ? { kind: "gap", sessionId, from: revision, to: event.revision }
            : {
                kind: "revision",
                sessionId,
                revision: event.revision,
                actionId: event.id,
                actionKind: event.kind,
              };
        revision = event.revision;
        for (const handler of [...handlers]) handler(observation);
      },
      { match: { sessionId } },
    );
    let snapshot: SessionTurn.Snapshot | undefined;
    try {
      snapshot = getSnapshotIn(context, sessionId, turns);
    } finally {
      if (snapshot === undefined) stop();
    }
    revision = snapshot.revision;
    return {
      snapshot,
      subscribe(handler: (observation: SessionTurn.Observation) => void) {
        if (closed)
          throw new LedgerInvariant({
            operation: "session.watch",
            message: "session watch is unsubscribed",
          });
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
      unsubscribe() {
        if (closed) return;
        closed = true;
        handlers.clear();
        stop();
      },
    };
  });
}


/** Opens after the intent before the newest `count` turns: deliveries precede their intent. */
function turnTails(
  context: SessionKernelContext,
  sessionId: string,
  revision: number,
  count: number,
): SessionTurn.Tail[] {
  if (count === 0) return [];
  const actions = requiredActionsIn(context);
  const fold: TailWindow = { tails: new Map(), pending: new Map() };
  let cursor = actions.turnWindowStart(sessionId, revision + 1, count);
  for (;;) {
    const page = actions.turnTailPage(sessionId, cursor, 256);
    const last = page.at(-1);
    for (const action of page) {
      if (action.ordinal > revision) return [...fold.tails.values()].map(tail);
      foldTailAction(fold, action);
    }
    if (last === undefined || page.length < 256) return [...fold.tails.values()].map(tail);
    cursor = last.ordinal;
  }
}

interface TailWindow {
  readonly tails: Map<string, TailFold>;
  /** Prompt deliveries seen before their turn intent. */
  readonly pending: Map<string, SessionTurn.Message[]>;
}

interface TailFold {
  readonly intent: LedgerAction.Node;
  readonly messages: SessionTurn.Message[];
  terminal?: { readonly action: LedgerAction.Node; readonly effect: SessionTurn.Terminal };
}

// Route by stored phase so only the needed schema parses.
function foldTailAction({ tails, pending }: TailWindow, action: LedgerAction.Node): void {
  const delivered = delivery(action);
  if (delivered !== undefined) {
    if (delivered.kind !== "prompt") return;
    const message = { role: "user" as const, text: delivered.content };
    const open = tails.get(delivered.turnId);
    if (open !== undefined) open.messages.push(message);
    else pending.set(delivered.turnId, [...(pending.get(delivered.turnId) ?? []), message]);
    return;
  }
  if (action.kind !== "turn") return;
  const phase = PlainObjectSchema.parse(action.intent.value).phase;
  if (phase === "intent") {
    tails.set(action.id, { intent: action, messages: pending.get(action.id) ?? [] });
    pending.delete(action.id);
    return;
  }
  if (phase !== "terminal") return;
  const effect = turnTerminal(action);
  if (effect === undefined) return;
  const fold = tails.get(effect.turnId);
  if (fold !== undefined) fold.terminal = { action, effect };
}

function tail({ intent, messages, terminal }: TailFold): SessionTurn.Tail {
  if (terminal !== undefined && terminal.effect.text.length > 0)
    messages.push({ role: "assistant", text: terminal.effect.text });
  return {
    turnId: intent.id,
    startedAt: intent.ts,
    state:
      terminal === undefined
        ? "running"
        : terminal.effect.kind === "interrupted"
          ? "interrupted"
          : "idle",
    messages,
    ...(terminal === undefined
      ? {}
      : {
          terminal: {
            kind: terminal.effect.kind,
            actionId: terminal.action.id,
            at: terminal.action.ts,
          },
        }),
  };
}


export function requiredSessionsIn(context: SessionKernelContext) {
  const adapter = context.stores().sessions;
  if (adapter === undefined) throw new StorageUnavailable({ capability: "sessions" });
  return adapter;
}

export function requiredActionsIn(context: SessionKernelContext) {
  const adapter = context.stores().actions;
  if (adapter === undefined) throw new StorageUnavailable({ capability: "actions" });
  return adapter;
}
