import type { Effect } from "effect";
import { runTestSync } from "../../helpers/isolated";

/** The only synchronous test-side runner for ledger programs; failures surface as thrown errors (delegates to the agent runner owner). */
export function runLedgerSync<A, E>(program: Effect.Effect<A, E>): A {
  return runTestSync(program);
}
