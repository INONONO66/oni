import { z } from "zod";
import { PlainValueSchema } from "../json.js";
import { EpochMs } from "../time.js";

const Id = z.string().min(1);
const DomainRevisions = z.record(Id, z.number().int());

/** Commands describe an original action; there is no separate request store. */
export namespace SessionTransition {
  export const Correlation = z
    .object({
      endpointId: Id.optional(),
      channelId: Id.optional(),
      replyToMessageId: Id.optional(),
      chain: z.array(Id).optional(),
      threadId: Id.optional(),
      tokenHash: Id.optional(),
      externalConversationId: Id.optional(),
    })
    .strict();
  export type Correlation = z.infer<typeof Correlation>;

  export const AllowedAction = z.enum([
    "report_result",
    "ask_clarification",
    "attach_artifact",
    "decline_task",
  ]);
  export type AllowedAction = z.infer<typeof AllowedAction>;

  export const Principal = z
    .object({
      kind: z.enum(["owner", "actor", "session"]),
      principalId: Id,
      evidenceId: Id,
    })
    .strict();
  export type Principal = z.infer<typeof Principal>;

  export const Reply = z
    .object({
      replyId: Id,
      responderId: Id,
      content: z.string(),
      receivedAt: EpochMs,
    })
    .strict();
  export type Reply = z.infer<typeof Reply>;

  export const Request = z
    .object({
      requestId: Id,
      sessionId: Id,
      turnId: Id.nullable(),
      callId: Id,
      mode: z.enum(["approval", "answer"]),
      parsedInput: PlainValueSchema,
      inputHash: Id,
      effectHash: Id,
      generation: z.number().int().nonnegative(),
      toolsGeneration: z.number().int().nonnegative(),
      toolsHash: Id,
      systemHash: Id,
      domainRevisions: DomainRevisions,
      deadline: EpochMs,
      expectedResponders: z.array(Id).min(1),
      correlation: Correlation,
      allowedActions: z.array(AllowedAction).min(1),
      bindingDigest: Id,
      resolution: z.enum(["first", "quorum", "all"]),
      threshold: z.number().int().positive(),
      seenReplyIds: z.array(Id),
      replies: z.array(Reply),
      state: z.enum(["open", "resolved", "refused", "expired", "cancelled"]),
      outcome: z.enum(["answered", "outcome_unknown", "denied", "cancelled"]).nullable(),
      createdAt: EpochMs,
    })
    .strict()
    .superRefine((request, context) => {
      const count = request.expectedResponders.length;
      const threshold =
        request.resolution === "all"
          ? count
          : request.resolution === "first"
            ? 1
            : request.threshold;
      if (
        new Set(request.expectedResponders).size !== count ||
        request.threshold !== threshold ||
        threshold > count
      ) {
        context.addIssue({
          code: "custom",
          path: ["threshold"],
          message: "inconsistent responder threshold",
        });
      }
      const outcomes = {
        open: null,
        resolved: "answered",
        refused: "denied",
        expired: "outcome_unknown",
        cancelled: "cancelled",
      } as const;
      if (request.outcome !== outcomes[request.state]) {
        context.addIssue({
          code: "custom",
          path: ["outcome"],
          message: "request state and outcome disagree",
        });
      }
    });
  export type Request = z.infer<typeof Request>;

  export const OutboundMessage = z
    .object({
      messageId: Id,
      sourceSessionId: Id,
      sourceActionId: Id,
      destinationSessionId: Id,
      requestId: Id,
      replyTo: Id,
      terminal: z.enum(["completed", "error", "interrupted"]),
      content: z.string(),
      /** Loop-consumption boundary the receiver folds the row at (#1311); absent folds to the `followUp` default. */
      delivery: z.enum(["steer", "followUp"]).optional(),
      digest: Id,
    })
    .strict();
  export type OutboundMessage = z.infer<typeof OutboundMessage>;

  export const Answer = z
    .object({
      inputId: Id,
      requestId: Id,
      sessionId: Id,
      receivedAt: EpochMs,
      principal: Principal,
      bindingDigest: Id,
      inputHash: Id,
      effectHash: Id,
      generation: z.number().int().nonnegative(),
      toolsHash: Id,
      domainRevisions: DomainRevisions,
      decision: z.enum(["answer", "approve", "refuse"]),
      allowedAction: AllowedAction,
      content: z.string(),
      outbound: OutboundMessage.optional(),
    })
    .strict();
  export type Answer = z.infer<typeof Answer>;

  export const DeliveryReceipt = z
    .object({
      inputId: Id,
      requestId: Id,
      sessionId: Id,
      sourceActionId: Id,
      externalMessageId: Id.optional(),
      value: z.enum(["accepted", "rejected", "unknown"]),
      at: EpochMs,
    })
    .strict();
  export type DeliveryReceipt = z.infer<typeof DeliveryReceipt>;

  export const Outbound = z
    .object({
      message: OutboundMessage,
      state: z.enum(["pending", "delivered"]),
      destinationReceipt: z
        .object({ id: Id, revision: z.number().int().positive() })
        .strict()
        .nullable(),
    })
    .strict()
    .refine((value) => (value.state === "pending") === (value.destinationReceipt === null), {
      message: "outbound acknowledgement requires a destination receipt",
    });
  export type Outbound = z.infer<typeof Outbound>;

  export const Payload = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("request.open"), request: Request }).strict(),
    z.object({ kind: z.literal("request.answer"), answer: Answer }).strict(),
    z.object({ kind: z.literal("request.timeout"), requestId: Id }).strict(),
    z.object({ kind: z.literal("request.cancel"), requestId: Id, principal: Principal }).strict(),
    z.object({ kind: z.literal("request.delivery"), receipt: DeliveryReceipt }).strict(),
  ]);
  export type Payload = z.infer<typeof Payload>;

  export const Command = z
    .object({
      version: z.literal(1),
      inputId: Id,
      sessionId: Id,
      at: EpochMs,
      expectedRevision: z.number().int().nonnegative(),
      authority: z.object({ owner: Id, fence: z.number().int().positive() }).strict(),
      payload: Payload,
    })
    .strict();
  export type Command = z.infer<typeof Command>;

  export const Resolution = z.enum([
    "opened",
    "attached",
    "resolved",
    "refused",
    "expired",
    "cancelled",
    "late_unknown",
    "rejected",
    "duplicate",
    "delivery_recorded",
  ]);
  export type Resolution = z.infer<typeof Resolution>;
}
