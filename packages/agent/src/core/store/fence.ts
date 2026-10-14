import { type ConsumptionSettings, type Delivery, type LedgerAction, type LedgerSession, type ObservationSink, type PolicyRow, type SessionGeneration, type SessionHistory, SessionTransition, type SessionTurn, type Storage as ProtocolStorage } from "@openomni/protocol";
import { Effect } from "effect";
import type { CatalogStore } from "./catalog.js";
import { configurationSnapshot, generationSnapshot, latestGenerationForIn, latestSettingsIn, materializationSeed, type MaterializeInput } from "./configure";
import { StorageUnavailable, type LedgerError } from "./errors";
import { latestFoldCheckpointIn, openTurnsPageIn, latestOpenTurnIn, resultForIn, historyPageIn, stateEffect, requestStatesPageIn, requestRowsIn, outboundStatesPageIn, outboundRowsIn, inputMessagesIn, pendingMessagesIn, rowIn, policyRowsIn, getSnapshotIn, watchSnapshotIn, requiredSessionsIn, requiredActionsIn, turnTerminal, type OpenTurn } from "./session-reads";
import type { AdoptReceipt, CommitReceipt, SessionWriteAdapter } from "./services";
import type { ArmedAlarmRow } from "./session-file/alarms";
import type { SessionStore } from "./session-file/index.js";
import type { ToolOutputRow, ToolOutputWrite, ToolOutputsAdapter } from "./session-file/outputs";
import { armedAlarmDelta } from "./storage/sqlite-l0-write.js";
import { writeEffect } from "./storage/write-effect";

export const RESUME_BUDGET = 10;

interface SessionKernelStores {
  transaction<T>(operation: () => T): T;
  readonly sessions?: SessionWriteAdapter;
  readonly actions?: ProtocolStorage.ActionSubAdapter;
  readonly policies?: ProtocolStorage.PolicyRowSubAdapter;
  readonly armed?: {
    armedAlarms(): readonly ArmedAlarmRow[];
    armedCount(): number;
    strikeArmedAlarm(occurrenceId: string): number | undefined;
    requeueArmedAlarm(occurrenceId: string, at: number): boolean;
  };
  readonly toolOutputs: ToolOutputsAdapter;
}

/**
 * `stores()` throws when storage is unreachable so reads fail closed; writes refuse with a typed
 * `StorageUnavailable` when a required store is absent.
 */
export interface SessionKernelContext {
  stores(): SessionKernelStores;
  readonly childSessionsPage: CatalogStore["childSessionsPage"];
  /** Ordering law in `commitIn`. */
  readonly markArmed?: (sessionId: string, armed: boolean) => void;
}


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

function commitIn(
  context: SessionKernelContext,
  input: LedgerSession.Commit,
): Effect.Effect<CommitReceipt, LedgerError> {
  // Flag possibly-armed BEFORE the arming transaction (an extra true costs a
  // rescan); clear only after a committed batch touched the alarm plane AND
  // the index confirms empty (a premature false would lose recovery).
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

function sessionWritesIn(context: SessionKernelContext) {
  return writeEffect("storage.sessions", (refuse) => {
    const sessions = context.stores().sessions;
    if (sessions === undefined) return refuse(new StorageUnavailable({ capability: "sessions" }));
    return sessions;
  });
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
    /** The staleness horizon for `action` inputs; 0 when nothing executed. */
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
    /** Payload bytes of the rows after `afterRevision` through `throughRevision`: the writer's tail measure. */
    payloadBytes: (sessionId: string, afterRevision: number, throughRevision: number): number =>
      requiredActionsIn(context).payloadBytes(sessionId, afterRevision, throughRevision),
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
      latestGenerationForIn(requiredActionsIn(context), sessionId),
    latestSettings: (sessionId: string): ConsumptionSettings | undefined =>
      latestSettingsIn(requiredActionsIn(context), sessionId),
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
    armedAlarms: (): readonly ArmedAlarmRow[] => requiredArmedIn(context).armedAlarms(),
    armedCount: (): number => requiredArmedIn(context).armedCount(),
    /** One consumed delivery attempt; undefined once the row is retired. */
    strikeArmedAlarm: (occurrenceId: string): number | undefined =>
      requiredArmedIn(context).strikeArmedAlarm(occurrenceId),
    requeueArmedAlarm: (occurrenceId: string, at: number): boolean =>
      requiredArmedIn(context).requeueArmedAlarm(occurrenceId, at),
    /** : content-addressed tool output bytes — dedupe lives in the store's digest key. */
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

export type SessionKernel = ReturnType<typeof makeSessionKernel>;

/** Session facts from the session store, policy rows from the catalog; backlog folds the chain. */
export function createSessionKernel(session: SessionStore, catalog: CatalogStore): SessionKernel {
  return makeSessionKernel({
    stores: () => ({
      transaction: session.transaction,
      sessions: session.sessions,
      actions: session.actions,
      policies: catalog.policies,
      armed: {
        armedAlarms: session.armedAlarms,
        armedCount: session.armedCount,
        strikeArmedAlarm: session.strikeArmedAlarm,
        requeueArmedAlarm: session.requeueArmedAlarm,
      },
      toolOutputs: session.toolOutputs,
    }),
    childSessionsPage: (parentId, afterId, limit) =>
      catalog.childSessionsPage(parentId, afterId, limit),
    markArmed: (sessionId, armed) => catalog.markArmed(sessionId, armed),
  });
}
