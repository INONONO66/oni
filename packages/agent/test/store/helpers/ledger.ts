import { Database } from "bun:sqlite";
import { Effect, Result } from "effect";
import {
  L0Observation,
  type LedgerAction,
  LedgerSession,
  type ObservationSink,
  type Storage,
} from "@oni/protocol";
import { bootstrapStoreDatabase } from "../../../src/core/store/session-file";
import { SESSION_FILE_SCHEMA } from "../../../src/core/store/session-file";
import { createActions } from "../../../src/core/store/session-file/actions";
import { L0Write } from "../../../src/core/store/session-file";
import type { ObservationPublishFailure } from "../../../src/core/store/storage/sqlite-l0-observation";
import { createSessions } from "../../../src/core/store/storage/sqlite-l0-sessions";
import type { SessionWriteAdapter } from "../../../src/core/store/services";
import { runLedgerSync } from "./effect";

/** In-memory database on the fresh session-file schema. */
export function openLedgerDatabase(): Database {
  const db = new Database(":memory:");
  bootstrapStoreDatabase(db, SESSION_FILE_SCHEMA);
  return db;
}

export interface L0Adapters {
  readonly sessions: SessionWriteAdapter;
  readonly actions: Storage.ActionSubAdapter;
}

/**
 * Session-file adapters over one connection plus a capture of every committed
 * action. Publish failures are captured too (the store drops a throwing port,
 * so a rethrowing port could not make a test fail): assert on `failures`.
 */
export function observedL0Adapters(db: Database): {
  adapter: L0Adapters;
  observations: L0Observation.ActionCommitted[];
  failures: ObservationPublishFailure[];
} {
  const observations: L0Observation.ActionCommitted[] = [];
  const failures: ObservationPublishFailure[] = [];
  const report = (failure: ObservationPublishFailure): void => {
    failures.push(failure);
  };
  const transaction = <T>(operation: () => T): T => db.transaction(operation).immediate();
  const limits = { rowByteCap: L0Write.DEFAULT_ROW_BYTE_CAP };
  const sink: ObservationSink = {
    publish(event, payload) {
      if (event.name === L0Observation.ActionCommittedEvent.name)
        observations.push(L0Observation.ActionCommitted.parse(payload));
    },
  };
  return {
    adapter: {
      sessions: createSessions(db, transaction, sink, report, limits),
      actions: createActions(db, transaction, sink, report, limits),
    },
    observations,
    failures,
  };
}

/** The genesis `session.configure` row every materialized session opens with. */
function genesisAction(sessionId: string, ts = 0): LedgerAction.Append {
  return {
    id: `${sessionId}:configure`,
    parentId: null,
    sessionId,
    kind: "session.configure",
    intent: { encodingVersion: 1, value: {} },
    effect: { encodingVersion: 1, value: {} },
    irreversible: true,
    ts,
  };
}

/** A resident L0 row at revision 0, as `materialize` expects it. */
export function residentRow(id: string): LedgerSession.Row {
  return LedgerSession.Row.parse({
    id,
    parentId: null,
    role: "resident",
    fenceOwner: null,
    fence: 0,
    revision: 0,
    state: "idle",
  });
}

/**
 * Creates `row` through the only creation path (#1351): the genesis
 * configure action lands at revision 1, so callers append from
 * `expectedRevision: 1`. Returns whether the row was created.
 */
export function materializeRow(sessions: SessionWriteAdapter, row: LedgerSession.Row): boolean {
  return Result.getOrThrowWith(
    runLedgerSync(
      Effect.result(sessions.materialize({ row, initialAction: genesisAction(row.id) })),
    ),
    (error) => error,
  ).created;
}
