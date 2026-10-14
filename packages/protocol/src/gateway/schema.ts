import { z } from "zod";
import { BusEvent } from "../bus/index.js";
import { Actor } from "../actor/index.js";
import { Events as IngressEvents } from "../event/ingress.js";
import { Ingress } from "../ingress/index.js";
import { SessionTransition } from "../ledger/session-transition.js";
import { EpochMs } from "../time.js";
import { MessageContract } from "./message.js";
import { Outbound } from "./outbound.js";

/**
 * Gateway contracts (docs/gateway-design.md §2, stage 0 — #706).
 *
 * The gateway (`@openomni/channels` after stage 2) and the brain
 * and app brain do not import each other; these schemas are the injected seam.
 *
 * Trust vocabulary (§3): *perimeter trust* — who may reach us / whom we may
 * reach (admission, grants, request correlation, egress budget) — is
 * gateway-owned and arrives in `ActorContext` as a verdict the brain consumes
 * verbatim. *Conduct trust* — what the agent may do once running (tool
 * policy, completion admission, evidence) — is brain-owned and never crosses
 * this seam. Schemas only: evaluation of either plane lives above protocol.
 */

/** Taint root for injection defense: where the content physically entered. */
const OriginSchema = z
  .object({
    surface: z.string().min(1),
    externalId: z.string().min(1),
  })
  .strict();

/**
 * The perimeter verdict attached to every delivery. `actorId` is absent for
 * anonymous senders admitted via a channel defaultTier. The brain consumes
 * `trustTier`/`inboundTreatment` verbatim (perimeter output = conduct input)
 * and frames `evidence_only` turns as evidence, never as user commands.
 */
const DeliveredTreatmentSchema = z.enum(["full_access", "evidence_only"]);

const ActorContextSchema = z
  .object({
    actorId: z.string().min(1).optional(),
    trustTier: Actor.TrustTier,
    /**
     * Narrower than Actor.InboundTreatment on purpose: "drop" means the
     * message was never delivered, so a Deliver stamped drop must be
     * unrepresentable at this seam.
     */
    inboundTreatment: DeliveredTreatmentSchema,
    origin: OriginSchema,
  })
  .strict();

/**
 * Present iff this delivery resumed an open request. The expected-responder
 * gate (§2a-1) has already run perimeter-side: a correlated message from a
 * non-responder is delivered WITHOUT requestContext — attachment is itself the
 * perimeter's assertion that the sender may resume this request.
 */
const RequestContextSchema = z
  .object({
    requestId: z.string().min(1),
    allowedAction: SessionTransition.AllowedAction,
  })
  .strict();

/**
 * The routed inbound event as it crosses the seam (#707 stage-2, measured at
 * cut): the driver-produced event AFTER perimeter routing (actor resolution,
 * channel-grant treatment stamping, request/session pinning). Agent
 * configuration is brain material and is resolved by the brain's Deliver
 * consumer, never embedded at the perimeter (an embedded `agent` key is
 * stripped at parse). This is the execution-authoritative residue for this
 * stage; the sibling `actorContext` field is the §2a verdict projection of
 * the same delivery.
 */
const DeliveredEventSchema = Ingress.DirectEventSchema;

/**
 * Inbound contract: gateway → brain.
 *
 * Stage-2 measurement corrections to the stage-0 draft (#707):
 * - `sessionId` is optional — it is the gateway's routed session label
 *   (request-owner / surface-map / router-minted). Child-target deliveries
 *   carry no label: work placement (child session selection) is brain
 *   judgment (kernel-contract §8.5), so the brain resolves it from the
 *   pinned event.
 * - `actorContext` is optional — present for surface-default admissions
 *   (where the perimeter produced a tier verdict); absent for request
 *   resumptions (admission is the correlation itself, asserted via
 *   `requestContext`) and for legacy anonymous surfaces without an origin id.
 * - `event` + `decision` carry the routed event residue and the recorded
 *   route.decided fact — the brain parses all three at the seam.
 */
const DeliverSchema = z
  .object({
    sessionId: z.string().min(1).optional(),
    actorContext: ActorContextSchema.optional(),
    requestContext: RequestContextSchema.optional(),
    event: DeliveredEventSchema,
    /** The recorded route.decided fact this delivery executes (record-before-act). */
    decision: IngressEvents.RoutingDecision.schema,
  })
  .strict();

// Outbound vocabulary. The consuming router lives in
// `packages/channels/src/router/messaging`; grant *evaluation* stays above
// protocol (forbidden here per the contract boundary) and only the shapes
// live at the seam.

const MessageOperationSchema = z.enum(["fire_and_forget", "awaited"]);

/**
 * Policy-intent axis of a send (#219), coherent with — but not collapsed into
 * — the request axis (`operation`). `converse` intends a reply loop (⟺ awaited);
 * `notify` is a one-way ping (⟺ fire_and_forget). Kept a SEPARATE field so the
 * active-egress gate can reason about intent (class caps, future escalation rungs)
 * without overloading `operation`, whose only job is whether a request opens.
 */
const MessageClassSchema = z.enum(["notify", "converse"]);

/**
 * Explicit target: always one existing actor; an optional endpoint pin
 * disambiguates actors reachable at more than one endpoint, and an optional
 * surface narrows resolution to that channel's endpoint (#1485; the pin wins
 * when both are given). No broadcast or wildcard form — resolution yields
 * exactly one delivery address or a typed denial.
 */
/**
 * Where on the actor's surface a message lands: the channel (chat) it was
 * written in, the thread inside it, and the message it answers. Delivery
 * posts there instead of opening the actor's direct channel.
 */
const ConversationSchema = z
  .object({
    channelId: z.string().min(1),
    threadId: z.string().min(1).optional(),
    replyToMessageId: z.string().min(1).optional(),
  })
  .strict();

const MessageTargetSchema = z
  .object({
    actorId: z.string().min(1),
    endpointId: z.string().min(1).optional(),
    surface: z.string().min(1).optional(),
    conversation: ConversationSchema.optional(),
  })
  .strict();

const SenderTargetGrantSchema = z
  .object({
    id: z.string().min(1),
    senderId: z.string().min(1),
    targetActorId: z.string().min(1),
    operations: z.array(MessageOperationSchema).min(1),
    expiresAt: EpochMs.optional(),
    /** Present iff this grant was materialized from a ReplyGrantRule — the provenance link that makes `maxLiveInstances` countable. */
    ruleId: z.string().min(1).optional(),
    /** Perimeter-fact scope of a materialized instance: replies stay inside the initiating container. */
    replyScope: z
      .object({ surfaceKey: z.string().min(1) })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((grant, ctx) => {
    // A rule-materialized instance is always bounded: containment + expiry
    // are what distinguish it from an Owner-written standing grant.
    if (grant.ruleId !== undefined) {
      if (grant.replyScope === undefined) {
        ctx.addIssue({
          code: "custom",
          message: "a rule-materialized grant requires replyScope (perimeter containment)",
          path: ["replyScope"],
        });
      }
      if (grant.expiresAt === undefined) {
        ctx.addIssue({
          code: "custom",
          message: "a rule-materialized grant requires expiresAt (instanceTtlMs bound)",
          path: ["expiresAt"],
        });
      }
    } else if (grant.replyScope !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "replyScope without ruleId — reply containment has no owning rule",
        path: ["ruleId"],
      });
    }
  });

/**
 * Owner-written rule row from which the gateway mechanically materializes
 * reply-scoped SenderTargetGrant instances for first-contact initiators on
 * the covered channel (§2b). Instances are scoped by perimeter facts only
 * (initiator actorId + originating thread/surfaceKey + `instanceTtlMs`);
 * `maxLiveInstances` bounds grant farming by mass first contact.
 */
const ReplyGrantRuleSchema = z
  .object({
    id: z.string().min(1),
    senderId: z.string().min(1),
    surface: z.string().min(1),
    workspace: z.string().min(1).optional(),
    channel: z.string().min(1).optional(),
    operations: z.array(MessageOperationSchema).min(1),
    instanceTtlMs: z.number().int().positive(),
    maxLiveInstances: z.number().int().positive(),
    createdBy: z.string().min(1),
    createdAt: EpochMs.optional(),
    updatedAt: EpochMs.optional(),
  })
  .strict();

/**
 * Typed denial taxonomy — callers branch on `code`, never message text.
 * Ungranted, missing, stale, and ambiguous targets all fail closed with an
 * unchanged allocation/authority surface. `request_duplicate` is the
 * awaited-delivery exactly-once rule surfacing as a denial.
 */
const MessageDenialCodeSchema = z.enum([
  "ungranted",
  "target_missing",
  "target_stale",
  "target_ambiguous",
  "request_duplicate",
  // #219 active-egress suppressions: a granted, resolvable send the social
  // budget refuses — window/class cap hit (or no Owner-declared budget for a
  // cold proactive send), within cooldown/quiet-hours, or do-not-contact.
  "budget_exhausted",
  "cooldown_suppressed",
  "dnc_denied",
]);

/**
 * Owner-declared active-egress budget for proactive outreach to ONE target
 * actor (#219). It governs HOW OFTEN the persona may cold-contact a target;
 * authority (MAY I contact at all) stays the SenderTargetGrant's job, evaluated
 * first. Replies (reply-scoped grant instances) are never throttled by this.
 *
 * Semantics: at most `maxPerWindow` admitted sends per rolling `windowMs`, at
 * least `cooldownMs` between sends, optional per-class sub-caps, an optional
 * daily quiet-hours blackout (UTC minute-of-day), a hard `doNotContact` kill
 * switch, and an optional `expiresAt` after which the allowance lapses (and the
 * fail-safe default re-applies: cold proactive is capped at zero).
 */
const SocialBudgetSchema = z
  .object({
    id: z.string().min(1),
    targetActorId: z.string().min(1),
    maxPerWindow: z.number().int().positive(),
    windowMs: z.number().int().positive(),
    cooldownMs: z.number().int().nonnegative(),
    classCaps: z
      .object({
        notify: z.number().int().nonnegative().optional(),
        converse: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
    quietHours: z
      .object({
        startMinuteUtc: z.number().int().min(0).max(1439),
        endMinuteUtc: z.number().int().min(0).max(1439),
      })
      .strict()
      .optional(),
    doNotContact: z.boolean().optional(),
    expiresAt: EpochMs.optional(),
  })
  .strict();

/**
 * One durable debit row: an ADMITTED proactive send (#219). Recorded
 * record-before-act when a send is admitted (never when suppressed), so split
 * outreach across separate calls cannot evade the cap and the cooldown clock
 * survives a restart. The gateway router is the sole writer (perimeter domain).
 */
const EgressDebitRowSchema = z
  .object({
    id: z.string().min(1),
    senderId: z.string().min(1),
    targetActorId: z.string().min(1),
    class: MessageClassSchema,
    at: EpochMs,
  })
  .strict();

/**
 * The read projection the store folds from the debit rows for one
 * (sender, target) pair over a window — the pure evaluator's only debit input.
 * `lastSendAt` is window-independent (the cooldown clock runs off the most
 * recent admitted send regardless of window).
 */
const EgressDebitStateSchema = z
  .object({
    countInWindow: z.number().int().nonnegative(),
    notifyInWindow: z.number().int().nonnegative(),
    converseInWindow: z.number().int().nonnegative(),
    lastSendAt: EpochMs.optional(),
  })
  .strict();

/**
 * The request an awaited delivery opens. Quorum/resolution-policy coherence is
 * NOT re-refined here — `SessionTransition.Request.parse` in kernel authority is the one
 * enforcement layer for that invariant (#215 rule 4).
 */
const RequestSpecSchema = z
  .object({
    requestId: z.string().min(1),
    sessionId: z.string().min(1),
    allowedActions: z.array(SessionTransition.AllowedAction).min(1),
    expectedResponders: z.array(z.string().min(1)).min(1),
    resolution: z.enum(["first", "quorum", "all"]),
    threshold: z.number().int().positive(),
    deadline: EpochMs,
    /** Extra correlation fields (threadId, channelId, …); endpointId and replyToMessageId are derived from the delivery itself. */
    correlation: SessionTransition.Correlation.optional(),
  })
  .strict();

const SendInputBase = z
  .object({
    /** Outbound message identity: is the stable physical idempotency key; requestId is the original action id. */
    messageId: z.string().min(1),
    /** The sender flow's trace: every event this send leaves files under it. */
    traceId: z.string().min(1),
    senderId: z.string().min(1),
    target: MessageTargetSchema,
    operation: MessageOperationSchema,
    payload: Outbound.Payload,
    /** Injected timestamp — messaging never reads the wall clock. */
    at: EpochMs,
    requestSpec: RequestSpecSchema.optional(),
    /**
     * #219 policy-intent axis, additive-optional for backward compat. Absent →
     * defaults from `operation` (notify for fire_and_forget, converse for
     * awaited). Present → must stay coherent with `operation` (refined below).
     */
    class: MessageClassSchema.optional(),
  })
  .strict();

const SendInputSchema = SendInputBase.superRefine((input, ctx) => {
  if (input.operation === "awaited" && input.requestSpec === undefined) {
    ctx.addIssue({
      code: "custom",
      message: "awaited operation requires a requestSpec",
      path: ["requestSpec"],
    });
  }
  if (input.operation === "fire_and_forget" && input.requestSpec !== undefined) {
    ctx.addIssue({
      code: "custom",
      message: "fire_and_forget never opens a request — requestSpec is not allowed",
      path: ["requestSpec"],
    });
  }
  // The two axes stay coherent without collapsing: converse ⟺ awaited,
  // notify ⟺ fire_and_forget. Absent class is inferred from operation, so
  // only an explicitly-incoherent pairing is rejected.
  if (input.class === "converse" && input.operation !== "awaited") {
    ctx.addIssue({
      code: "custom",
      message: 'class "converse" requires operation "awaited" (a converse intends a reply loop)',
      path: ["class"],
    });
  }
  if (input.class === "notify" && input.operation !== "fire_and_forget") {
    ctx.addIssue({
      code: "custom",
      message: 'class "notify" requires operation "fire_and_forget" (a notify awaits nothing)',
      path: ["class"],
    });
  }
});

export namespace Gateway {
  /** The `send_message` wire shape consumed by the channels router and the `send_message` tool. */
  export const SendMessage = MessageContract.Send;
  export type SendMessage = z.infer<typeof SendMessage>;
  /** The `to` variants a model may address by session; the actor variant stays gateway-only. */
  export const SessionTarget = MessageContract.SessionTarget;
  export const NewSessionTarget = MessageContract.NewSessionTarget;

  export const RequestAnswer = MessageContract.RequestAnswer;
  export type RequestAnswer = z.infer<typeof RequestAnswer>;

  export const SendMessageHandle = MessageContract.Handle;
  export type SendMessageHandle = z.infer<typeof SendMessageHandle>;

  export const IngestSender = MessageContract.Sender;
  export type IngestSender = z.infer<typeof IngestSender>;

  export const IngressFacts = MessageContract.IngressFacts;
  export type IngressFacts = z.infer<typeof IngressFacts>;

  export const IngestResult = MessageContract.Result;
  export type IngestResult = z.infer<typeof IngestResult>;

  export const RuleTableA = MessageContract.RuleTableA;
  export type RuleTableA = z.infer<typeof RuleTableA>;

  export const RuleTableB = MessageContract.RuleTableB;
  export type RuleTableB = z.infer<typeof RuleTableB>;

  export const DelegationResult = MessageContract.DelegationResult;
  export type DelegationResult = z.infer<typeof DelegationResult>;

  export const MessageObservation = MessageContract.Observation;
  export type MessageObservation = z.infer<typeof MessageObservation>;
  export const MessageObserved = BusEvent.define("message.observed", MessageObservation, {
    visibility: "ephemeral",
  });

  export const Origin = OriginSchema;
  export type Origin = z.infer<typeof OriginSchema>;

  export const ActorContext = ActorContextSchema;
  export type ActorContext = z.infer<typeof ActorContextSchema>;

  export const RequestContext = RequestContextSchema;
  export type RequestContext = z.infer<typeof RequestContextSchema>;

  export const DeliveredEvent = DeliveredEventSchema;
  export type DeliveredEvent = z.infer<typeof DeliveredEventSchema>;

  export const Deliver = DeliverSchema;
  export type Deliver = z.infer<typeof DeliverSchema>;

  export const MessageOperation = MessageOperationSchema;
  export type MessageOperation = z.infer<typeof MessageOperationSchema>;

  export const MessageClass = MessageClassSchema;
  export type MessageClass = z.infer<typeof MessageClassSchema>;

  export const Conversation = ConversationSchema;
  export type Conversation = z.infer<typeof ConversationSchema>;

  export const MessageTarget = MessageTargetSchema;
  export type MessageTarget = z.infer<typeof MessageTargetSchema>;

  export const SenderTargetGrant = SenderTargetGrantSchema;
  export type SenderTargetGrant = z.infer<typeof SenderTargetGrantSchema>;

  export const ReplyGrantRule = ReplyGrantRuleSchema;
  export type ReplyGrantRule = z.infer<typeof ReplyGrantRuleSchema>;

  export const SocialBudget = SocialBudgetSchema;
  export type SocialBudget = z.infer<typeof SocialBudgetSchema>;

  export const EgressDebitRow = EgressDebitRowSchema;
  export type EgressDebitRow = z.infer<typeof EgressDebitRowSchema>;

  export const EgressDebitState = EgressDebitStateSchema;
  export type EgressDebitState = z.infer<typeof EgressDebitStateSchema>;

  export const MessageDenialCode = MessageDenialCodeSchema;
  export type MessageDenialCode = z.infer<typeof MessageDenialCodeSchema>;

  export const RequestSpec = RequestSpecSchema;
  export type RequestSpec = z.infer<typeof RequestSpecSchema>;

  export const SendInput = SendInputSchema;
  export type SendInput = z.infer<typeof SendInputSchema>;

  /** The one allocated delivery address a target resolves to; `conversation` names where on it to post. */
  export type DeliveryTarget = Readonly<{
    actorId: string;
    endpointId: string;
    channel: string;
    externalId: string;
    conversation?: Conversation;
  }>;

  /**
   * Deterministic send receipt. `sent`/`denied` and the denial code are the
   * audit facts; a `request` is present exactly when the operation was awaited.
   */
  export type SendReceipt =
    | Readonly<{
        kind: "sent";
        operation: "fire_and_forget";
        delivery: "accepted" | "rejected" | "unknown";
        messageId: string;
        senderId: string;
        grantId: string;
        target: DeliveryTarget;
        at: number;
      }>
    | Readonly<{
        kind: "sent";
        operation: "awaited";
        delivery: "accepted" | "rejected" | "unknown";
        messageId: string;
        senderId: string;
        grantId: string;
        target: DeliveryTarget;
        request: SessionTransition.Request;
        at: number;
      }>
    | Readonly<{
        kind: "denied";
        code: MessageDenialCode;
        messageId: string;
        senderId: string;
        targetActorId: string;
        reason: string;
        at: number;
      }>;
}
