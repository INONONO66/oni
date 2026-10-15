import { z } from "zod";

/**
 * Slack wire shapes this driver consumes — Socket Mode envelopes and the
 * message event inside `events_api` payloads. Only the fields the driver
 * reads are declared; the full raw payload rides `InboundMessage.raw`.
 */
const SlackMessageEventSchema = z.object({
  type: z.string(),
  // Present on edits, joins, bot posts, etc.; bot_message and message_changed
  // are handled explicitly, other subtypes are dropped for no author/text.
  subtype: z.string().optional(),
  channel: z.string().optional(),
  /** `im` marks a DM; everything else keys as a channel. */
  channel_type: z.string().optional(),
  user: z.string().optional(),
  /** Set when a bot (including this one) authored the message. */
  bot_id: z.string().optional(),
  text: z.string().optional(),
  files: z.array(z.object({
    id: z.string().optional(),
    url_private_download: z.string().optional(),
    url_private: z.string().optional(),
    mimetype: z.string().optional(),
    name: z.string().optional(),
    size: z.number().optional(),
  })).optional(),
  ts: z.string().optional(),
  thread_ts: z.string().optional(),
  reaction: z.string().optional(),
  item: z.object({ channel: z.string(), ts: z.string() }).optional(),
  /** Present on `message_changed`: the edited message's own user and text, not the envelope's. */
  message: z
    .object({
      user: z.string().optional(),
      text: z.string().optional(),
      files: z.array(z.object({
        id: z.string().optional(),
        url_private_download: z.string().optional(),
        url_private: z.string().optional(),
        mimetype: z.string().optional(),
        name: z.string().optional(),
        size: z.number().optional(),
      })).optional(),
      bot_id: z.string().optional(),
    })
    .optional(),
});

export type SlackMessageEvent = z.infer<typeof SlackMessageEventSchema>;

export const SlackInteractionSchema = z.object({
  type: z.literal("block_actions"),
  user: z.object({ id: z.string() }),
  channel: z.object({ id: z.string() }),
  actions: z.tuple([z.object({
    action_id: z.string(),
    action_ts: z.string(),
    text: z.object({ text: z.string() }),
  })]).rest(z.json()),
  container: z.object({ message_ts: z.string().optional() }).optional(),
  message: z.object({ ts: z.string().optional(), thread_ts: z.string().optional() }).optional(),
});
export type SlackInteraction = z.infer<typeof SlackInteractionSchema>;

/**
 * One Socket Mode frame: `hello`, `events_api` (must be acked), or
 * `disconnect`. `event` is tolerant by design (`catch(undefined)`): a
 * subscribed event type this driver does not consume must still parse as an
 * envelope so its ack is sent — Slack redelivers unacked envelopes forever.
 */
export const SocketEnvelopeSchema = z.object({
  type: z.string(),
  envelope_id: z.string().optional(),
  payload: z
    .object({
      team_id: z.string().optional(),
      event: SlackMessageEventSchema.optional().catch(undefined),
      type: z.string().optional().catch(undefined),
      user: z.object({ id: z.string() }).optional().catch(undefined),
      channel: z.object({ id: z.string() }).optional().catch(undefined),
      actions: z.array(z.json()).optional().catch(undefined),
      container: z.object({ message_ts: z.string().optional() }).optional().catch(undefined),
      message: z.object({ ts: z.string().optional(), thread_ts: z.string().optional() }).optional().catch(undefined),
    })
    .optional().catch(undefined),
  reason: z.string().optional(),
});

export type SocketEnvelope = z.infer<typeof SocketEnvelopeSchema>;
