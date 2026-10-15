import { z } from "zod";

export const GatewayOp = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const;

export const Intents = {
  GUILDS: 1 << 0,
  GUILD_MESSAGES: 1 << 9,
  GUILD_MESSAGE_REACTIONS: 1 << 10,
  DIRECT_MESSAGES: 1 << 12,
  DIRECT_MESSAGE_REACTIONS: 1 << 13,
  MESSAGE_CONTENT: 1 << 15,
} as const;

const DiscordUserSchema = z.object({
  id: z.string(),
  username: z.string(),
  bot: z.boolean().optional(),
});

/** MESSAGE_CREATE dispatch body — THE typed boundary where a gateway frame becomes a message. */
export const DiscordMessageSchema = z.object({
  id: z.string(),
  channel_id: z.string(),
  guild_id: z.string().optional(),
  author: DiscordUserSchema,
  content: z.string(),
  attachments: z.array(z.object({
    url: z.string(),
    content_type: z.string().optional(),
    filename: z.string(),
    size: z.number(),
  })).optional(),
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

export const DiscordInteractionSchema = z.object({
  id: z.string(),
  token: z.string(),
  type: z.literal(3),
  channel_id: z.string(),
  guild_id: z.string().optional(),
  member: z.object({ user: DiscordUserSchema.optional() }).optional(),
  user: DiscordUserSchema.optional(),
  data: z.object({ custom_id: z.string() }),
  message: z.object({
    id: z.string(),
    components: z.array(z.object({
      custom_id: z.string().optional(),
      label: z.string().optional(),
      components: z.array(z.object({
        custom_id: z.string().optional(),
        label: z.string().optional(),
      })).optional(),
    })).optional(),
  }).optional(),
});
export type DiscordInteraction = z.infer<typeof DiscordInteractionSchema>;

/** Outer gateway frame; `d` stays op-specific and is parsed at each op's arm. */
export const GatewayFrameSchema = z.object({
  op: z.number(),
  d: z.json().optional(),
  s: z.number().nullish(),
  t: z.string().nullish(),
});
export type GatewayFrame = z.infer<typeof GatewayFrameSchema>;
export const HelloDataSchema = z.object({ heartbeat_interval: z.number() });
export const ReadyDataSchema = z.object({
  session_id: z.string(),
  resume_gateway_url: z.string(),
  user: DiscordUserSchema,
});
