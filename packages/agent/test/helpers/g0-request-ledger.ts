import { fencedExecutionLedger } from "./execution-reads";
import { fencedTurnFixture, fencedTurnIdentity } from "./fenced-writer";
import { isolatedLedger } from "./isolated";
import { Effect } from "effect";
import type { SessionKernel } from "../../src/core/session/entity";
import type { ExecutionLedger } from "../../src/core/loop/executor";

export function requestLedger(input: {
  readonly id: string;
  readonly clock?: () => number;
  readonly kernel?: SessionKernel;
}) {
  return Effect.gen(function* () {
    const kernel = input.kernel ?? isolatedLedger().kernel;
    const { id } = input;
    const clock = input.clock ?? (() => 100);
    const { owner, fence, generation, turnId } = yield* fencedTurnFixture(kernel, { id, clock });
    const ledger: ExecutionLedger = fencedExecutionLedger(kernel, id, { owner, fence }, clock);
    return { ledger, identity: fencedTurnIdentity(id, turnId, generation) };
  });
}
