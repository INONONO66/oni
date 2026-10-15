import { ChannelsFailure, SendAdmissionConflict } from "../../errors";
import { Gateway, type DecisionFact, type Outbound } from "@openomni/protocol";
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

function sendSignature(input: Gateway.SendInput, target: Gateway.DeliveryTarget): string {
  return JSON.stringify({
    messageId: input.messageId,
    senderId: input.senderId,
    operation: input.operation,
    class: input.class,
    ...signedContent(input.payload),
    target,
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

/** Runs synchronously inside the caller's ledger transaction, before any physical delivery. */
export function admitSend(
  stores: ChannelStores,
  authorization: AuthorizedSend,
  ports: Pick<NonNullable<GatewayRouterPorts["messaging"]>, "budgets">,
  deny: DenySend,
): SendAdmission | Gateway.SendReceipt {
  const { input, target, grant } = authorization;
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
  const budgeted = ports.budgets !== undefined && grant.replyScope === undefined;
  if (budgeted) {
    const budget = ports
      .budgets?.()
      .find((candidate) => candidate.targetActorId === input.target.actorId);
    const budgetClaim = stores.egressBudgets.claim(
      debitRow(input, sendClass),
      input.at - (budget?.windowMs ?? 0),
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
