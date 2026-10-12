/**
 * The one session creation door (#1346): genesis configure row and catalog
 * index commit together, through the store's enclosed write unit. Callers
 * supply identity and the composed genesis; the kernel's fence rules and the
 * existing materialization seed stay the authority over what is written.
 */
import { Effect } from "effect";
import type { LedgerAction, LedgerSession } from "@openomni/protocol";
import type { LedgerPlane } from "./host";
import { CreateRefused } from "./store/errors";
import { generationSnapshot, materializationSeed, type MaterializeInput } from "./store/fence";

export { CreateRefused };

export interface CreateSessionInput {
  readonly id: string;
  readonly parentId: string | null;
  readonly role: LedgerSession.Role;
  /** The composed genesis: generation seed, pinned settings, and the configure action identity. */
  readonly genesis: Omit<MaterializeInput, "id" | "parentId" | "role">;
}

export interface SessionReceipt {
  readonly row: LedgerSession.Row;
  /** The durable genesis `session.configure` receipt. */
  readonly genesis: LedgerAction.Receipt;
}

/**
 * Creates one session: the genesis row and its catalog index land in one
 * enclosed write, so a fault before commit leaves neither side discoverable.
 * A duplicate id on either plane refuses typed without rewriting genesis.
 */
export function createSession(
  plane: Pick<LedgerPlane, "catalog" | "sessionStore">,
  input: CreateSessionInput,
): Effect.Effect<SessionReceipt, CreateRefused> {
  return Effect.gen(function* () {
    const { id, parentId, role, genesis } = input;
    const refuse = (cause: unknown) =>
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
      catch: refuse,
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
    const created = yield* plane
      .sessionStore(id)
      .create({ materialize, index: plane.catalog })
      .pipe(Effect.mapError(refuse));
    return { row: created.row, genesis: created.receipt };
  });
}
