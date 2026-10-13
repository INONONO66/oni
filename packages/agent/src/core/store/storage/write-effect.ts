import { Effect } from "effect";
import { thrownAsError } from "../../failure";
import { AgentFailure, type LedgerError } from "../errors";

export type RefuseWrite = (error: LedgerError) => never;

/** A refusal must unwind SQLite before it can enter the Effect error channel. */
export function writeEffect<A>(
  operation: string,
  write: (refuse: RefuseWrite) => A,
): Effect.Effect<A, LedgerError> {
  return Effect.suspend(() => {
    let refusal: LedgerError | undefined;
    return Effect.try({
      try: () =>
        write((error) => {
          refusal = error;
          throw error;
        }),
      // The refusal wins over a foreign SQLite throw when one was raised.
      catch: thrownAsError,
    }).pipe(Effect.mapError((cause) => refusal ?? new AgentFailure({ operation, cause })));
  });
}
