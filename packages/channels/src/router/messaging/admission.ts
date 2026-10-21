import { ChannelsFailure, SendAdmissionConflict } from "../../errors";
import { Gateway, type DecisionFact, type Outbound } from "@oni/protocol";
import type { ChannelStores } from "../stores.js";
import { z } from "zod";
import type { GatewayRouterPorts } from "../message-ports";
import { evaluateSocialBudget } from "./social-budget";

const SEND_ADMITTED_FACT = "gateway.send.admitted";
const SendAdmission = z.object({
  signature: z.string(),
  budgeted: z.boolean(),
  sendClass: Gateway.MessageClass,
});
type SendAdmission = z.infer<typeof SendAdmission>;

interface AuthorizedSend {
  readonly input: Gateway.SendInput;
  readonly target: Gateway.DeliveryTarget;
  readonly grant: Gateway.SenderTargetGrant;
}

type DenySend = (
  input: Gateway.SendInput,
  code: Gateway.MessageDenialCode,
  reason: string,
) => Gateway.SendReceipt;

/**
 * A letter that is one plain text part signs as `body: <text>` — the form
 * every admission recorded before payloads existed — so a send admitted
 * then and replayed now still matches instead of conflicting.
 */
function signedContent(
  payload: Outbound.Payload,
): { body: string } | { payload: Outbound.Payload } {
  const [part, ...rest] = payload.kind === "message" ? (payload.parts ?? []) : [];
  return part?.kind === "text" && rest.length === 0 ? { body: part.text } : { payload };
}

/**
 * The signed target: every admission recorded before the identity axis
 * (#1569) named a bot delivery without saying so, so the bot identity stays
 * implicit in the signature and a replay of such a send still matches; the
 * Owner's identity is signed, so the same message id cannot switch accounts.
 */
function signedTarget(target: Gateway.DeliveryTarget): Omit<Gateway.DeliveryTarget, "identity"> & { identity?: "owner" } {
  const { identity, ...rest } = target;
  return identity === "owner" ? { ...rest, identity } : rest;
}

function sendSignature(input: Gateway.SendInput, target: Gateway.DeliveryTarget): string {
  return JSON.stringify({
    messageId: input.messageId,
    senderId: input.senderId,
    operation: input.operation,
    class: input.class,
    ...signedContent(input.payload),
    target: signedTarget(target),
    requestSpec: input.requestSpec,
  });
}

function sendStreamId(messageId: string): string {
  return `gateway_send:${encodeURIComponent(messageId)}`;
}

function existingAdmission(
  stores: ChannelStores,
  input: Gateway.SendInput,
  target: Gateway.DeliveryTarget,
): SendAdmission | SendAdmissionConflict | undefined {
  const decisionFacts = stores.decisionFacts.port();
  if (decisionFacts === undefined)
    throw new ChannelsFailure({
      operation: "message.admission",
      cause: "storage adapter does not implement decision facts — gateway sends fail closed",
    });
  const fact = decisionFacts.head(sendStreamId(input.messageId));
  return fact === undefined ? undefined : recordedAdmission(fact, input, target);
}

function recordedAdmission(
  fact: DecisionFact.Recorded,
  input: Gateway.SendInput,
  target: Gateway.DeliveryTarget,
): SendAdmission | SendAdmissionConflict {
  const streamId = fact.key;
  if (fact.type !== SEND_ADMITTED_FACT)
    throw new ChannelsFailure({
      operation: "message.admission",
      cause: `unexpected fact type on send stream ${streamId}: ${fact.type}`,
    });
  const parsed = SendAdmission.safeParse(fact.data);
  if (!parsed.success)
    throw new ChannelsFailure({
      operation: "message.admission",
      cause: `corrupt send admission fact on ${streamId}`,
    });
  const admission = parsed.data;
  if (admission.signature !== sendSignature(input, target)) {
    return new SendAdmissionConflict({
      message: `message id ${input.messageId} was already admitted with different content`,
    });
  }
  return admission;
}

function recordAdmission(
  stores: ChannelStores,
  input: Gateway.SendInput,
  target: Gateway.DeliveryTarget,
  budgeted: boolean,
  sendClass: Gateway.MessageClass,
): SendAdmission {
  const decisionFacts = stores.decisionFacts.port();
  if (decisionFacts === undefined)
    throw new ChannelsFailure({
      operation: "message.admission",
      cause: "storage adapter does not implement decision facts — gateway sends fail closed",
    });
  const key = sendStreamId(input.messageId);
  const admission = { signature: sendSignature(input, target), budgeted, sendClass } as const;
  const outcome = decisionFacts.record({
    key,
    type: SEND_ADMITTED_FACT,
    data: { ...admission },
    timeCreated: input.at,
  });
  if (outcome.kind === "recorded") return admission;
  const raced = recordedAdmission(outcome.fact, input, target);
  if (raced instanceof SendAdmissionConflict) throw raced;
  return raced;
}

function debitRow(
  input: Gateway.SendInput,
  sendClass: Gateway.MessageClass,
): Gateway.EgressDebitRow {
  return {
    id: `gateway-send:${input.messageId}`,
    senderId: input.senderId,
    targetActorId: input.target.actorId,
    class: sendClass,
    at: input.at,
  };
}

function repairBudgetDebit(
  stores: ChannelStores,
  input: Gateway.SendInput,
  admission: SendAdmission,
): void {
  if (!admission.budgeted) return;
  stores.egressBudgets.claim(debitRow(input, admission.sendClass), input.at, () => "allow");
}

/**
 * The Owner-declared budget that governs a target now (#1569 lane 8): a
 * lapsed allowance is no budget — the target is the Owner's to approve again.
 */
export function activeBudgetFor(
  budgets: readonly Gateway.SocialBudget[] | undefined,
  targetActorId: string,
  at: number,
): Gateway.SocialBudget | undefined {
  return budgets?.find(
    (candidate) => candidate.targetActorId === targetActorId && (candidate.expiresAt === undefined || candidate.expiresAt > at),
  );
}

/**
 * #1600 lane R2: a letter to the owner-tier Person is never outreach — the
 * Owner declares budgets for the people the Resident may contact, not for
 * their own mail — so a missing budget for the Owner is no consent question
 * (a draft, a report, a question are the Owner's own mail). A budget the
 * Owner did declare for themselves is honored like any other.
 */
export function ownerTarget(stores: Pick<ChannelStores, "actors">, actorId: string): boolean {
  return stores.actors.getIdentity(actorId)?.trustTier === "owner";
}

/** Runs synchronously inside the caller's ledger transaction, before any physical delivery. */
export function admitSend(
  stores: ChannelStores,
  authorization: AuthorizedSend,
  ports: Pick<NonNullable<GatewayRouterPorts["messaging"]>, "budgets">,
  deny: DenySend,
): SendAdmission | Gateway.SendReceipt {
  const { input, target } = authorization;
  const sendClass = input.class ?? (input.operation === "awaited" ? "converse" : "notify");
  let admission = existingAdmission(stores, input, target);
  if (admission instanceof SendAdmissionConflict) {
    if (input.operation === "awaited") return deny(input, "request_duplicate", admission.message);
    throw admission;
  }
  if (admission !== undefined) {
    repairBudgetDebit(stores, input, admission);
    return admission;
  }
  // Every actor send is outreach under the standing grant; the reply door
  // (`admitReply`) is the one budget-free path, and it never comes through here.
  const budget = activeBudgetFor(ports.budgets?.(), input.target.actorId, input.at);
  // #1569 lane 8: with the gate wired and no budget declared for the target,
  // the send is the Owner's to approve — consented, it goes with no debit;
  // otherwise it is denied `approval_required`, never silently exhausted.
  if (ports.budgets !== undefined && budget === undefined && input.consented !== true && !ownerTarget(stores, input.target.actorId)) {
    return deny(
      input,
      "approval_required",
      `no Owner-declared budget for ${input.target.actorId}: a ${sendClass} send ${input.senderId} -> ${input.target.actorId} needs the Owner's consent`,
    );
  }
  const budgeted = budget !== undefined;
  if (budgeted) {
    const budgetClaim = stores.egressBudgets.claim(
      debitRow(input, sendClass),
      input.at - budget.windowMs,
      (state) => evaluateSocialBudget(budget, state, { class: sendClass, at: input.at }),
    );
    if (budgetClaim.kind === "refused") {
      return deny(
        input,
        budgetClaim.reason.suppress,
        `active-egress budget suppressed a ${sendClass} send ${input.senderId} -> ${input.target.actorId} (${budgetClaim.reason.suppress})`,
      );
    }
  }
  admission = recordAdmission(stores, input, target, budgeted, sendClass);
  repairBudgetDebit(stores, input, admission);
  return admission;
}

/**
 * The reply door's admission (#1569): one fact per message id and never a
 * budget debit — a reply to the conversation that prompted the turn is not
 * outreach. A replay under the same id with the same content returns the
 * recorded admission; different content is a typed conflict. Runs inside the
 * caller's ledger transaction, before any physical delivery.
 */
export function admitReply(
  stores: ChannelStores,
  input: Gateway.SendInput,
  target: Gateway.DeliveryTarget,
): SendAdmission {
  const existing = existingAdmission(stores, input, target);
  if (existing instanceof SendAdmissionConflict) throw existing;
  if (existing !== undefined) return existing;
  return recordAdmission(stores, input, target, false, input.class ?? "notify");
}
