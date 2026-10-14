import { z } from "zod";

export const TelegramUserSchema = z.object({
  id: z.number(),
  is_bot: z.boolean(),
  first_name: z.string(),
  username: z.string().optional(),
});

const TelegramChatSchema = z.object({
  id: z.number(),
  type: z.enum(["private", "group", "supergroup", "channel"]),
  title: z.string().optional(),
  first_name: z.string().optional(),
  username: z.string().optional(),
});

const TelegramEntitySchema = z.object({
  type: z.string(),
  offset: z.number().int().nonnegative(),
  length: z.number().int().nonnegative(),
  user: TelegramUserSchema.optional(),
});

export interface TelegramMessage {
  message_id: number;
  from?: z.infer<typeof TelegramUserSchema>;
  chat: z.infer<typeof TelegramChatSchema>;
  date: number;
  text?: string;
  entities?: z.infer<typeof TelegramEntitySchema>[];
  caption?: string;
  caption_entities?: z.infer<typeof TelegramEntitySchema>[];
  photo?: { file_id: string; file_size?: number }[];
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  voice?: { file_id: string; mime_type?: string; file_size?: number };
  audio?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  sticker?: { file_id: string; is_animated?: boolean; is_video?: boolean; file_size?: number };
  reply_to_message?: TelegramMessage;
  message_thread_id?: number;
  is_topic_message?: boolean;
}

/** Recursive (`reply_to_message`) — the interface above carries the type, z.lazy the runtime shape. */
const TelegramMessageSchema: z.ZodType<TelegramMessage> = z.lazy(() =>
  z.object({
    message_id: z.number(),
    from: TelegramUserSchema.optional(),
    chat: TelegramChatSchema,
    date: z.number(),
    text: z.string().optional(),
    entities: z.array(TelegramEntitySchema).optional(),
    caption: z.string().optional(),
    caption_entities: z.array(TelegramEntitySchema).optional(),
    photo: z.array(z.object({ file_id: z.string(), file_size: z.number().optional() })).optional(),
    document: z.object({
      file_id: z.string(), file_name: z.string().optional(),
      mime_type: z.string().optional(), file_size: z.number().optional(),
    }).optional(),
    voice: z.object({
      file_id: z.string(), mime_type: z.string().optional(), file_size: z.number().optional(),
    }).optional(),
    audio: z.object({
      file_id: z.string(), file_name: z.string().optional(),
      mime_type: z.string().optional(), file_size: z.number().optional(),
    }).optional(),
    sticker: z.object({
      file_id: z.string(), is_animated: z.boolean().optional(), is_video: z.boolean().optional(),
      file_size: z.number().optional(),
    }).optional(),
    reply_to_message: TelegramMessageSchema.optional(),
    message_thread_id: z.number().optional(),
    is_topic_message: z.boolean().optional(),
  }),
);

const TelegramReactionSchema = z.object({
  chat: TelegramChatSchema,
  message_id: z.number(),
  user: TelegramUserSchema.optional(),
  actor_chat: TelegramChatSchema.optional(),
  date: z.number(),
  new_reaction: z.array(z.object({ type: z.string(), emoji: z.string().optional() })),
});
export type TelegramReaction = z.infer<typeof TelegramReactionSchema>;

export const TelegramUpdateSchema = z.object({
  update_id: z.number(),
  message: TelegramMessageSchema.optional(),
  message_reaction: TelegramReactionSchema.optional(),
});

export type TelegramUser = z.infer<typeof TelegramUserSchema>;
export type TelegramUpdate = z.infer<typeof TelegramUpdateSchema>;
