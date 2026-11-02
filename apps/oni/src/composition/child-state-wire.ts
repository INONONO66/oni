import { ChildState, parseJson, PlainValueSchema } from "@oni/protocol";
import { type ChildRow, currentState, stateReceipts } from "../bundles/child-activity/reconcile";

/** The parent session's admitted child rows, or `undefined` for a session the catalog does not index. */
export type ChildStateRows = (sessionId: string) => readonly ChildRow[] | undefined;

/** The same fold `childActivity.state` runs, widened with the turn's facts and diagnostics. */
function childStateOf(
  rows: readonly ChildRow[],
  request: Pick<ChildState.Request, "sessionId" | "child" | "turn">,
): Omit<ChildState.Frame, "type" | "requestId"> | undefined {
  const winner = currentState(stateReceipts(rows, request.child, request.turn));
  if (winner === undefined) return undefined;
  const facts = rows.flatMap((row) =>
    row.kind === "child_fact" && row.content.child === request.child && row.content.turn === request.turn
      ? [{ ...(row.content.toolUseId === undefined ? {} : { toolUseId: row.content.toolUseId }), phase: row.content.phase }]
      : [],
  );
  const damaged = rows.flatMap((row) =>
    row.kind === "child_diagnostic" && row.content.child === request.child && row.content.turn === request.turn
      ? [row.content.diagnostic]
      : [],
  );
  return {
    sessionId: request.sessionId,
    child: request.child,
    turn: request.turn,
    phase: winner.fact.phase,
    source: winner.source,
    since: winner.receipt.observedAt,
    facts,
    diagnostics: [...winner.receipt.diagnostics, ...damaged],
  };
}

/** The upgrade gate already authenticated the socket; this read enters no session turn. */
export function childStateWire(data: string | Buffer, rows: ChildStateRows | undefined): ChildState.Response | undefined {
  const document = parseJson(PlainValueSchema, typeof data === "string" ? data : data.toString());
  if (document === null || typeof document !== "object" || Array.isArray(document) || document.type !== "child_state")
    return undefined;
  const request = ChildState.Request.safeParse(document);
  if (!request.success) {
    return {
      type: "child_state_refused",
      requestId: typeof document.requestId === "string" && document.requestId.length > 0 ? document.requestId : "invalid",
      reason: "invalid_request",
      detail: "Invalid child state request",
    };
  }
  const { requestId } = request.data;
  if (rows === undefined)
    return { type: "child_state_refused", requestId, reason: "unavailable", detail: "Child activity is not composed" };
  const admitted = rows(request.data.sessionId);
  if (admitted === undefined)
    return { type: "child_state_refused", requestId, reason: "session_not_found", detail: request.data.sessionId };
  const state = childStateOf(admitted, request.data);
  if (state === undefined)
    return { type: "child_state_refused", requestId, reason: "unknown", detail: "No admitted receipt for this child turn" };
  return { type: "child_state", requestId, ...state };
}
