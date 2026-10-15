import { z } from "zod";

/**
 * Slack wire shapes this driver consumes — the message event inside an
 * `events_api` envelope the SDK listener hands over, and a block-action
 * interaction. Only the fields the driver reads are declared; the full raw
 * payload rides `InboundMessage.raw`.
 */
export const SlackMessageEventSchema = z.object({
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
  files: z
    .array(
      z.object({
        id: z.string().optional(),
        url_private_download: z.string().optional(),
        url_private: z.string().optional(),
        mimetype: z.string().optional(),
        name: z.string().optional(),
        size: z.number().optional(),
      }),
    )
    .optional(),
  ts: z.string().optional(),
  thread_ts: z.string().optional(),
  reaction: z.string().optional(),
  item: z.object({ channel: z.string(), ts: z.string() }).optional(),
  /** Present on `message_changed`: the edited message's own user and text, not the envelope's. */
  message: z
    .object({
      user: z.string().optional(),
      text: z.string().optional(),
      files: z
        .array(
          z.object({
            id: z.string().optional(),
            url_private_download: z.string().optional(),
            url_private: z.string().optional(),
            mimetype: z.string().optional(),
            name: z.string().optional(),
            size: z.number().optional(),
          }),
        )
        .optional(),
      bot_id: z.string().optional(),
    })
    .optional(),
});

export type SlackMessageEvent = z.infer<typeof SlackMessageEventSchema>;

export const SlackInteractionSchema = z.object({
  type: z.literal("block_actions"),
  user: z.object({ id: z.string() }),
  channel: z.object({ id: z.string() }),
  actions: z
    .tuple([
      z.object({
        action_id: z.string(),
        action_ts: z.string(),
        text: z.object({ text: z.string() }),
      }),
    ])
    .rest(z.json()),
  container: z.object({ message_ts: z.string().optional() }).optional(),
  message: z.object({ ts: z.string().optional(), thread_ts: z.string().optional() }).optional(),
});
export type SlackInteraction = z.infer<typeof SlackInteractionSchema>;
