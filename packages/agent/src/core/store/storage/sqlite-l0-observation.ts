import { z } from "zod";
import { LedgerInvariant } from "../errors";
import { thrownAsError } from "../../ports/failure";
import { parsePlainJson } from "./sqlite-l0-rows";
import type { Database } from "bun:sqlite";
import { Gateway, Delivery, type LedgerAction, PlainValueSchema, SessionTransition, L0Observation, type ObservationSink, } from "@openomni/protocol";

export interface ObservationPublishFailure {
  readonly actionId: string;
  readonly cause: Error;
}

/** The composing host logs it in its own runtime. */
export type ObservationFailurePort = (failure: ObservationPublishFailure) => void;

/**
 * Both run after commit, so neither may unwind the write; a throwing port has refused the last
 * report channel and that second failure is dropped.
 */
export function reportCommitted(
  db: Database,
  sink: ObservationSink,
  port: ObservationFailurePort,
  receipt: LedgerAction.Receipt,
): void {
  const failure = publishCommitted(db, sink, receipt);
  if (failure === undefined) return;
  try {
    port(failure);
  } catch {
    // The port was the last channel; the write is committed and stands.
  }
}

/** Returned as a value for the failure port — never thrown, never silently swallowed. */
export function publishCommitted(
  db: Database,
  sink: ObservationSink,
  receipt: LedgerAction.Receipt,
): ObservationPublishFailure | undefined {
  try {
    sink.publish(L0Observation.ActionCommittedEvent, {
      id: receipt.action.id,
      sessionId: receipt.action.sessionId,
      revision: receipt.revision,
      kind: receipt.action.kind,
    });
    publishMessageTerminal(db, sink, receipt.action);
    return undefined;
  } catch (cause) {
    return { actionId: receipt.action.id, cause: thrownAsError(cause) };
  }
}

function publishMessageTerminal(
  db: Database,
  sink: ObservationSink,
  action: LedgerAction.Node,
): void {
  const scoped = sink.scope?.({ sessionId: action.sessionId }) ?? sink;
  if (action.kind === "request" && action.id.endsWith(":resolution")) {
    const effect = action.effect.value;
    if (effect === null || typeof effect !== "object" || Array.isArray(effect)) return;
    const request = SessionTransition.Request.parse(effect.request);
    if (request.mode === "answer" && request.state === "expired") {
      const source = requestMessageIdentity(db, request.requestId, action.sessionId);
      scoped.publish(Gateway.MessageObserved, {
        kind: "message.timed_out",
        messageId: source.messageId,
        waitedMs: Math.max(0, action.ts - request.createdAt),
      });
    }
    return;
  }
  if (action.kind !== "prompt") return;
  const native = SessionTransition.OutboundMessage.safeParse(action.intent.value);
  const external = Delivery.ReplyOrigin.safeParse(action.intent.value);
  const binding = native.success
    ? { requestId: native.data.requestId, replyTo: native.data.replyTo }
    : external.success
      ? { requestId: external.data.sourceActionId, replyTo: external.data.replyTo }
      : undefined;
  if (binding === undefined) return;
  const source = requestMessageIdentity(db, binding.requestId, action.sessionId);
  scoped.publish(Gateway.MessageObserved, {
    kind: "message.replied",
    messageId: source.messageId,
    replyTo: binding.replyTo,
    roundTripMs: Math.max(0, action.ts - source.ts),
  });
}

function requestMessageIdentity(
  db: Database,
  id: string,
  sessionId: string,
): { messageId: string; ts: number } {
  const source = z
    .object({ intent: z.string(), ts: z.number() })
    .nullable()
    .parse(
      db.query("SELECT intent, ts FROM action WHERE id = ? AND session_id = ?").get(id, sessionId),
    );
  if (source === null)
    throw new LedgerInvariant({
      operation: "observation.replySource",
      message: "committed reply source is missing",
    });
  const intent = PlainValueSchema.parse(parsePlainJson(source.intent));
  const value =
    intent !== null && typeof intent === "object" && !Array.isArray(intent)
      ? intent.value
      : undefined;
  const messageId =
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof value.messageId === "string"
      ? value.messageId
      : id;
  return { messageId, ts: source.ts };
}
