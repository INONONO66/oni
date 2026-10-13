import { z } from "zod";
import { BusEvent } from "../bus/index.js";
import { Actor } from "../actor/index.js";
import { LedgerSession, SessionTurn } from "../ledger/l0.js";
import { EpochMs } from "../time.js";
import { Author, Input } from "../ingress/input.js";
import { SessionTransition } from "../ledger/session-transition.js";

const Id = z.string().min(1);
const DurationMs = z.number().nonnegative();
const MessageType = z.enum(["message", "interrupt", "resume"]);
const TargetKind = z.enum(["session", "new_session", "actor"]);
const Addressee = z.enum(["bot", "owner", "ambient"]);
const Verdict = z.enum(["allow", "deny"]);

// The session-addressed variants are shared with the model-facing send_message
// tool, which swaps only the actor variant for its `contact` noun.
const SessionTarget = z.object({ kind: z.literal("session"), id: Id }).strict();
const NewSessionTarget = z
  .object({
    kind: z.literal("new_session"),
    role: LedgerSession.Role,
    runner: Id,
    // The authenticated caller supplies the parent identity, not the model.
    parent: z.literal("me"),
  })
  .strict();
const Target = z.discriminatedUnion("kind", [
  SessionTarget,
  NewSessionTarget,
  z.object({ kind: z.literal("actor"), actorId: Id }).strict(),
]);

const Send = z
  .object({
    to: Target,
    type: MessageType,
    content: z.string(),
    replyTo: Id.optional(),
    deadline: EpochMs.optional(),
  })
  .strict();

// Credential is transient ingress material, never an action payload.
const RequestAnswer = z
  .object({
    kind: z.literal("request_answer"),
    inputId: Id,
    request: SessionTransition.Request,
    decision: z.enum(["approve", "refuse"]),
    credential: Id,
  })
  .strict();

// target is the resolved session id (including new_session), or the actor id
// for actor delivery. No fictitious session is allocated for an actor.
const Handle = z.object({ messageId: Id, target: Id }).strict();

// Authentication binds this separate argument. No caller-supplied trust verdict.
const Sender = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("external"), surface: Id, externalId: Id }).strict(),
  z.object({ kind: z.literal("session"), id: Id }).strict(),
]);

// Driver-reported facts: only observable platform facts. Sender is a separate ingest
// argument; tier and the bot/owner/ambient axis are resolved in gateway policy.
const IngressFacts = z
  .object({
    eventId: Id,
    surface: Id,
    event: Input.shape.event.optional(),
    secretRef: Input.shape.secretRef,
    githubEvent: Input.shape.githubEvent,
    author: Author.optional(),
    workspaceId: Id.optional(),
    channelId: Id,
    addressees: z.array(z.object({ externalId: Id }).strict()),
    dm: z.boolean(),
    reply: SessionTransition.Correlation.omit({ endpointId: true, channelId: true })
      .extend({ chain: z.array(Id) })
      .strict()
      .optional(),
    payload: z.json(),
    render: z.string(),
  })
  .strict();

// These three values classify only an executed external actor delivery.
// A session commit either executes successfully or throws in its consumer.
const Delivery = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("session") }).strict(),
  z
    .object({ kind: z.literal("actor"), value: z.enum(["accepted", "rejected", "unknown"]) })
    .strict(),
]);
const Result = z.discriminatedUnion("status", [
  z.object({ status: z.literal("blocked_pre"), reasonCode: Id }).strict(),
  z.object({ status: z.literal("executed"), handle: Handle, delivery: Delivery }).strict(),
  // A post obligation failure cannot undo the committed delivery.
  z
    .object({
      status: z.literal("blocked_post"),
      handle: Handle,
      reasonCode: Id,
    })
    .strict(),
]);

// A/B are declarative pre-policy row payloads, not a second policy engine.
// Each row names one check; authenticated facts and store projections are
// supplied by stage-2 consumers. Evaluation/ordering/default rows live there.
const RuleBase = z.object({ id: Id, effect: Verdict }).strict();
const RuleTableA = RuleBase.extend({
  table: z.literal("A"),
  sender: z.literal("external"),
  senderTier: Actor.TrustTier.optional(),
  addressee: Addressee.optional(),
  check: z.enum([
    "identity",
    "grant_tier",
    "egress_budget",
    "event_id_dedupe",
    "reply_correlation",
  ]),
});
const RuleTableB = RuleBase.extend({
  table: z.literal("B"),
  sender: z.literal("session"),
  senderRole: LedgerSession.Role,
  targetKind: TargetKind.optional(),
  targetRole: LedgerSession.Role.optional(),
  type: MessageType.optional(),
  check: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("parent_child") }).strict(),
    z.object({ kind: z.literal("fanout"), max: z.number().int().nonnegative() }).strict(),
    z.object({ kind: z.literal("depth"), max: z.number().int().nonnegative() }).strict(),
    z.object({ kind: z.literal("deadline"), withinParent: z.literal(true) }).strict(),
    z.object({ kind: z.literal("type") }).strict(),
    z.object({ kind: z.literal("actor_send") }).strict(),
  ]),
});

// Six observation families (admission has admitted/rejected arms). Timing is
// required only where measurable. Bus metadata is observation context
// stamped by the sink after the action commit.
const ObservationBase = z.object({ messageId: Id }).extend(BusEvent.Metadata.shape).strict();
const AdmissionBase = ObservationBase.extend({ matchedRuleIds: z.array(Id), ingestMs: DurationMs });
const Observation = z.discriminatedUnion("kind", [
  ObservationBase.extend({
    kind: z.literal("message.sent"),
    sender: Sender,
    targetKind: TargetKind,
    type: MessageType,
    bytes: z.number().int().nonnegative(),
  }),
  AdmissionBase.extend({ kind: z.literal("message.admitted"), verdict: z.literal("allow") }),
  AdmissionBase.extend({ kind: z.literal("message.rejected"), verdict: z.literal("deny") }),
  ObservationBase.extend({ kind: z.literal("message.committed"), commitMs: DurationMs }),
  ObservationBase.extend({
    kind: z.literal("message.drained"),
    queueMs: DurationMs,
    boundary: SessionTurn.Boundary,
  }),
  ObservationBase.extend({
    kind: z.literal("message.replied"),
    replyTo: Id,
    roundTripMs: DurationMs,
    childTurnMs: DurationMs.optional(),
    tokens: z.number().int().nonnegative().optional(),
  }),
  ObservationBase.extend({ kind: z.literal("message.timed_out"), waitedMs: DurationMs }),
]);

/**
 * The bounded settlement envelope a child writes toward its parent (#1311):
 * the terminal status, a preview capped at 4 KiB, and a pointer naming the
 * child session and its terminal action — the full output stays readable in
 * the child's journal through the pointer, never inlined.
 */
const DelegationResult = z
  .object({
    status: z.enum(["completed", "failed"]),
    preview: z.string().max(4096),
    pointer: z.object({ session: Id, action: Id }).strict(),
  })
  .strict();

/** Internal schema assembly; public names are exposed through Gateway. */
export const MessageContract = {
  SessionTarget,
  NewSessionTarget,
  Send,
  RequestAnswer,
  Handle,
  Sender,
  IngressFacts,
  Result,
  RuleTableA,
  RuleTableB,
  Observation,
  DelegationResult,
} as const;
