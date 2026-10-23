import type { Database } from "bun:sqlite";
import { LedgerAction, type ObservationSink, type Storage as ProtocolStorage } from "@oni/protocol";
import { appendAction, type AppendLimits } from "../storage/sqlite-l0-write.js";
import { reportCommitted, type ObservationFailurePort } from "../storage/sqlite-l0-observation.js";
import { createActionReads } from "./reads";

export function createActions(
  db: Database,
  transaction: <T>(operation: () => T) => T,
  observationSink: ObservationSink,
  onObservationFailure: ObservationFailurePort,
  limits: AppendLimits,
): ProtocolStorage.ActionSubAdapter {
  return {
    ...createActionReads(db, observationSink),
    append(input, expectedRevision) {
      const parsed = LedgerAction.Append.parse(input);
      const receipt = transaction(() => appendAction(db, parsed, expectedRevision, limits));
      if (receipt !== undefined) reportCommitted(db, observationSink, onObservationFailure, receipt);
      return receipt;
    },
  };
}
