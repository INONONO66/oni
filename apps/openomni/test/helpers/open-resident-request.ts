import type { planeOf } from "./ledger";

/** Finds the current resident's open Owner-consent request, when it has one. */
export function openResidentRequest(
  plane: Awaited<ReturnType<typeof planeOf>>,
  sessionId: string | undefined,
) {
  if (sessionId === undefined) return undefined;
  return plane.openKernel(sessionId).requestRows(sessionId).find((request) => request.state === "open");
}
