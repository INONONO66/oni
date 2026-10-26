import { canonicalDigest, Delivery, type LedgerAction, type LedgerSession, type SessionTransition } from "@oni/protocol";

export function pendingDeliveryRow(kind: Delivery.Kind, id: string): Delivery.Row {
  return Delivery.Row.parse({
    id,
    sessionId: "s1",
    kind,
    content: [{ kind: "text", text: "payload" }],
    origin: { encodingVersion: 1, value: { channel: "test" } },
    status: "pending",
    consumedBy: null,
    consumedAt: null,
    createdAt: 10,
    ordinal: 1,
  });
}

/** A resident session row `id` leased to owner `kernel` at fence/revision/generation 1 in `state`. */
export function kernelOwnedRow(id: string, state: LedgerSession.State): LedgerSession.Row {
  return {
    id,
    parentId: null,
    role: "resident",
    fenceOwner: "kernel",
    fence: 1,
    revision: 1,
    state,
    toolsGeneration: 1,
    systemHash: "system",
    policyGeneration: 1,
  };
}

/** One pending irreversible "write original" tool invocation node. */
export function invocationNode(input: {
  readonly sessionId: string;
  readonly parentId: string | null;
  readonly domainRevisions?: Record<string, number>;
}): LedgerAction.Node {
  return {
    id: "invocation",
    sessionId: input.sessionId,
    parentId: input.parentId,
    kind: "tool",
    ts: 1,
    ordinal: 1,
    intent: {
      encodingVersion: 1,
      value: {
        phase: "intent",
        op: "write",
        value: { path: "original" },
        effectHash: canonicalDigest({ category: "mutation" }),
        ...(input.domainRevisions === undefined ? {} : { domainRevisions: input.domainRevisions }),
      },
    },
    effect: { encodingVersion: 1, value: { phase: "pending" } },
    irreversible: true,
  };
}

/** An owner's approve answer bound to the pending request. */
export function approvalAnswer(
  pending: SessionTransition.Request,
  inputId: string,
  receivedAt: number,
): SessionTransition.Answer {
  return {
    inputId,
    requestId: pending.requestId,
    sessionId: pending.sessionId,
    receivedAt,
    principal: { kind: "owner", principalId: "owner", evidenceId: "authenticated" },
    bindingDigest: pending.bindingDigest,
    inputHash: pending.inputHash,
    effectHash: pending.effectHash,
    generation: pending.generation,
    toolsHash: pending.toolsHash,
    domainRevisions: pending.domainRevisions,
    decision: "approve",
    allowedAction: "report_result",
    content: "yes",
  };
}

/** The kernel-owned `request.open` command for `pending` at t=20 against `row`'s revision. */
export function openRequestCommand(row: LedgerSession.Row, pending: SessionTransition.Request): SessionTransition.Command {
  return {
    version: 1,
    sessionId: row.id,
    inputId: "open",
    at: 20,
    expectedRevision: row.revision,
    authority: { owner: "kernel", fence: 1 },
    payload: { kind: "request.open", request: pending },
  };
}
