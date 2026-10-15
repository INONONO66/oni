import { CallbackDataTooLong, DeliveryNotSent, RenderLimitExceeded } from "../errors";
import { Operational, type Outbound } from "@openomni/protocol";
import { z } from "zod";
import type { PublishPort } from "../types";
import { type DeliveryOutcome, PartialDeliveryError } from "./translate";
import { newTraceId } from "./trace";

export const DeliveryReceipt = z.object({
  value: z.enum(["sent", "not_sent", "unknown"]),
  externalMessageId: z.string().optional(),
});
export type DeliveryReceipt = z.infer<typeof DeliveryReceipt>;

// These failures prove the connection was never established, unlike a reset or timeout.
const NotConnected = z.object({
  code: z.enum(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ConnectionRefused"]),
});

/** Physical evidence that the platform never received the message, so a resend is safe. */
export function isNotSent(error: Error, isRejected: (error: Error) => boolean): boolean {
  return (
    error instanceof DeliveryNotSent ||
    error instanceof RenderLimitExceeded ||
    error instanceof CallbackDataTooLong ||
    isRejected(error) ||
    NotConnected.safeParse(error).success
  );
}

/** Proven sends are safe to forget once the platform has the message; uncertain keys never expire. */
const SENT_RETENTION = 4096;

/** Physical-send custody, not an delivery dedupe window: uncertain keys must not expire. */
export class DeliveryReconciliation {
  private readonly attempts = new Map<string, Promise<DeliveryReceipt>>();
  private readonly sent = new Set<string>();

  constructor(private readonly sentRetention = SENT_RETENTION) {}

  run(key: string, send: () => Promise<DeliveryReceipt>): Promise<DeliveryReceipt> {
    const existing = this.attempts.get(key);
    if (existing !== undefined) return existing;
    const attempt = Promise.resolve()
      .then(send)
      .then((receipt) => {
        if (receipt.value === "not_sent") this.attempts.delete(key);
        if (receipt.value === "sent") this.retainSent(key);
        return receipt;
      });
    // A rejected attempt is retained too: absent adapter proof, retry is unsafe.
    this.attempts.set(key, attempt);
    return attempt;
  }

  private retainSent(key: string): void {
    this.sent.add(key);
    for (const oldest of this.sent) {
      if (this.sent.size <= this.sentRetention) break;
      this.sent.delete(oldest);
      this.attempts.delete(oldest);
    }
  }
}

export type KernelDeliveryReceipt = Outbound.Receipt;

/** Translate physical evidence only at the kernel receipt boundary. */
export function kernelDeliveryReceipt(receipt: DeliveryReceipt): KernelDeliveryReceipt {
  return {
    ...receipt,
    value:
      receipt.value === "sent" ? "accepted" : receipt.value === "not_sent" ? "rejected" : "unknown",
  };
}

/** Report the final chunk's platform id; partial acceptance is never safe to resend. */
export function deliverKeyed(
  reconciliation: DeliveryReconciliation,
  idempotencyKey: string,
  send: (traceId: string) => Promise<DeliveryOutcome>,
  isRejected: (error: Error) => boolean,
  publish: PublishPort,
  options: { readonly now: () => number; readonly id: () => string },
): Promise<DeliveryReceipt> {
  // #1248: an uncertain outcome is recorded as unknown AND surfaced to the
  // Owner — the reconciliation map refuses to resend it, so without a notice
  // the message would vanish silently.
  const unknownNotice = (traceId: string, reason: string): DeliveryReceipt => {
    publish(Operational.Events.Warn, {
      traceId,
      time: options.now(),
      component: "server",
      msg: "delivery outcome unknown; uncertain send will not be retried",
      context: { idempotencyKey, reason },
    });
    return { value: "unknown" };
  };
  const attempt = async (): Promise<DeliveryReceipt> => {
    const traceId = newTraceId(options.id);
    try {
      const outcome = await send(traceId);
      if (!outcome.accepted) return unknownNotice(traceId, "platform returned no message id");
      return outcome.externalMessageId === undefined
        ? { value: "sent" }
        : { value: "sent", externalMessageId: outcome.externalMessageId };
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      if (error instanceof PartialDeliveryError) {
        publish(Operational.Events.Warn, {
          traceId,
          time: options.now(),
          component: "server",
          msg: "partial message delivery",
          context: {
            delivery: "partial",
            idempotencyKey,
            acceptedChunks: error.acceptedChunks,
            attemptedChunks: error.attemptedChunks,
            totalChunks: error.totalChunks,
            reason: error.reason,
          },
        });
        return { value: "unknown" };
      }
      if (isNotSent(error, isRejected)) return { value: "not_sent" };
      return unknownNotice(traceId, String(error));
    }
  };
  return reconciliation.run(idempotencyKey, attempt);
}
