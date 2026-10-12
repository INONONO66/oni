import { z } from "zod";

const Id = z.string().min(1);
const SessionRef = z.string().regex(/^session:.+/);

export const WindowSeconds = z.union([
  z.literal(0),
  z.literal(5),
  z.literal(10),
  z.literal(20),
  z.literal(30),
  z.literal(60),
]);
export type WindowSeconds = z.infer<typeof WindowSeconds>;

export const Trigger = z.discriminatedUnion("type", [
  z.object({ type: z.literal("schedule"), cron: Id, tz: Id }).strict(),
  z
    .object({ type: z.literal("message"), surface: Id, event: z.enum(["message", "reaction", "mention"]) })
    .strict(),
  z.object({ type: z.literal("webhook"), secretRef: Id }).strict(),
  z.object({ type: z.literal("github"), event: Id }).strict(),
  z.object({ type: z.literal("on_demand") }).strict(),
]);
export type Trigger = z.infer<typeof Trigger>;

export const Conditions = z
  .object({
    channels: z.array(Id).min(1).optional(),
    users: z.array(Id).min(1).optional(),
    threads: z.array(Id).min(1).optional(),
    contains: z.array(z.string().min(1)).min(1).optional(),
    excludes: z.array(z.string().min(1)).min(1).optional(),
    regex: z.array(z.string().min(1)).min(1).optional(),
    includeBots: z.boolean().optional(),
    dm: z.boolean().optional(),
    mentionOnly: z.boolean().optional(),
  })
  .strict();
export type Conditions = z.infer<typeof Conditions>;

export const Automation = z
  .object({
    id: Id,
    name: z.string(),
    enabled: z.boolean(),
    createdBy: z.union([z.literal("owner"), SessionRef]),
    triggers: z.array(Trigger).min(1),
    conditions: Conditions.optional(),
    runWhen: z.string().optional(),
    grouping: z
      .object({ windowSeconds: WindowSeconds, by: z.enum(["thread", "channel", "author"]) })
      .strict()
      .optional(),
    target: z.union([z.literal("new"), SessionRef]),
    kind: z.enum(["prompt", "action"]).default("action"),
    instructions: z.string().optional(),
    limits: z.object({ maxRunsPerDay: z.number().int().positive() }).strict().optional(),
  })
  .strict();
export type Automation = z.infer<typeof Automation>;

export const TriggerContext = z
  .object({
    automationId: Id,
    trigger: Trigger,
    matched: z
      .object({
        conditions: Conditions,
        runWhen: z
          .object({ verdict: z.enum(["yes", "no", "unknown"]), reason: z.string() })
          .strict()
          .optional(),
      })
      .strict(),
    event: z
      .object({
        surface: Id,
        channelId: Id.optional(),
        threadId: Id.optional(),
        author: z.object({ externalId: Id, isBot: z.boolean() }).strict(),
        messages: z
          .array(
            z
              .object({ eventId: Id, body: z.string(), receivedAt: z.number() })
              .strict(),
          )
          .min(1)
          .max(64),
      })
      .strict(),
  })
  .strict();
export type TriggerContext = z.infer<typeof TriggerContext>;
