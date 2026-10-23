import { generationSnapshot, materializationSeed, type MaterializeInput } from "../store/configure";
import { Effect } from "effect";
import type { LedgerAction, LedgerSession } from "@oni/protocol";
import type { LedgerPlane } from "./host";
import { thrownAsError } from "../ports/failure";
import { CreateRefused, type LedgerError } from "../store/errors";
import { sessionIdProblem } from "./session-id";


export { CreateRefused };

export interface CreateSessionInput {
  readonly id: string;
  readonly parentId: string | null;
  readonly role: LedgerSession.Role;
  readonly genesis: Omit<MaterializeInput, "id" | "parentId" | "role">;
}

export interface SessionReceipt {
  readonly row: LedgerSession.Row;
  readonly genesis: LedgerAction.Receipt;
}

/** Prepare genesis for admission and creation without opening a store. */
export function prepareSession(input: CreateSessionInput) {
  const { id, parentId, role, genesis } = input;
  const { tools, bundles, system, policyGeneration, manifestHash, ...identity } = genesis;
  return materializationSeed({ id, parentId, role, ...identity }, generationSnapshot({
    generation: 1, revertTo: 0, tools, bundles, system, policyGeneration,
    ...(manifestHash === undefined ? {} : { manifestHash }),
  }));
}

/** Pre-commit faults leave neither side discoverable; later catalog faults strand the file and retry as `duplicate`. */
export function createSession(
  plane: Pick<LedgerPlane, "catalog" | "sessionStore"> & Partial<Pick<LedgerPlane, "discardSession">>,
  input: CreateSessionInput,
): Effect.Effect<SessionReceipt, CreateRefused> {
  return Effect.gen(function* () {
    const { id, genesis } = input;
    const refuse = (cause: Error | LedgerError): CreateRefused =>
      cause instanceof CreateRefused ? cause : new CreateRefused({ sessionId: id, reason: "write", cause });
    const idProblem = sessionIdProblem(id);
    if (idProblem !== undefined)
      return yield* new CreateRefused({ sessionId: id, reason: "invalid_id", cause: new Error(idProblem) });
    const materialize = yield* Effect.try({
      try: () => prepareSession(input),
      catch: (thrown) => refuse(thrownAsError(thrown)),
    });
    const store = yield* Effect.try({
      try: () => plane.sessionStore(id),
      catch: (thrown) => refuse(thrownAsError(thrown)),
    });
    const created = yield* store
      .create({ materialize, index: plane.catalog, createdAt: genesis.at })
      .pipe(
        Effect.tapError(() => Effect.sync(() => plane.discardSession?.(id))),
        Effect.mapError(refuse),
      );
    return { row: created.row, genesis: created.receipt };
  });
}
