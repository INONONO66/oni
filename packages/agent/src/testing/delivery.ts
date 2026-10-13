import type { Delivery } from "@openomni/protocol";
import { Effect } from "effect";
import { receivedMessageAction } from "../core/journal/commit";
import type { SessionKernel } from "../core/session/entity";
import { adoptSessionAuthority } from "../core/session/run";
import { CorruptRecord, type LedgerError } from "../core/store/errors";

/**
 * A fixture's cluster-free delivery: the received-message action lands on the
 * destination chain under the core's fence fold (a running destination lends
 * its live fence, an idle one is taken over), idempotent on the row id.
 * Test-only; it backs no admission claim — that is `Deliver`.
 */
export function localDelivery(
  kernel: SessionKernel,
  input: Delivery.Commit,
  owner: string,
  clock: () => number,
): Effect.Effect<number, LedgerError> {
  return Effect.gen(function* () {
    const existing = kernel.actionById(input.id);
    if (existing !== undefined) return existing.ordinal;
    const live = kernel.row(input.sessionId);
    const authority =
      live.state === "running" && live.fenceOwner !== null
        ? { owner: live.fenceOwner, fence: live.fence }
        : { owner, fence: yield* adoptSessionAuthority(kernel, input.sessionId, owner) };
    const row = kernel.row(input.sessionId);
    const committed = yield* kernel.commit({
      sessionId: input.sessionId,
      owner: authority.owner,
      fence: authority.fence,
      now: clock(),
      expectedRevision: row.revision,
      actions: [receivedMessageAction({ ...input, at: input.createdAt })],
      state: row.state,
    });
    const receipt = committed.receipts[0];
    if (receipt === undefined) return yield* new CorruptRecord({ operation: "ledger.commit", id: input.id });
    return receipt.action.ordinal;
  });
}
