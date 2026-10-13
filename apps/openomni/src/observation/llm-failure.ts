/** Channel rendering of kernel-classified failures; raw provider details stay private. */

import { Core } from "@openomni/agent";
import { classifyFailure } from "@openomni/llm";
const failureFacts = Core.failureFacts;
import { PlainValueSchema, type PlainValue } from "@openomni/protocol";
import { z } from "zod";

const ThrownValue = z.union([z.instanceof(Error), PlainValueSchema]);
type ThrownValue = z.input<typeof ThrownValue>;

/** How the classified failure reads to the person who asked for the turn. */
export interface ClassifiedFailure {
  /** The closed provider class this failure was decided to be. */
  readonly reason: Core.ProviderReason;
  /** The channel-visible message. */
  readonly text: string;
}

function attemptClause(error: object | undefined): string {
  const facts = failureFacts(error);
  // No decided facts means the run died before any retry decision — saying
  // "tried 1 time" would be a claim the run never made.
  if (facts === undefined) return "";
  return facts.attempt === 1 ? ", tried once" : `, tried ${facts.attempt} times`;
}

/**
 * Classifies a terminal turn failure into the message the channel shows.
 *
 * Hedging is deliberate and load-bearing on the billing arm: an unambiguous
 * exhaustion signal (the llm package's `billing` class) states the account is
 * spent, while payment-required status only suggests it — telling an operator
 * their balance is gone when it might be a card decline sends them to the
 * wrong place. These messages never include a thrown error's raw details.
 */
export function classifyTurnFailure(error: ThrownValue): ClassifiedFailure {
  const parsed = ThrownValue.safeParse(error);
  const failure: Error | PlainValue = parsed.success ? parsed.data : null;
  const reason = providerReason(failure);
  const objectError = typeof failure === "object" && failure !== null ? failure : undefined;
  switch (reason) {
    case "rate_limit":
      return {
        reason,
        text: `I could not answer: the model provider rate limited upstream${attemptClause(objectError)}. Nothing is wrong with the request — retry in a moment.`,
      };
    case "billing":
      return {
        reason,
        text: paymentRequired(objectError)
          ? "I could not answer: the provider returned payment required, so the account's quota or balance may be exhausted — check provider account. (402 Payment Required)"
          : "I could not answer: the provider reports quota/billing exhausted — check provider account balance or limits. Retrying will not help until it is topped up.",
      };
    case "content_policy":
      return {
        reason,
        text: "I could not answer: the provider refused this request on content policy grounds. The same prompt will be refused again — rephrase or change what is being asked.",
      };
    case "overloaded":
    case "server_error":
      return {
        reason,
        text: `I could not answer: the model provider failed server-side${attemptClause(objectError)}. This is upstream, not your request — retry shortly.`,
      };
    case "validation_error":
    case "non_retryable":
      return {
        reason,
        text: unclassifiedText(objectError),
      };
  }
}

/**
 * The call layer's pure classification (#1352), read for its provider
 * vocabulary: an abort or overflow that still reached the channel carries no
 * provider class, so it reads as the unclassified residue.
 */
function providerReason(failure: Error | PlainValue): Core.ProviderReason {
  const classified = classifyFailure({ error: failure });
  return classified.kind === "retryable" || classified.kind === "terminal" ? classified.providerReason : "non_retryable";
}

/**
 * The residue: no provider facts to classify by. A 402 is the one status that
 * MIGHT be a spent balance and might be a declined card, so it is hedged
 * rather than either asserted or hidden.
 */
function unclassifiedText(error: object | undefined): string {
  if (paymentRequired(error)) {
    return "I could not answer: the provider returned payment required, so the account's quota or balance may be exhausted — check provider account. (402 Payment Required)";
  }
  return "I could not answer: I could not reach the model. Retry shortly.";
}

const PaymentRequired = z.object({ statusCode: z.literal(402) });
const CauseLink = z.object({ cause: z.instanceof(Object) });

/**
 * Read structurally from the error, never from prose: the status sits on the
 * AI SDK's own `APICallError`, reached through cause links. They are walked
 * for the same reason the llm classifier walks them — the status can sit one
 * wrapper down. zod is the reader, so no property access on the foreign error
 * shape stays `unknown`.
 */
function paymentRequired(error: object | undefined): boolean {
  let current: object | undefined = error;
  for (let depth = 0; depth < 8; depth += 1) {
    if (current === undefined) return false;
    if (PaymentRequired.safeParse(current).success) return true;
    const link = CauseLink.safeParse(current);
    if (!link.success || link.data.cause === current) return false;
    current = link.data.cause;
  }
  return false;
}
