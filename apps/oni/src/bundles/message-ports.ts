import type { Effect } from "effect";
import type { ChannelError } from "@oni/channels";
import type { PolicyEvaluationInput } from "@oni/agent";
import type {
  BusEvent, Channel, Gateway, Ingress, Delivery, LedgerAction, Outbound, PlainValue, SessionTransition,
} from "@oni/protocol";
import type { KernelDeliveryReceipt } from "@oni/channels";

export interface ChannelDeliveryRoute extends Channel.Instance {
  readonly deliver: (
    externalId: string,
    payload: Outbound.Payload,
    idempotencyKey: string,
    conversation?: Gateway.Conversation,
    sender?: Gateway.IngestSender,
  ) => Promise<KernelDeliveryReceipt>;
}

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
  /** The reply door's candidate (#1569): the conversation the named prompt came from, folded by the app; the router verifies it. */
  readonly binding?: ConversationBinding;
  /**
   * #1569: the app's authenticated fact that this turn originates from an
   * Owner-tier prompt — what admits a send `as: owner`. Absent means no.
   */
  readonly ownerOrigin?: boolean;
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
  readonly stores: import("@oni/channels").ChannelStores;
  readonly transaction: <A>(operation: Effect.Effect<A, ChannelError>) => Effect.Effect<A, ChannelError>;
  readonly judge?: (question: string, event: Ingress.Message) => Effect.Effect<"yes" | "no" | "unknown", ChannelError>;
  readonly authenticateAnswer?: (
    sender: Gateway.IngestSender & { kind: "external" }, credential: string, requestId: string,
  ) => Effect.Effect<SessionTransition.Principal, ChannelError>;
  readonly requests: {
    list(): readonly SessionTransition.Request[];
    open(input: RequestOpenInput): Effect.Effect<SessionTransition.Request, ChannelError>;
    answer(
      input: SessionTransition.Answer,
      context?: { readonly surfaceKey: string; readonly machineId?: string },
    ): Effect.Effect<SessionTransition.Resolution | "self_approval_suspected", ChannelError>;
    receipt(input: SessionTransition.DeliveryReceipt): Effect.Effect<SessionTransition.Request, ChannelError>;
  };
  readonly sink: BusEvent.Sink["publish"];
  readonly observe?: (sender: Gateway.IngestSender, observation: Gateway.MessageObservation) => void;
  /** Composed Session entity delivery; never a raw session-store writer. */
  readonly deliver: (input: Delivery.Commit) => Effect.Effect<Delivery.Row, ChannelError>;
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

  };
}

export interface GatewayRouter {
  advance(at?: number): Effect.Effect<void, ChannelError>;
  ingest(
    sender: Gateway.IngestSender,
    message: Gateway.SendMessage | Ingress.Message | Gateway.RequestAnswer,
    context?: { readonly surfaceKey: string; readonly machineId?: string },
  ): Effect.Effect<Gateway.IngestResult, ChannelError>;
}

/** The conversation a delivered prompt came from, as the app folds it from the prompt's recorded origin. */
export interface ConversationBinding {
  readonly surface: string;
  readonly instance?: string;
  readonly externalId: string;
  /** Empty for an anonymous sender admitted by a channel default. */
  readonly actorId: string;
  readonly workspaceId?: string;
  readonly channelId: string;
  readonly messageId: string;
  readonly dm: boolean;
  readonly threadId?: string;
  /** The account identity that observed the prompt. */
  readonly receivedBy?: Channel.Identity;
  readonly reply?: "auto" | "draft" | "none";
  readonly as?: string;
}
