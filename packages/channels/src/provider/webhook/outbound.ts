import { createHmac } from "node:crypto";
import { ChannelsFailure, DeliveryNotSent } from "../../errors";
import { type DeliveryReceipt, DeliveryReconciliation, deliverKeyed } from "../../support/deliver";
import type { PublishPort } from "../../types";

/** How long one POST may take before its outcome is unknown: the request may have landed. */
const WEBHOOK_TIMEOUT_MS = 15_000;

/** How many bytes of the target's answer body are carried back to the sender. */
export const WEBHOOK_RESPONSE_LIMIT = 64 * 1024;

/** Failures raised before any byte left this host — a refused connection, no such host, a failed TLS handshake: nothing was posted. */
const NEVER_LEFT = new Set(["ConnectionRefused", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);
const NEVER_LEFT_PATTERN = /CERT|TLS|SSL/;

/** Only a textual answer is carried back as the sender's prompt. */
const TEXTUAL = /^(text\/|application\/json\b|application\/[a-z0-9.+-]*\+json\b)/i;

/** The signature the inbound side verifies: `sha256=<hex HMAC-SHA256 of the raw body>` in `X-Signature`. */
export function signWebhookBody(body: Uint8Array, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

/** The one HTTP call a sender makes; injected so tests script the target and production hands in `fetch`. */
export type WebhookFetch = (
  url: string,
  init: {
    readonly method: "POST";
    readonly headers: Readonly<Record<string, string>>;
    readonly body: Uint8Array;
    readonly signal: AbortSignal;
    /** Never followed: a redirect is the target's refusal, and the signed body goes nowhere the Owner did not declare. */
    readonly redirect: "manual";
  },
) => Promise<{
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export interface WebhookSender {
  post(input: {
    readonly url: string;
    /** The target's shared secret: the body is signed with it, as the inbound side verifies. */
    readonly secret: string;
    readonly idempotencyKey: string;
    readonly body: Uint8Array;
  }): Promise<{
    readonly receipt: DeliveryReceipt;
    /** The target's own word on a refusal (its HTTP status), for the sender's fact. */
    readonly reason?: string;
    /** The target's textual answer (bounded by bytes), present only when the POST was accepted and it said anything. */
    readonly response?: string;
  }>;
}

function failureCode(error: Error): string | undefined {
  const code = (error as Error & { readonly code?: string | number }).code;
  return typeof code === "string" ? code : undefined;
}

/** The answer the sender carries back: a textual body, cut at the byte bound; anything else is nothing. */
async function answerOf(answered: {
  readonly headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}): Promise<string | undefined> {
  if (!TEXTUAL.test(answered.headers.get("content-type") ?? "")) return undefined;
  const bytes = new Uint8Array(await answered.arrayBuffer());
  return new TextDecoder().decode(bytes.length > WEBHOOK_RESPONSE_LIMIT ? bytes.slice(0, WEBHOOK_RESPONSE_LIMIT) : bytes);
}

/**
 * The outbound side of the webhook provider (#1569 lane 9): one letter
 * POSTed to a declared URL, signed with the target's secret, under the same
 * custody as every platform send — one physical attempt per idempotency
 * key, and that attempt never follows a redirect. A 2xx is `sent` (a
 * textual answer carried back, bounded); a 5xx came back after the target
 * had the request and may have acted on it before failing, so it is
 * `unknown`; any other status, a redirect included, is the target's refusal,
 * `not_sent`; a request that never left this host (connection refused, no
 * such host, a failed TLS handshake) is `not_sent`; a request that may have
 * landed — a timeout, a reset after it left — is `unknown`, surfaced to the
 * Owner once and never re-sent. Custody is this process's: a daemon that
 * crashes between the POST and the journaled receipt, or a second daemon
 * over the same store, holds no memory of the attempt.
 */
export function createWebhookSender(deps: {
  readonly fetch: WebhookFetch;
  readonly publish: PublishPort;
  readonly now: () => number;
  readonly id: () => string;
  readonly timeoutMs?: number;
}): WebhookSender {
  const outbound = new DeliveryReconciliation();
  const timeoutMs = deps.timeoutMs ?? WEBHOOK_TIMEOUT_MS;
  return {
    async post(input) {
      let response: string | undefined;
      let reason: string | undefined;
      const receipt = await deliverKeyed(
        outbound,
        input.idempotencyKey,
        async () => {
          const answered = await deps.fetch(input.url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-signature": signWebhookBody(input.body, input.secret),
              "x-oni-delivery": input.idempotencyKey,
            },
            body: input.body,
            signal: AbortSignal.timeout(timeoutMs),
            redirect: "manual",
          });
          if (answered.status >= 200 && answered.status < 300) {
            response = await answerOf(answered);
            return { accepted: true };
          }
          reason = `HTTP ${answered.status}`;
          // A 5xx came back after the target had the request: it may have acted before failing.
          if (answered.status >= 500) throw new ChannelsFailure({ operation: "webhook.post", cause: reason });
          throw new DeliveryNotSent({ operation: "webhook.post", cause: reason });
        },
        (error) => {
          const code = failureCode(error);
          return code !== undefined && (NEVER_LEFT.has(code) || NEVER_LEFT_PATTERN.test(code));
        },
        deps.publish,
        { now: deps.now, id: deps.id },
      );
      return {
        receipt,
        ...(reason === undefined ? {} : { reason }),
        ...(response === undefined ? {} : { response }),
      };
    },
  };
}
