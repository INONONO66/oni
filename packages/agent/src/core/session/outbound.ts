import { turnTerminal, turnIntent } from "../store/session-reads";
import { Effect } from "effect";
import { type SessionError, CommitFailed, AgentInvariantViolation } from "../ports/failure";

import type { SessionKernel } from "./entity";
import { type LedgerAction, SessionTransition, canonicalDigest, PlainValueSchema } from "@oni/protocol";
import { fencedExecutionLedger, type ResolvedSessionRuntime, type SessionEntityPorts } from "./runtime";

export function outboundOpen(
  message: SessionTransition.OutboundMessage,
  at: number,
): LedgerAction.Append {
  return {
    id: `${message.sourceActionId}:outbound`,
    parentId: message.sourceActionId,
    sessionId: message.sourceSessionId,
    kind: "message",
    intent: { encodingVersion: 1, value: { op: "open", message: PlainValueSchema.parse(message) } },
    effect: {
      encodingVersion: 1,
      value: {
        outbound: {
          message: PlainValueSchema.parse(message),
          state: "pending",
          destinationReceipt: null,
        },
      },
    },
    ts: at,
    irreversible: true,
  };
}

function toolsGeneration(kernel: SessionKernel, message: SessionTransition.OutboundMessage): number {
  const terminal = turnTerminal(kernel.actionById(message.sourceActionId));
  const intent =
    terminal === undefined
      ? undefined
      : turnIntent(kernel.actionById(terminal.turnId));
  if (intent === undefined) throw new AgentInvariantViolation("outbound original turn is missing");
  return intent.toolsGeneration;
}

function acknowledge(
  message: SessionTransition.OutboundMessage,
  receipt: LedgerAction.Receipt,
  at: number,
): LedgerAction.Append {
  const effect = receipt.action.effect.value;
  const answer =
    effect !== null && typeof effect === "object" && !Array.isArray(effect)
      ? SessionTransition.Answer.safeParse(effect.answer)
      : undefined;
  const payload =
    answer?.success === true && answer.data.outbound !== undefined
      ? PlainValueSchema.parse(answer.data.outbound)
      : receipt.action.intent.value;
  if (
    receipt.action.sessionId !== message.destinationSessionId ||
    canonicalDigest(payload) !== canonicalDigest(PlainValueSchema.parse(message))
  ) {
    throw new AgentInvariantViolation("outbound destination receipt does not match its recorded payload");
  }
  return {
    id: `${message.messageId}:ack`,
    parentId: `${message.sourceActionId}:outbound`,
    sessionId: message.sourceSessionId,
    kind: "message",
    intent: { encodingVersion: 1, value: { op: "ack", messageId: message.messageId } },
    effect: {
      encodingVersion: 1,
      value: {
        outbound: {
          message: PlainValueSchema.parse(message),
          state: "delivered",
          destinationReceipt: { id: receipt.action.id, revision: receipt.revision },
        },
      },
    },
    ts: at,
    irreversible: true,
  };
}

/** The entity's activation redrive over the composed runtime; absent without a receiving consumer. */
export function outboundRedrivePort(
  runtime: ResolvedSessionRuntime,
): SessionEntityPorts["dispatchOutbound"] {
  if (runtime.dispatchOutbound === undefined) return undefined;
  return (input) =>
    dispatchSessionOutbound(input.kernel, input.sessionId, runtime, input.owner, input.fence, input.clock);
}

/** Never seals again or writes a destination session. */
export function dispatchSessionOutbound(
  kernel: SessionKernel,
  sessionId: string,
  runtime: ResolvedSessionRuntime,
  owner: string,
  fence: number,
  clock: () => number,
): Effect.Effect<void, SessionError> {
  return Effect.suspend(() => {
    const ledger = fencedExecutionLedger(kernel, sessionId, owner, fence, clock);
    const commit = (actions: LedgerAction.Append[]) =>
      Effect.forEach(actions, (action) => ledger.commit(action), { discard: true }).pipe(
        Effect.mapError((error) => new CommitFailed({ error })),
      );
    return Effect.forEach(kernel.outboundRows(sessionId), (item) => Effect.scoped(Effect.gen(function* () {
      if (item.state === "delivered") return;
      // The receiver's durable commit is the proof, not a second dispatch. This
      // also works after it consumed the prompt and the sender lost the ACK.
      const received = kernel.outboundReceipt(
        item.message.destinationSessionId, item.message.messageId,
      );
      if (received !== undefined) {
        yield* commit([acknowledge(item.message, received, clock())]);
        return;
      }
      if (runtime.dispatchOutbound === undefined)
        return yield* Effect.die(new Error("outbound receiving consumer is unavailable"));
      const captured = yield* runtime.generations.capture({ sessionId, generation: toolsGeneration(kernel, item.message) });
      const receipt = yield* captured.provide(runtime.dispatchOutbound({
        message: item.message,
        ledger,
      })).pipe(Effect.provide(runtime.services));
      yield* commit([acknowledge(item.message, receipt, clock())]);
    })), { discard: true });
  });
}
