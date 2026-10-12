import {
  canonicalDigest,
  type ConfigureDisabled,
  ConsumptionSettings,
  Delivery,
  PlainObjectSchema,
  type PlainValue,
  type LedgerAction,
  type LedgerSession,
  L0Observation,
  type PolicyRow,
  SessionGeneration,
  SessionHistory,
  SessionTransition,
  SessionTurn,
  type ObservationSink,
  type Storage as ProtocolStorage,
} from "@openomni/protocol";
import { Effect } from "effect";
import { z } from "zod";
import { LedgerInvariant, SessionNotFound, StorageUnavailable, type LedgerError } from "./errors";
import type { AdoptReceipt, CommitReceipt, SessionWriteAdapter } from "./services";
import type { CatalogStore } from "./catalog.js";
import type { ArmedAlarmRow, SessionStore, ToolOutputRow, ToolOutputWrite, ToolOutputsAdapter } from "./session-file/index.js";
import { armedAlarmDelta } from "./storage/sqlite-l0-write.js";
import { writeEffect } from "./storage/write-effect";
import { GATE_ROW_WRITER_VERSION } from "../gate/rows";

export const RESUME_BUDGET = 10;

/** The storage capabilities one kernel handle reads and writes. */
interface SessionKernelStores {
  transaction<T>(operation: () => T): T;
  readonly sessions?: SessionWriteAdapter;
  readonly actions?: ProtocolStorage.ActionSubAdapter;
  readonly policies?: ProtocolStorage.PolicyRowSubAdapter;
  /** #1254 S3: reads over the session file's durable `armed_alarms` index. */
  readonly armed?: {
    armedAlarms(): readonly ArmedAlarmRow[];
    armedCount(): number;
  };
  /** #1305: content-addressed tool output bytes of the session file. */
  readonly toolOutputs: ToolOutputsAdapter;
}

/**
 * Handle-scoped storage access (W5.2 review F1). `stores()` throws when
 * storage is unreachable — read paths fail closed exactly like the previous
 * process-global reads; write paths refuse with a typed `StorageUnavailable`
 * when a required store is absent.
 */
interface SessionKernelContext {
  stores(): SessionKernelStores;
  readonly childSessionsPage: CatalogStore["childSessionsPage"];
  /** #1254 S3: the catalog `has_armed` flag write (ordering law in `commitIn`). */
  readonly markArmed?: (sessionId: string, armed: boolean) => void;
}

interface GenerationSeed {
  readonly tools: readonly SessionGeneration.Tool[];
  readonly bundles?: readonly string[];
  readonly system: {
    readonly preset: string;
    readonly blocks: readonly SessionGeneration.SystemBlock[];
  };
  readonly policyGeneration: number;
  /** The composed manifest's `Generation.hash` this generation adopts (#1255). */
  readonly manifestHash?: string;
}

export interface MaterializeInput extends GenerationSeed {
  readonly id: string;
  readonly parentId: string | null;
  readonly role: LedgerSession.Role;
  /** Generation settings pinned at genesis (#1253/#1257): widths and fork copy cap. */
  readonly settings?: ConsumptionSettings;
  readonly actionId: string;
  readonly at: number;
}

export type ConfigureAuthority = (input: {
  readonly sessionId: string;
  readonly role: LedgerSession.Role;
  readonly operation: SessionGeneration.ConfigureIntent["operation"];
  readonly generation: number;
}) => boolean | Promise<boolean>;

function materializeIn(
  context: SessionKernelContext,
  input: MaterializeInput,
): Effect.Effect<LedgerSession.MaterializeResult, LedgerError> {
  return writeEffect("session.generation", () =>
    generationSnapshot({
      generation: 1,
      revertTo: 0,
      tools: input.tools,
      bundles: input.bundles,
      system: input.system,
      policyGeneration: input.policyGeneration,
      ...(input.manifestHash === undefined ? {} : { manifestHash: input.manifestHash }),
    }),
  ).pipe(
    Effect.flatMap((snapshot) =>
      sessionWritesIn(context).pipe(
        Effect.flatMap((sessions) => sessions.materialize(materializationSeed(input, snapshot))),
      ),
    ),
  );
}

/** Canonical first materialization payload: the fresh idle row plus its `create` configure action. */
export function materializationSeed(
  input: {
    readonly id: string;
    readonly parentId: string | null;
    readonly role: LedgerSession.Role;
    readonly actionId: string;
    readonly at: number;
    /** Generation settings pinned at genesis (#1253/#1257). */
    readonly settings?: ConsumptionSettings;
  },
  snapshot: SessionGeneration.Snapshot,
): LedgerSession.Materialize {
  return {
    row: {
      id: input.id,
      parentId: input.parentId,
      role: input.role,
      fenceOwner: null,
      fence: 0,
      revision: 0,
      state: "idle",
      toolsGeneration: snapshot.generation,
      systemHash: snapshot.systemHash,
      policyGeneration: snapshot.policyGeneration,
    },
    initialAction: configureAction({
      id: input.actionId,
      sessionId: input.id,
      parentId: null,
      operation: "create",
      snapshot,
      ...(input.settings === undefined ? {} : { settings: input.settings }),
      at: input.at,
    }),
  };
}

function commitIn(
  context: SessionKernelContext,
  input: LedgerSession.Commit,
): Effect.Effect<CommitReceipt, LedgerError> {
  // #1254 S3 catalog intent ordering: flag the session as possibly-armed
  // BEFORE the session transaction that commits an arm (an extra true costs a
  // boot rescan); clear only after a committed batch touched the alarm plane
  // AND the index confirms empty (a premature false would lose recovery).
  const deltas = input.actions.flatMap((action) => {
    const delta = armedAlarmDelta(action);
    return delta === undefined ? [] : [delta];
  });
  return Effect.suspend(() => {
    if (deltas.some((delta) => delta.op === "upsert")) context.markArmed?.(input.sessionId, true);
    return sessionWritesIn(context).pipe(
      Effect.flatMap((sessions) => sessions.commit(input)),
      Effect.tap(() =>
        Effect.sync(() => {
          if (deltas.length === 0) return;
          const armed = context.stores().armed;
          if (armed !== undefined && armed.armedCount() === 0)
            context.markArmed?.(input.sessionId, false);
        }),
      ),
    );
  });
}

/** The seed and its high-water mark belong to the same SQLite read snapshot. */
function latestFoldCheckpointIn(
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

function openTurnsPageIn(
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

function latestOpenTurnIn(context: SessionKernelContext, sessionId: string): OpenTurn | undefined {
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

function resultForIn(context: SessionKernelContext, sessionId: string, parentId: string) {
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

function latestGenerationForIn(
  context: SessionKernelContext,
  sessionId: string,
): SessionGeneration.Snapshot {
  let cursor = Number.MAX_SAFE_INTEGER;
  for (;;) {
    const action = requiredActionsIn(context).configurationActions(sessionId, cursor)[0];
    if (action === undefined)
      throw new LedgerInvariant({
        operation: "session.generation",
        message: "session has no configured generation",
      });
    const snapshot = configurationSnapshot(action);
    if (snapshot !== undefined) return snapshot;
    cursor = action.ordinal;
  }
}

/** `session.configure.settings` carrier (#1253); any configure row may pin the settings. */
const ConfigureSettingsIntent = z.object({ settings: ConsumptionSettings });

/**
 * The latest `session.configure` row carrying parseable `intent.settings`,
 * read newest-first over the configure index (#1347): the commit path reads
 * the checkpoint policy on every batch, so this never pages whole history.
 */
function latestSettingsIn(
  context: SessionKernelContext,
  sessionId: string,
): ConsumptionSettings | undefined {
  let cursor = Number.MAX_SAFE_INTEGER;
  for (;;) {
    const action = requiredActionsIn(context).configurationActions(sessionId, cursor)[0];
    if (action === undefined) return undefined;
    const parsed = ConfigureSettingsIntent.safeParse(action.intent.value);
    if (parsed.success) return parsed.data.settings;
    cursor = action.ordinal;
  }
}

/**
 * Authoritative, bounded read of committed history after `afterRevision`. The
 * row revision and the slice come from one transaction, so a watcher that saw a
 * gap resynchronizes from its last revision without inventing or skipping events.
 */
function historyPageIn(
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

function stateEffect(action: LedgerAction.Node, label: "outbound" | "state" = "state") {
  const effect = action.effect.value;
  if (effect === null || typeof effect !== "object" || Array.isArray(effect))
    throw new LedgerInvariant({
      operation: "session.stateEffect",
      message: `invalid ${label} action effect`,
    });
  return effect;
}

function requestStatesPageIn(
  context: SessionKernelContext,
  sessionId?: string,
  cursor = "",
  limit = 256,
) {
  return requiredActionsIn(context)
    .requestStatesPage(sessionId, cursor, limit)
    .map((action) => SessionTransition.Request.parse(stateEffect(action).request));
}

function requestRowsIn(
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

function outboundStatesPageIn(
  context: SessionKernelContext,
  sessionId: string,
  cursor = "",
  limit = 256,
) {
  return requiredActionsIn(context)
    .outboundStatesPage(sessionId, cursor, limit)
    .map((action) => SessionTransition.Outbound.parse(stateEffect(action, "outbound").outbound));
}

function outboundRowsIn(
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

/** The chain effect one received message committed; the pending fold reads it back. */
const ReceivedEffect = z.object({
  deliveryKind: Delivery.Kind,
  content: z.string(),
  delivery: z.enum(["steer", "followUp"]).optional(),
});

/**
 * Pending-message projection (W5.2): `prompt` actions carrying a delivered-input
 * payload whose id no delivery row references yet, folded from the
 * chain — there is no input-queue table.
 */
/**
 * The `after` cursor a deferred `action` input's intent carries (#1256 H-3),
 * if any — the ONE typed owner of this projection (r3 L-1).
 */
const AfterCursorIntent = z.looseObject({ after: z.number().int().nonnegative().optional() });
function afterCursorOf(intent: PlainValue): number | undefined {
  const parsed = AfterCursorIntent.safeParse(intent);
  return parsed.success ? parsed.data.after : undefined;
}

/**
 * Every input row, consumed or pending (#1257): the SQL projection that
 * replaced the retired whole-history received-message chain fold. Status
 * comes from the
 * same delivery-reference rule the pending read uses.
 */
function inputMessagesIn(context: SessionKernelContext, sessionId: string): Delivery.Row[] {
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

function pendingMessagesIn(context: SessionKernelContext, sessionId: string): Delivery.Row[] {
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

function rowIn(context: SessionKernelContext, sessionId: string): LedgerSession.Row {
  const current = requiredSessionsIn(context).get(sessionId);
  if (current === undefined) throw new SessionNotFound({ sessionId });
  return current;
}

function policyRowsIn(context: SessionKernelContext, generation?: number): PolicyRow.Row[] {
  const policies = context.stores().policies;
  if (policies === undefined) throw new StorageUnavailable({ capability: "policies" });
  return policies.rows(generation);
}

export function latestGeneration(
  actions: readonly LedgerAction.Node[],
): SessionGeneration.Snapshot {
  for (let index = actions.length - 1; index >= 0; index -= 1) {
    const snapshot = configurationSnapshot(actions[index]);
    if (snapshot !== undefined) return snapshot;
  }
  throw new LedgerInvariant({
    operation: "session.generation",
    message: "session has no configured generation",
  });
}

export function generationByNumber(
  actions: readonly LedgerAction.Node[],
  generation: number,
): SessionGeneration.Snapshot | undefined {
  for (let index = actions.length - 1; index >= 0; index -= 1) {
    const snapshot = configurationSnapshot(actions[index]);
    if (snapshot?.generation === generation) return snapshot;
  }
  return undefined;
}

export function generationSnapshot(input: GenerationSeed & {
  readonly generation: number;
  readonly revertTo: number;
}): SessionGeneration.Snapshot {
  assertUniqueTools(input.tools);
  assertUniqueBlocks(input.system.blocks);
  const tools = [...input.tools].sort((left, right) => left.name.localeCompare(right.name));
  const blocks = [...input.system.blocks];
  return SessionGeneration.Snapshot.parse({
    generation: input.generation,
    revertTo: input.revertTo,
    tools,
    toolsHash: canonicalDigest(tools),
    bundles: [...(input.bundles ?? [])].sort(),
    systemPreset: input.system.preset,
    systemBlocks: blocks,
    systemValue: [input.system.preset, ...blocks.map((block) => block.content)]
      .filter((value) => value.length > 0)
      .join("\n\n"),
    systemHash: canonicalDigest(blocks),
    policyGeneration: input.policyGeneration,
    // #1319: every snapshot this writer materializes records the gate-row
    // writer version; snapshots persisted before the cutover stay versionless.
    rowsVersion: GATE_ROW_WRITER_VERSION,
    ...(input.manifestHash === undefined ? {} : { manifestHash: input.manifestHash }),
  });
}

export function configureAction(input: {
  readonly id: string;
  readonly sessionId: string;
  readonly parentId: string | null;
  readonly operation: SessionGeneration.ConfigureIntent["operation"];
  readonly snapshot: SessionGeneration.Snapshot;
  /** `all|one` consumption widths (#1253); present only when the configure pins them. */
  readonly settings?: ConsumptionSettings;
  /** Fork ancestry (#1257); present only on a forked child's genesis configure. */
  readonly forkedFrom?: SessionGeneration.ForkAncestry;
  /** The composed off cascade (#1255); present only when a manifest composed. */
  readonly disabled?: ConfigureDisabled;
  readonly at: number;
}): LedgerAction.Append {
  return {
    id: input.id,
    parentId: input.parentId,
    sessionId: input.sessionId,
    kind: "session.configure",
    intent: {
      encodingVersion: 1,
      value: {
        operation: input.operation,
        ...(input.settings === undefined ? {} : { settings: input.settings }),
        ...(input.forkedFrom === undefined ? {} : { forkedFrom: input.forkedFrom }),
        ...(input.disabled === undefined ? {} : { disabled: input.disabled.map((entry) => ({ ...entry })) }),
      },
    },
    effect: {
      encodingVersion: 1,
      value: {
        phase: "configured",
        snapshot: { ...input.snapshot, bundles: [...input.snapshot.bundles] },
      },
    },
    revert: {
      encodingVersion: 1,
      value: { generation: input.snapshot.revertTo },
    },
    ts: input.at,
  };
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

/** A delivered-input journal row (#1252): prompt/signal/action with a delivery-phase effect. */
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

function getSnapshotIn(
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
  void latestGenerationForIn(context, sessionId);
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

function watchSnapshotIn(
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

function configurationSnapshot(
  action: LedgerAction.Node | undefined,
): SessionGeneration.Snapshot | undefined {
  if (action?.kind !== "session.configure") return undefined;
  const effect = SessionGeneration.ConfigureEffect.safeParse(action.effect.value);
  return effect.success ? effect.data.snapshot : undefined;
}

/**
 * The newest `count` turns: one ascending window opens after the intent preceding them, because
 * deliveries commit before their own turn intent. The window carries the intents themselves.
 */
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
  /** Prompt deliveries seen before their turn intent, keyed by turn id. */
  readonly pending: Map<string, SessionTurn.Message[]>;
}

interface TailFold {
  readonly intent: LedgerAction.Node;
  readonly messages: SessionTurn.Message[];
  terminal?: { readonly action: LedgerAction.Node; readonly effect: SessionTurn.Terminal };
}

/** Route each window row by its stored phase so only the needed schema parses. */
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

function assertUniqueTools(tools: readonly SessionGeneration.Tool[]): void {
  const seen = new Set<string>();
  for (const tool of tools) {
    if (seen.has(tool.name)) {
      throw new SessionGeneration.ConfigureError({
        code: "duplicate_tool",
        message: `duplicate tool name: ${tool.name}`,
      });
    }
    seen.add(tool.name);
  }
}

function assertUniqueBlocks(blocks: readonly SessionGeneration.SystemBlock[]): void {
  const seen = new Set<string>();
  for (const block of blocks) {
    if (seen.has(block.id)) {
      throw new SessionGeneration.ConfigureError({
        code: "duplicate_block",
        message: `duplicate system block id: ${block.id}`,
      });
    }
    seen.add(block.id);
  }
}

function sessionWritesIn(context: SessionKernelContext) {
  return writeEffect("storage.sessions", (refuse) => {
    const sessions = context.stores().sessions;
    if (sessions === undefined) return refuse(new StorageUnavailable({ capability: "sessions" }));
    return sessions;
  });
}

function requiredSessionsIn(context: SessionKernelContext) {
  const adapter = context.stores().sessions;
  if (adapter === undefined) throw new StorageUnavailable({ capability: "sessions" });
  return adapter;
}

function requiredActionsIn(context: SessionKernelContext) {
  const adapter = context.stores().actions;
  if (adapter === undefined) throw new StorageUnavailable({ capability: "actions" });
  return adapter;
}

function requiredArmedIn(context: SessionKernelContext) {
  const adapter = context.stores().armed;
  if (adapter === undefined) throw new StorageUnavailable({ capability: "armed_alarms" });
  return adapter;
}

function makeSessionKernel(context: SessionKernelContext) {
  return {
    materialize: (input: MaterializeInput) => materializeIn(context, input),
    adoptFence: (input: LedgerSession.AdoptFence): Effect.Effect<AdoptReceipt, LedgerError> =>
      sessionWritesIn(context).pipe(Effect.flatMap((sessions) => sessions.adoptFence(input))),
    commit: (input: LedgerSession.Commit) => commitIn(context, input),
    pendingMessages: (sessionId: string): Delivery.Row[] => pendingMessagesIn(context, sessionId),
    /** Ordinal of the latest executed compaction, else 0 — the staleness horizon for `action` inputs (#1256 H-3). */
    compactionHead: (sessionId: string): number =>
      requiredActionsIn(context).latestCompaction(sessionId)?.ordinal ?? 0,
    inputMessages: (sessionId: string): Delivery.Row[] => inputMessagesIn(context, sessionId),
    latestAction: (
      sessionId: string,
      throughRevision = Number.MAX_SAFE_INTEGER,
    ): LedgerAction.Node | undefined =>
      requiredActionsIn(context).latestAction(sessionId, throughRevision),
    latestFoldCheckpoint: (sessionId: string, throughRevision?: number) =>
      latestFoldCheckpointIn(context, sessionId, throughRevision),
    priorModelAttempt: (sessionId: string, turnId: string) =>
      requiredActionsIn(context).priorModelAttempt(sessionId, turnId),
    generationFor: (
      sessionId: string,
      generation: number,
    ): SessionGeneration.Snapshot | undefined =>
      configurationSnapshot(requiredActionsIn(context).generationFor(sessionId, generation)),
    turnTerminalFor: (sessionId: string, turnId: string) =>
      turnTerminal(requiredActionsIn(context).turnTerminalFor(sessionId, turnId)),
    latestTurnTerminal: (sessionId: string) => {
      const action = requiredActionsIn(context).latestTurnTerminal(sessionId);
      const effect = turnTerminal(action);
      return action === undefined || effect === undefined ? undefined : { action, effect };
    },
    turnIntentsPage: (sessionId: string, beforeRevision: number, limit = 256) =>
      requiredActionsIn(context).turnIntentsPage(sessionId, beforeRevision, limit),
    openTurnsPage: (sessionId: string, cursor = 0, limit = 256): OpenTurn[] =>
      openTurnsPageIn(context, sessionId, cursor, limit),
    latestOpenTurn: (sessionId: string): OpenTurn | undefined =>
      latestOpenTurnIn(context, sessionId),
    resultFor: (sessionId: string, parentId: string) => resultForIn(context, sessionId, parentId),
    requestInputById: (sessionId: string, inputId: string) =>
      requiredActionsIn(context).requestInputById(sessionId, inputId),
    guardedOperationsPage: (sessionId: string, turnId: string, cursor = 0, limit = 256) =>
      requiredActionsIn(context).guardedOperationsPage(sessionId, turnId, cursor, limit),
    openOperationsPage: (sessionId: string, turnId: string, cursor = 0, limit = 256) =>
      requiredActionsIn(context).openOperationsPage(sessionId, turnId, cursor, limit),
    operationChildrenPage: (sessionId: string, parentId: string, cursor = 0, limit = 256) =>
      requiredActionsIn(context).operationChildrenPage(sessionId, parentId, cursor, limit),
    actionById: (id: string): LedgerAction.Node | undefined =>
      requiredActionsIn(context).actionById(id),
    latestGenerationFor: (sessionId: string): SessionGeneration.Snapshot =>
      latestGenerationForIn(context, sessionId),
    latestSettings: (sessionId: string): ConsumptionSettings | undefined =>
      latestSettingsIn(context, sessionId),
    /** inputHash is an exact persisted key, not a policy evaluation or JSON-path query API. */
    policyDecisionRuleIds: (sessionId: string, inputHash: string): string[] | undefined =>
      requiredActionsIn(context).policyDecisionRuleIds(sessionId, inputHash),
    messageActionByPlatformId: (
      sessionId: string,
      messageId: string,
    ): LedgerAction.Node | undefined =>
      requiredActionsIn(context).messageActionByPlatformId(sessionId, messageId),
    outboundReceipt: (
      destinationSessionId: string,
      messageId: string,
    ): LedgerAction.Receipt | undefined =>
      requiredActionsIn(context).outboundReceipt(destinationSessionId, messageId),
    verifyChain: (sessionId: string): LedgerAction.ChainVerdict =>
      requiredActionsIn(context).verifyChain(sessionId),
    historyPage: (sessionId: string, request: SessionHistory.PageRequest = {}) =>
      historyPageIn(context, sessionId, request),
    requestStatesPage: (sessionId?: string, cursor = "", limit = 256) =>
      requestStatesPageIn(context, sessionId, cursor, limit),
    requestRows: (sessionId?: string): SessionTransition.Request[] =>
      requestRowsIn(context, sessionId),
    outboundStatesPage: (sessionId: string, cursor = "", limit = 256) =>
      outboundStatesPageIn(context, sessionId, cursor, limit),
    outboundRows: (sessionId: string): SessionTransition.Outbound[] =>
      outboundRowsIn(context, sessionId),
    requestById: (requestId: string): SessionTransition.Request | undefined => {
      const action = requiredActionsIn(context).requestStateById(requestId);
      return action === undefined
        ? undefined
        : SessionTransition.Request.parse(stateEffect(action).request);
    },
    row: (sessionId: string): LedgerSession.Row => rowIn(context, sessionId),
    listRows: (): LedgerSession.Row[] => requiredSessionsIn(context).list(),
    childSessionsPage: (
      sessionId: string,
      afterId: string,
      limit: number,
    ): { readonly id: string }[] => context.childSessionsPage(sessionId, afterId, limit),
    policyRows: (generation?: number): PolicyRow.Row[] => policyRowsIn(context, generation),
    currentPolicyGeneration: (): number =>
      policyRowsIn(context).reduce((latest, policy) => Math.max(latest, policy.generation), 0),
    /** #1254 S3: armed occurrences restored from the session file's durable index. */
    armedAlarms: (): readonly ArmedAlarmRow[] => requiredArmedIn(context).armedAlarms(),
    armedCount: (): number => requiredArmedIn(context).armedCount(),
    /** #1305: content-addressed tool output bytes — dedupe lives in the store's digest key. */
    putToolOutput: (write: ToolOutputWrite): void => context.stores().toolOutputs.put(write),
    toolOutput: (outputId: string): ToolOutputRow | undefined =>
      context.stores().toolOutputs.get(outputId),
    getSnapshot: (sessionId: string, turns = 1): SessionTurn.Snapshot =>
      getSnapshotIn(context, sessionId, turns),
    watchSnapshot: (
      sessionId: string,
      turns: number,
      observations: ObservationSink,
    ): SessionTurn.Watch => watchSnapshotIn(context, sessionId, turns, observations),
  };
}

/** The kernel handle API — exactly the historical module-level surface. */
export type SessionKernel = ReturnType<typeof makeSessionKernel>;

/**
 * Handle-scoped kernel factory (W5.2 review F1): session facts (row, chain,
 * snapshots) come from one per-session store; policy rows come from the
 * catalog. There is no input-queue table — `pendingMessages` folds the pending
 * projection straight from the action chain.
 */
export function createSessionKernel(session: SessionStore, catalog: CatalogStore): SessionKernel {
  return makeSessionKernel({
    stores: () => ({
      transaction: session.transaction,
      sessions: session.sessions,
      actions: session.actions,
      policies: catalog.policies,
      armed: { armedAlarms: session.armedAlarms, armedCount: session.armedCount },
      toolOutputs: session.toolOutputs,
    }),
    childSessionsPage: (parentId, afterId, limit) =>
      catalog.childSessionsPage(parentId, afterId, limit),
    markArmed: (sessionId, armed) => catalog.markArmed(sessionId, armed),
  });
}
