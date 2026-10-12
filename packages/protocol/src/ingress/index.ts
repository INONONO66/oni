import { z } from "zod";
import { PlainValueSchema } from "../json.js";
import { Actor } from "../actor/index.js";
import {
  Events as EventDescriptors,
  recordedRoutingDecision as recordedRoutingDecisionReader,
  type RoutingDecisionPayload as RoutingDecisionPayloadType,
} from "../event/ingress.js";
import { SessionTransition } from "../ledger/session-transition.js";
import * as RouteRecord from "./route-record.js";
import { Input as InputSchema } from "./input.js";
import * as AutomationSchemas from "./automation.js";

/**
 * #500 A6: every production-written actor key is declared (`runId` and
 * `agentName` land from the dispatch resident seam; the rest were already
 * typed). The catchall stays as the historical inbound-tolerance seam for
 * external events — no production producer writes undeclared keys today, and
 * the actor vocabulary reshape itself is deferred to gateway stage 2 (#707).
 */
const ActorSchemaImpl = z
  .object({
    id: z.string().optional(),
    actorId: z.string().optional(),
    role: z.string().optional(),
    kind: z.string().optional(),
    type: z.string().optional(),
    trustTier: Actor.TrustTier.optional(),
    standing: Actor.Standing.optional(),
    endpointId: z.string().optional(),
    endpoint: Actor.Endpoint.optional(),
    sessionId: z.string().optional(),
    runId: z.string().optional(),
    agentName: z.string().optional(),
    isResident: z.boolean().optional(),
    isMain: z.boolean().optional(),
  })
  .catchall(z.unknown());

/**
 * The one executable delivery kind (#1315): `resident`, optionally pinned to
 * a session. The retired subordinate-target string form is a typed parse
 * failure now; a delivered-to-child input rides a session-pinned target. The
 * catchall keeps the historical tolerance for extra inbound keys.
 */
const RawTargetSchema = z
  .object({
    kind: z.literal("resident"),
    sessionId: z.string().min(1).optional(),
    parentSessionId: z.string().min(1).optional(),
  })
  .catchall(PlainValueSchema);

const LegacyTargetSchema = z
  .object({
    type: z.string(),
    kind: z.undefined().optional(),
  })
  .catchall(PlainValueSchema);

// Named generic preprocessor: z.preprocess's inline callback parameter would
// be contextually typed `unknown`; a generic parameter carries no top type.
function normalizeTargetInput<Input>(input: Input) {
  if (input === "resident") return { kind: "resident" };
  const legacyTarget = LegacyTargetSchema.safeParse(input);
  if (legacyTarget.success) {
    const { type, ...rest } = legacyTarget.data;
    return { ...rest, kind: type };
  }
  return input;
}

const TargetSchemaImpl = z.preprocess(normalizeTargetInput, RawTargetSchema);

/** The inbound sender identity a channel driver carries (Channel.InboundMessage.sender). */
const SenderMetaSchema = z
  .object({ id: z.string(), name: z.string().optional() })
  .catchall(z.unknown());

/**
 * batch ② commit 2 (#500 A6 pattern): the production-written meta keys read
 * for AUTHORIZATION (inboundTreatment, channelGrant*, correlation) and for
 * the projection/audit path (surfaceKey, kind, sender, threadId, replyToId,
 * agentName) are declared as typed optional fields instead of
 * riding the untyped `.catchall(z.unknown())`. The catchall is RETAINED for
 * the external DirectEventSchema.parse boundary: a channel driver may attach
 * arbitrary per-platform escape-hatch keys — genuinely unknown, never an
 * authorization input. meta is in-process on InboundEvent and never persisted.
 */
const MetaSchemaImpl = z
  .object({
    actor: ActorSchemaImpl.optional(),
    target: TargetSchemaImpl.optional(),
    inboundTreatment: Actor.InboundTreatment.optional(),
    channelGrantId: z.string().optional(),
    channelGrantKind: Actor.ChannelGrantKind.optional(),
    surfaceKey: z.string().optional(),
    kind: z.string().optional(),
    sender: SenderMetaSchema.optional(),
    threadId: z.string().optional(),
    replyToId: z.string().optional(),
    agentName: z.string().optional(),
    correlation: SessionTransition.Correlation.optional(),
  })
  .catchall(z.unknown());

export namespace Ingress {
  export const Input = InputSchema;
  export type Input = z.infer<typeof Input>;

  export const WindowSeconds = AutomationSchemas.WindowSeconds;
  export type WindowSeconds = z.infer<typeof WindowSeconds>;
  export const Trigger = AutomationSchemas.Trigger;
  export type Trigger = z.infer<typeof Trigger>;
  export const Conditions = AutomationSchemas.Conditions;
  export type Conditions = z.infer<typeof Conditions>;
  export const Automation = AutomationSchemas.Automation;
  export type Automation = z.infer<typeof Automation>;
  export const TriggerContext = AutomationSchemas.TriggerContext;
  export type TriggerContext = z.infer<typeof TriggerContext>;

  export const ActorSchema = ActorSchemaImpl;
  export type Actor = z.infer<typeof ActorSchema>;

  export const TargetSchema = TargetSchemaImpl;
  export type Target = z.infer<typeof TargetSchema>;

  export const MetaSchema = MetaSchemaImpl;
  export type Meta = z.infer<typeof MetaSchema>;

  const InboundEventBase = {
    id: z.string(),
    /** D11: minted once at the producer's first frame (channel surface, cron fire, dispatch command) — ingress inherits, never re-mints. */
    traceId: z.string(),
    surface: z.string(),
    channel: z.string().optional(),
    workspace: z.string().optional(),
    userId: z.string().optional(),
    /** Payload is optional because ingress accepts envelopes without platform data. */
    payload: z.unknown().optional(),
    target: TargetSchemaImpl.optional(),
    meta: MetaSchemaImpl.optional(),
  };

  export const DirectEventSchema = z.object({
    ...InboundEventBase,
    mode: z.literal("direct"),
  });
  export type DirectEvent = z.infer<typeof DirectEventSchema>;

  export const InternalEventSchema = z.object({
    ...InboundEventBase,
    mode: z.literal("internal"),
    agentName: z.string(),
  });
  export type InternalEvent = z.infer<typeof InternalEventSchema>;

  export type InboundEvent = DirectEvent | InternalEvent;

  /** #499 observation descriptors — published via Bus; event name strings frozen. */
  export const Events = EventDescriptors;
  export const recordedRoutingDecision = recordedRoutingDecisionReader;
  export type RoutingDecisionPayload = RoutingDecisionPayloadType;

  /**
   * Shared `route.decided` recorder core (batch ② commit 1) — the PURE parts
   * both ingress arms (external gateway router / internal brain path) import
   * so the two once byte-identical recorders can no longer drift. Each arm
   * still owns its record (its own scoped `DecisionFacts.port()` + typed error).
   */
  export const ROUTE_DECIDED_FACT_TYPE = RouteRecord.ROUTE_DECIDED_FACT_TYPE;
  export const routeStreamId = RouteRecord.routeStreamId;
  export const routeDecidedFact = RouteRecord.routeDecidedFact;
  export const routeDecisionsEquivalent = RouteRecord.routeDecisionsEquivalent;

  /** batch ② commit 4 — the route_correction (route.not_delivered) fact helpers. */
  export const ROUTE_NOT_DELIVERED_FACT_TYPE = RouteRecord.ROUTE_NOT_DELIVERED_FACT_TYPE;
  export const routeCorrectionStreamId = RouteRecord.routeCorrectionStreamId;
  export const routeNotDeliveredFact = RouteRecord.routeNotDeliveredFact;
}

/**
 * Pure target resolution over the Ingress vocabulary (#707 hoist): both
 * planes (ingress routing and brain-side projection/authority labels) fold
 * the same explicit-target > meta-target > resident-default precedence and
 * the same stable target key. No store access, no defaulting judgment —
 * absent targets are a protocol fact (resident), not a routing decision.
 */
export function resolveTarget(event: {
  target?: Ingress.Target;
  meta?: { target?: Ingress.Target };
}): Ingress.Target {
  if (event.target) return Ingress.TargetSchema.parse(event.target);
  if (event.meta?.target) return Ingress.TargetSchema.parse(event.meta.target);
  return { kind: "resident" };
}

export function targetKey(target: Ingress.Target): string {
  return target.sessionId ? `resident:${target.sessionId}` : "resident";
}
