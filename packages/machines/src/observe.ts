import type { Ipc, Machine } from "@oni/protocol";

const OBSERVE_CONTRACT_VERSION = 3;

export const OBSERVE_NOT_AVAILABLE = { status: "refused", reason: "observe_not_available", message: "the attached client predates contract 3" } as const;

export function answersObservation(offer: Machine.Offer): boolean {
  return offer.peer.contractVersion >= OBSERVE_CONTRACT_VERSION;
}

/**
 * `request` as a contract-2 peer reads it: the capture form flattened, the
 * element form `undefined` because that peer cannot observe.
 */
export function legacyPointer(request: Machine.InputPointerRequest): Ipc.Request["params"] | undefined {
  const { at, delivery: _delivery, requestId: _requestId, ...gesture } = request;
  return "captureId" in at ? { ...gesture, ...at } : undefined;
}

export function observeRefusal(grant: "permission_denied" | "not_available"): Machine.ScreenObserveResult {
  return { status: "refused", reason: grant === "permission_denied" ? grant : "observe_not_available" };
}
