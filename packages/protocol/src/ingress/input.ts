import { z } from "zod";

const Id = z.string().min(1);

export const Input = z
  .object({
    eventId: Id,
    surface: Id,
    event: z.enum(["message", "reaction", "mention", "webhook", "github", "schedule"]),
    channelId: Id.optional(),
    threadId: Id.optional(),
    workspaceId: Id.optional(),
    author: z.object({ externalId: Id, isBot: z.boolean() }).strict(),
    dm: z.boolean(),
    mentionsBot: z.boolean(),
    body: z.string(),
    receivedAt: z.number(),
  })
  .strict();

export type Input = z.infer<typeof Input>;
