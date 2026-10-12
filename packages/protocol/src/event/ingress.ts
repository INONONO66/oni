import { z } from "zod";
import { Actor } from "../actor/index.js";
import { BusEvent } from "../bus/index.js";
import { PlainObjectSchema } from "../json.js";
import { EpochMs } from "../time.js";

const Base = z.object({
  traceId: z.string(),
  time: EpochMs,
});

const RoutingDecisionBase = Base.extend({
  inboundId: z.string(),
  surface: z.string(),
  mode: z.enum(["direct", "internal"]),
  reason: z.string(),
  factsUsed: z.array(z.string()),
  target: z.string().optional(),
  sessionId: z.string().optional(),
  actorId: z.string().optional(),
  trustTier: Actor.TrustTier.optional(),
  inboundTreatment: Actor.InboundTreatment.optional(),
});

const LedgerDecisionBase = RoutingDecisionBase.extend({
  stage: z.literal("automation"),
  outcome: z.literal("record"),
  by: z.string().regex(/^(automation|rule|blacklist)\/.+/),
  factsDigest: z.string().min(1),
  runWhen: z
    .object({ verdict: z.enum(["yes", "no", "unknown"]), reason: z.string() })
    .strict()
    .optional(),
  actionSeq: z.number().int().nonnegative().optional(),
});

function routingDecisionUnion(candidateId: z.ZodType<string, string>) {
  return z.union([
    RoutingDecisionBase.extend({
      stage: z.literal("blacklist"),
      outcome: z.literal("drop"),
    }).strict(),
    RoutingDecisionBase.extend({
      stage: z.literal("request_correlation"),
      outcome: z.literal("route"),
      target: z.string(),
    }).strict(),
    RoutingDecisionBase.extend({
      stage: z.literal("request_correlation"),
      outcome: z.literal("ambiguous"),
      candidateInteractionIds: z.array(candidateId).min(2),
    }).strict(),
    RoutingDecisionBase.extend({
      stage: z.literal("request_correlation"),
      outcome: z.literal("block"),
    }).strict(),
    RoutingDecisionBase.extend({
      stage: z.literal("channel_ceiling"),
      outcome: z.literal("block"),
    }).strict(),
    RoutingDecisionBase.extend({
      stage: z.literal("actor_identity"),
      outcome: z.literal("block"),
    }).strict(),
    RoutingDecisionBase.extend({
      stage: z.literal("surface_default"),
      outcome: z.literal("route"),
      target: z.string(),
    }).strict(),
    LedgerDecisionBase.extend({ decision: z.literal("matched") }).strict(),
    LedgerDecisionBase.extend({ decision: z.literal("filtered") }).strict(),
    LedgerDecisionBase.extend({ decision: z.literal("refused") }).strict(),
    LedgerDecisionBase.extend({ decision: z.literal("deduped") }).strict(),
    LedgerDecisionBase.extend({ decision: z.literal("grouped") }).strict(),
    LedgerDecisionBase.extend({ decision: z.literal("superseded") }).strict(),
  ]);
}

const RoutingDecisionPayloadSchema = routingDecisionUnion(z.string().regex(/^request:.+/));

export type RoutingDecisionPayload = z.infer<typeof RoutingDecisionPayloadSchema>;

// Upcast-on-read for persisted `route.decided` bytes: facts recorded before
// the pending-stack deletion carry optional string `runId`/
// `pendingInteractionId` fields and may list `pending_ask:*`/
// `pending_interaction:*` wait candidates on `ambiguous` rows. The reader
// validates the two dead fields against their historical type before
// stripping them, and reads legacy candidate ids verbatim (ambiguous rows
// never route and never grant, so the wider vocabulary is comparison-only).
// Anything else was never a valid route.decided of any era — the caller
// decides how that fails closed. New writes go through
// RoutingDecisionPayloadSchema and cannot produce these legacy shapes.
// The bytes are persisted JSON, so the persisted plain-object profile is
// the typed boundary; anything outside it is equally not a route.decided.
const RecordedRoutingDecisionSchema = routingDecisionUnion(
  z.string().regex(/^(?:request|wait|pending_ask|pending_interaction):.+/),
);

const LegacyRetiredFieldsSchema = z.object({
  runId: z.string().optional(),
  pendingInteractionId: z.string().optional(),
});

export function recordedRoutingDecision(data: object): RoutingDecisionPayload | undefined {
  const bytes = PlainObjectSchema.safeParse(data);
  if (!bytes.success || !LegacyRetiredFieldsSchema.safeParse(bytes.data).success) return undefined;
  const { runId, pendingInteractionId, ...upcast } = bytes.data;
  const result = RecordedRoutingDecisionSchema.safeParse(upcast);
  return result.success ? result.data : undefined;
}

export const Events = {
  RoutingDecision: BusEvent.define("ingress.routing.decision", RoutingDecisionPayloadSchema, {
    visibility: "user_audit",
  }),
};
