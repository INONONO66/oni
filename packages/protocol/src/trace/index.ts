/** 32 lowercase hex characters (W3C trace id). */
type TraceId = string;

/** Pure codec from the caller's UUID entropy into the existing W3C wire shape. */
export function traceIdFromUuid(uuid: string): TraceId {
  return uuid.split("-").join("");
}

/**
 * #499: the correlation-header field set. `traceId`/`parentSpanId` correspond
 * to the W3C `traceparent` trace-id / parent-id fields; `sessionId`, `runId`,
 * and `agentName` are Oni correlation dimensions (agentName is
 * load-bearing at the ingress/dispatch/run seams). This is protocol-owned and
 * deliberately NOT merged with telemetry's TraceScope (different owner
 * package); the two must stay field-compatible on the traceparent pair.
 */
export namespace TraceContext {
  // A plain type, not a Zod schema: every consumer propagates this
  // structurally (no runtime validation seam exists), so a schema here
  // would be dead runtime weight.
  export type Type = {
    traceId: string;
    sessionId?: string | undefined;
    runId?: string | undefined;
    agentName?: string | undefined;
    parentSpanId?: string | undefined;
  };
}
