import { Ingress } from "@oni/protocol";
import { Data } from "effect";
import { z } from "zod";

const ChannelsFailureFields = z.object({ operation: z.string(), cause: z.string() });
/** Channels-owned failure for a Cause without a typed error. */
export class ChannelsFailure extends Data.TaggedError("ChannelsFailure")<
  z.infer<typeof ChannelsFailureFields>
> {
  override get message(): string {
    return `${this.operation}: ${this.cause}`;
  }
}

export class DeliveryNotSent extends Data.TaggedError("DeliveryNotSent")<
  z.infer<typeof ChannelsFailureFields>
> {}

export class AttachmentRefused extends Data.TaggedError("AttachmentRefused")<{
  readonly reason: "too_large" | "aborted";
  readonly maxBytes: number;
}> {}

export class MediaTooLarge extends Data.TaggedError("MediaTooLarge")<{
  readonly kind: "image" | "file" | "audio" | "video";
  readonly bytes: number;
  readonly limit: number;
}> {}

export class VoiceJoinRefused extends Data.TaggedError("VoiceJoinRefused")<{
  readonly reason: "address_incomplete" | "not_started" | "busy" | "join_failed" | "aborted";
  readonly surface: string;
  readonly detail: string;
}> {}

export class AutomationEnableRefused extends Data.TaggedError("AutomationEnableRefused")<{
  readonly reason: "approval_required" | "not_found";
  readonly id: string;
}> {}

export class AutomationConfigurationError extends Data.TaggedError("AutomationConfigurationError")<{
  readonly reason: "store_unconfigured" | "invalid_regex";
}> {}

const InvalidInboundFields = z.object({
  operation: z.string(),
  cause: z.string().optional(),
  reason: z.enum([
    "invalid_json",
    "invalid_frame",
    "invalid_request_answer",
    "text_required",
    "request_answer_unavailable",
  ]),
});
export class InvalidInbound extends Data.TaggedError("InvalidInbound")<
  z.infer<typeof InvalidInboundFields>
> {}

const MessageFields = z.object({ message: z.string() });
const ApiFields = MessageFields.extend({ rejected: z.boolean().optional() });
export class DiscordApiError extends Data.TaggedError("DiscordApiError")<
  z.infer<typeof ApiFields>
> {}
export class DiscordHandlerMissingError extends Data.TaggedError("DiscordHandlerMissingError")<
  z.infer<typeof MessageFields>
> {}
export class SlackApiError extends Data.TaggedError("SlackApiError")<z.infer<typeof ApiFields>> {}
export class SlackHandlerMissingError extends Data.TaggedError("SlackHandlerMissingError")<
  z.infer<typeof MessageFields>
> {}
export class SlackEndpointKeyError extends Data.TaggedError("SlackEndpointKeyError")<
  z.infer<typeof MessageFields>
> {}
export class TelegramApiError extends Data.TaggedError("TelegramApiError")<
  z.infer<typeof ApiFields>
> {}

const RoutingFields = MessageFields.extend({
  code: z.enum([
    "route_blocked",
    "route_ambiguous",
    "route_record_failed",
    "route_replay_divergent",
    "request_reply_rejected",
  ]),
  decision: Ingress.Events.RoutingDecision.schema,
});
export class IngressRoutingError extends Data.TaggedError("IngressRoutingError")<
  z.infer<typeof RoutingFields>
> {
  constructor(
    code: z.infer<typeof RoutingFields>["code"],
    message: string,
    decision: Ingress.RoutingDecisionPayload,
  ) {
    super({ code, message, decision });
  }
}

export class SendAdmissionConflict extends Data.TaggedError("SendAdmissionConflict")<
  z.infer<typeof MessageFields>
> {}

const RateLimitFields = MessageFields.extend({
  status: z.number(),
  attempts: z.number(),
  responseHeaders: z.record(z.string(), z.string()),
  responseBody: z.string(),
});
export class RateLimited extends Data.TaggedError("RateLimited")<z.infer<typeof RateLimitFields>> {}

export type ChannelError =
  | ChannelsFailure
  | AutomationConfigurationError
  | AutomationEnableRefused
  | DeliveryNotSent
  | AttachmentRefused
  | MediaTooLarge
  | InvalidInbound
  | DiscordApiError
  | DiscordHandlerMissingError
  | SlackApiError
  | SlackHandlerMissingError
  | SlackEndpointKeyError
  | TelegramApiError
  | IngressRoutingError
  | SendAdmissionConflict
  | RateLimited;

/** Decode diagnostics at foreign callback boundaries without retaining a raw cause. */
export function decodeChannelFailure(operation: string) {
  return z
    .preprocess(String, z.string())
    .transform((cause) => new ChannelsFailure({ operation, cause })).parse;
}
