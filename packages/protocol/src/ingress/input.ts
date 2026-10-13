import { z } from "zod";
import { EpochMs } from "../time.js";

const Id = z.string().min(1);

export const Author = z.object({ externalId: Id, isBot: z.boolean() }).strict();
export type Author = z.infer<typeof Author>;

export const Input = z
  .object({
    eventId: Id,
    surface: Id,
    event: z.enum(["message", "reaction", "mention", "webhook", "github", "schedule"]),
    channelId: Id.optional(),
    threadId: Id.optional(),
    workspaceId: Id.optional(),
    author: Author,
    dm: z.boolean(),
    mentionsBot: z.boolean(),
    body: z.string(),
    receivedAt: EpochMs,
  })
  .strict();

export type Input = z.infer<typeof Input>;
