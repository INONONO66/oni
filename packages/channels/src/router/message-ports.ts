import type { Effect } from "effect";
import type { ChannelError } from "../errors";
import type { PolicyEvaluationInput } from "@openomni/agent";
import type {
  BusEvent, Gateway, Ingress, Delivery, LedgerAction, PlainValue, SessionTransition,
} from "@openomni/protocol";
import type { KernelDeliveryReceipt } from "../support/deliver";

export type ChannelDeliveryRoute = (
  externalId: string,
  content: string,
  idempotencyKey: string,
) => Promise<KernelDeliveryReceipt>;

interface MessageExecution {
  readonly kind: "message";
  readonly op: string;
  readonly intent: PlainValue;
  readonly effect: PlainValue;
  readonly message: NonNullable<PolicyEvaluationInput["message"]>;
}

type MessageExecutionResult = { readonly matchedRuleIds: readonly string[] } & (
  | { readonly terminal: "blocked_pre"; readonly reason: string }
  | { readonly terminal: "executed"; readonly value: PlainValue }
  | { readonly terminal: "interrupted" | "outcome_unknown"; readonly reason: string }
  | { readonly terminal: "blocked_post"; readonly reason: string }
);

interface PreparedMessage {
  readonly target: string;
  readonly messageId?: string;
  readonly limits?: { readonly fanout: number; readonly depth: number };
  readonly origin?: Delivery.ReplyOrigin | SessionTransition.OutboundMessage;
  readonly message:
    | Extract<NonNullable<PolicyEvaluationInput["message"]>, { sender: "session" }>
    | { readonly sender: "external"; readonly eventIdUnique: boolean };
  readonly sender?: Delivery.Commit["sender"];
  readonly createSession?: Delivery.Commit["createSession"];
}

type RequestOpenInput = Pick<
  SessionTransition.Request,
  "requestId" | "sessionId" | "correlation" | "resolution" | "threshold" | "deadline"
> & {
  expectedResponders: Readonly<SessionTransition.Request["expectedResponders"]>;
  allowedActions: Readonly<SessionTransition.Request["allowedActions"]>;
  at: number;
  admission?: Delivery.Commit;
};

interface MessagingGrantSources {
  readonly grants: () => readonly Gateway.SenderTargetGrant[];
  readonly budgets?: () => readonly Gateway.SocialBudget[];
}

export interface GatewayRouterPorts {
  /** Every gateway reads records through the same required perimeter store. */
  readonly stores: import("./stores.js").ChannelStores;
  readonly transaction: <A>(operation: Effect.Effect<A, ChannelError>) => Effect.Effect<A, ChannelError>;
  readonly judge?: (question: string, event: Ingress.Input) => Effect.Effect<"yes" | "no" | "unknown", ChannelError>;
  readonly authenticateAnswer?: (
    sender: Gateway.IngestSender & { kind: "external" }, credential: string, requestId: string,
  ) => Effect.Effect<SessionTransition.Principal, ChannelError>;
  readonly requests: {
    list(): readonly SessionTransition.Request[];
    open(input: RequestOpenInput): Effect.Effect<SessionTransition.Request, ChannelError>;
    answer(input: SessionTransition.Answer): Effect.Effect<SessionTransition.Resolution, ChannelError>;
    receipt(input: SessionTransition.DeliveryReceipt): Effect.Effect<SessionTransition.Request, ChannelError>;
  };
  readonly sink: BusEvent.Sink["publish"];
  readonly observe?: (sender: Gateway.IngestSender, observation: Gateway.MessageObservation) => void;
  readonly delivery: { readonly commit: (input: Delivery.Commit) => Effect.Effect<Delivery.Row, ChannelError> };
  readonly prepare: (
    sender: Gateway.IngestSender, message: Gateway.SendMessage, target: string, messageId: string,
  ) => Effect.Effect<PreparedMessage, ChannelError>;
  readonly run: (
    sender: Gateway.IngestSender, request: MessageExecution,
    body: (intent: LedgerAction.Receipt) => Effect.Effect<PlainValue, ChannelError>,
  ) => Effect.Effect<MessageExecutionResult, ChannelError>;
  readonly committed?: (row: Delivery.Row) => void;
  readonly now: () => number;
  readonly id: () => string;
  readonly messaging?: MessagingGrantSources & {
    readonly deliveryRoutes: ReadonlyMap<string, ChannelDeliveryRoute>;
    readonly replyGrantRules?: () => readonly Gateway.ReplyGrantRule[];
  };
}

export interface GatewayRouter {
  advance(at?: number): Effect.Effect<void, ChannelError>;
  ingest(
    sender: Gateway.IngestSender,
    message: Gateway.SendMessage | Gateway.IngressFacts | Gateway.RequestAnswer,
  ): Effect.Effect<Gateway.IngestResult, ChannelError>;
}
