import { z } from "zod";
import { LedgerInvariant } from "../errors";
import { parsePlainJson } from "../json";
import type { Database } from "bun:sqlite";
import { Gateway, Delivery, type LedgerAction, PlainValueSchema, SessionTransition, L0Observation, type ObservationSink, } from "@openomni/protocol";

/** A post-commit observation publish that failed without unwinding the committed write. */
export interface ObservationPublishFailure {
  readonly actionId: string;
  readonly cause: Error;
}

/** Routes an observation publish failure; the composing host logs it in its own runtime. */
export type ObservationFailurePort = (failure: ObservationPublishFailure) => void;

/**
 * Publishes one committed receipt and routes a publish failure to the port.
 * Both run after the transaction committed, so neither may unwind the write:
 * a port that throws has refused the last report channel there is, and that
 * second failure is dropped so the committed result still reaches the caller.
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

/**
 * Post-commit observation must never unwind the committed write, so a publish
 * failure is returned as a value for the store's failure port — never thrown
 * and never silently swallowed here.
 */
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

/**
 * The thrown sink value as an Error. Both `instanceof` (a revoked Proxy) and
 * `String()` (the value's own conversion) may throw again; the fallback names
 * only its `typeof`, so no user-controlled code runs on the post-commit path
 * after this point.
 */
export function thrownAsError<T>(cause: T): Error {
  try {
    return cause instanceof Error ? cause : new Error(String(cause));
  } catch {
    return new Error(`sink threw an unrepresentable ${typeof cause}`);
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
