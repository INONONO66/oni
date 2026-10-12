import { Database } from "bun:sqlite";
import { L0Observation, type ObservationSink, type Storage } from "@openomni/protocol";
import { bootstrapStoreDatabase } from "../../../src/core/store/session-file";
import { SESSION_FILE_SCHEMA } from "../../../src/core/store/session-file";
import { createActions, L0Write } from "../../../src/core/store/session-file";
import type { ObservationPublishFailure } from "../../../src/core/store/storage/sqlite-l0-observation";
import { createSessions } from "../../../src/core/store/storage/sqlite-l0-sessions";
import type { SessionWriteAdapter } from "../../../src/core/store/services";

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
