import { z } from "zod";

const DiscordUserSchema = z.object({
  id: z.string(),
  username: z.string(),
  bot: z.boolean().optional(),
});

/**
 * MESSAGE_CREATE dispatch body — THE typed boundary where a gateway event
 * the SDK listener hands over becomes a message. The SDK spreads the event
 * and overwrites `type` with the dispatch name, so nothing here reads it.
 */
export const DiscordMessageSchema = z.object({
  id: z.string(),
  channel_id: z.string(),
  guild_id: z.string().optional(),
  author: DiscordUserSchema,
  content: z.string(),
  attachments: z
    .array(
      z.object({
        url: z.string(),
        content_type: z.string().optional(),
        filename: z.string(),
        size: z.number(),
      }),
    )
    .optional(),
  mentions: z.array(DiscordUserSchema).optional(),
  message_reference: z
    .object({
      message_id: z.string().optional(),
      channel_id: z.string().optional(),
      guild_id: z.string().optional(),
    })
    .optional(),
});

export type DiscordMessage = z.infer<typeof DiscordMessageSchema>;

export const DiscordReactionSchema = z.object({
  user_id: z.string(),
  message_id: z.string(),
  channel_id: z.string(),
  guild_id: z.string().optional(),
  emoji: z.object({ name: z.string().nullable() }),
  member: z.object({ user: DiscordUserSchema.optional() }).optional(),
});
export type DiscordReaction = z.infer<typeof DiscordReactionSchema>;

/**
 * A component interaction (a button tap). The numeric interaction `type`
 * is overwritten by the SDK's dispatch name, so a component is recognized by
 * its `data.custom_id`; slash commands carry `data.name` instead and never
 * parse here.
 */
export const DiscordInteractionSchema = z.object({
  id: z.string(),
  token: z.string(),
  channel_id: z.string(),
  guild_id: z.string().optional(),
  member: z.object({ user: DiscordUserSchema.optional() }).optional(),
  user: DiscordUserSchema.optional(),
  data: z.object({ custom_id: z.string() }),
  message: z
    .object({
      id: z.string(),
      components: z
        .array(
          z.object({
            custom_id: z.string().optional(),
            label: z.string().optional(),
            components: z
              .array(
                z.object({
                  custom_id: z.string().optional(),
                  label: z.string().optional(),
                }),
              )
              .optional(),
          }),
        )
        .optional(),
    })
    .optional(),
});
export type DiscordInteraction = z.infer<typeof DiscordInteractionSchema>;
