import { Context, Effect } from "effect";
import { Core } from "@oni/agent";
import { APPROVAL_POLICY } from "./policy";
const createExecutor = Core.createExecutor;
const AgentFailure = Core.AgentFailure;
type SessionRuntimeOptions = Core.SessionRuntimeOptions;
import type { GatewayRouter } from "@oni/channels";
import type { LedgerAction } from "@oni/protocol";
import type { SessionReadModel } from "./cluster-runtime";

type OutboundInput = Parameters<NonNullable<SessionRuntimeOptions["dispatchOutbound"]>>[0];
interface OutboundContext {
  readonly input: OutboundInput;
  readonly executor: Effect.Success<ReturnType<typeof createExecutor>>;
  receipt?: LedgerAction.Receipt;
}

export const outboundMessage = Context.Reference<OutboundContext | undefined>("@oni/oni/OutboundMessage", { defaultValue: () => undefined });

/** The gateway admits recorded bytes; the receiver, not this source, owns its delivery queue. */
export function dispatchOutboundMessage(
  ingest: GatewayRouter["ingest"],
  readSession: (sessionId: string) => SessionReadModel,
  approvalPolicy: Core.ApprovalPolicy = APPROVAL_POLICY,
): NonNullable<SessionRuntimeOptions["dispatchOutbound"]> {
  return (input) => Effect.gen(function* () {
    const { message, ledger } = input;
    const source = readSession(message.sourceSessionId);
    // #1346: the source turn's own fenced ledger records the outbound
    // admission; this dispatcher copies no authority and sees no revision.
    const executor = yield* createExecutor({
      approvalPolicy,
      identity: {
        sessionId: message.sourceSessionId,
        role: source.row(message.sourceSessionId).role,
        parentActionId: `${message.sourceActionId}:outbound`,
      },
      ledger,
    });
    const context: OutboundContext = { input, executor };
    return yield* Effect.gen(function* () {
      const admitted = yield* ingest(
        { kind: "session", id: message.sourceSessionId },
        {
          to: { kind: "session", id: message.destinationSessionId },
          type: "message",
          content: message.content,
          replyTo: message.replyTo,
        },
      );
      if (admitted.status === "blocked_pre") return yield* new AgentFailure({ operation: "message.outbound", cause: "outbound gateway admission refused" });
      const receipt =
        context.receipt ??
        readSession(message.destinationSessionId).outboundReceipt(
          message.destinationSessionId,
          message.messageId,
        );
      if (receipt === undefined)
        return yield* Effect.die(new Error("outbound receiving consumer did not commit a receipt"));
      return receipt;
    }).pipe(
      Effect.provideService(outboundMessage, context),
      Effect.mapError((error) => error._tag === "AgentFailure" ? error : new AgentFailure({ operation: "message.outbound", cause: String(error) })),
    );
  });
}
