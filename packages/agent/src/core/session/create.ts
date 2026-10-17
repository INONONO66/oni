import { generationSnapshot, materializationSeed, type MaterializeInput } from "../store/configure";
import { Effect } from "effect";
import type { LedgerAction, LedgerSession } from "@openomni/protocol";
import type { LedgerPlane } from "./host";
import { thrownAsError } from "../ports/failure";
import { CreateRefused, type LedgerError } from "../store/errors";


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

/** A fault before commit leaves neither side discoverable. */
export function createSession(
  plane: Pick<LedgerPlane, "catalog" | "sessionStore"> & Partial<Pick<LedgerPlane, "discardSession">>,
  input: CreateSessionInput,
): Effect.Effect<SessionReceipt, CreateRefused> {
  return Effect.gen(function* () {
    const { id, parentId, role, genesis } = input;
    const refuse = (cause: Error | LedgerError): CreateRefused =>
      cause instanceof CreateRefused ? cause : new CreateRefused({ sessionId: id, reason: "write", cause });
    const snapshot = yield* Effect.try({
      try: () =>
        generationSnapshot({
          generation: 1,
          revertTo: 0,
          tools: genesis.tools,
          bundles: genesis.bundles,
          system: genesis.system,
          policyGeneration: genesis.policyGeneration,
          ...(genesis.manifestHash === undefined ? {} : { manifestHash: genesis.manifestHash }),
        }),
      catch: (thrown) => refuse(thrownAsError(thrown)),
    });
    const materialize = materializationSeed(
      {
        id,
        parentId,
        role,
        actionId: genesis.actionId,
        at: genesis.at,
        ...(genesis.settings === undefined ? {} : { settings: genesis.settings }),
      },
      snapshot,
    );
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
