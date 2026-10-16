import { z } from "zod";
import { Channel } from "../channel/index.js";
import { BusEvent } from "../bus/index.js";
import { Gateway } from "./schema.js";
import { EpochMs } from "../time.js";

const EventBase = z.object({
  messageId: z.string().min(1),
  traceId: z.string().min(1),
  senderId: z.string().min(1),
  targetActorId: z.string().min(1),
  time: EpochMs,
});

/**
 * Deterministic messaging audit trail (#215, descriptor re-homed to protocol
 * at #707 stage 2 — the gateway router publishes through an injected sink and
 * may not define zod schemas of its own): every send lands exactly one of
 * these. Fire-and-forget leaves ONLY the `Sent` event (no request); denials
 * leave ONLY the `Denied` event (no delivery, no request, no allocation).
 * Event name strings are byte-frozen wire vocabulary.
 */
export const MessagingEvents = {
  Sent: BusEvent.define(
    "messaging.sent",
    EventBase.extend({
      operation: Gateway.MessageOperation,
      grantId: z.string().min(1),
      endpointId: z.string().min(1),
      /** #1569: the identity the send went out under; every send journals it. */
      identity: Channel.Identity,
      requestId: z.string().min(1).optional(),
    }),
    { visibility: "llm_reason" },
  ),
  Denied: BusEvent.define(
    "messaging.denied",
    EventBase.extend({ code: Gateway.MessageDenialCode }),
    {
      visibility: "internal",
    },
  ),
} as const;
