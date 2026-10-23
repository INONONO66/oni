import { Bus } from "./bus";
import { L0Observation, type SessionTurn } from "@oni/protocol";
import type { TestLedgerPlane as AppLedgerPlane } from "./ledger";
import { eventSignal } from "./event-signal";

/** A model turn completes in the ledger, not through an unsolicited external reply. */
export function nextResidentTurn(plane: AppLedgerPlane, timeoutMs = 10_000): Promise<SessionTurn.Terminal> {
  const signal = eventSignal<SessionTurn.Terminal>("resident terminal", timeoutMs);
  const unsubscribe = Bus.subscribe(L0Observation.ActionCommittedEvent, (event) => {
    if (event.kind !== "turn") return;
    const kernel = plane.openKernel(event.sessionId);
    if (kernel.row(event.sessionId).role !== "resident") return;
    const terminal = kernel.latestTurnTerminal(event.sessionId);
    if (terminal?.action.id === event.id) signal.resolve(terminal.effect);
  });
  return signal.promise.finally(unsubscribe);
}
