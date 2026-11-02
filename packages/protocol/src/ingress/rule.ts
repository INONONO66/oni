import { z } from "zod";
import { EpochMs } from "../time.js";

const Id = z.string().min(1);
const SessionRef = z.string().regex(/^session:.+/);

export const Verdict = z.enum(["yes", "no", "unknown"]);
export type Verdict = z.infer<typeof Verdict>;

export const WindowSeconds = z.union([
  z.literal(0), z.literal(5), z.literal(10), z.literal(20), z.literal(30), z.literal(60),
]);
export type WindowSeconds = z.infer<typeof WindowSeconds>;

export const When = z.object({
  instance: Id,
  channel: Id.optional(),
  dm: z.boolean().optional(),
  event: z.enum(["message", "reaction"]).optional(),
  from: z.array(Id).min(1).optional(),
  addressed: z.boolean().optional(),
  isBot: z.boolean().optional(),
}).strict();

export const Rule = z.object({
  id: Id,
  position: z.number().int().nonnegative(),
  enabled: z.boolean(),
  createdBy: z.union([z.literal("owner"), SessionRef]),
  seed: z.boolean().optional(),
  when: When,
  judge: z.string().optional(),
  group: z.object({ windowSeconds: WindowSeconds, by: z.literal("thread") }).strict().optional(),
  then: z.object({
    target: z.union([z.literal("conversation"), z.literal("new"), SessionRef]),
    agent: Id.optional(),
    kind: z.enum(["prompt", "action"]),
    instructions: z.string().optional(),
    reply: z.enum(["auto", "draft", "none"]),
    as: Id.optional(),
    maxRunsPerDay: z.number().int().positive().optional(),
  }).strict(),
}).strict();
export type Rule = z.infer<typeof Rule>;

export const MatchContext = z.object({
  ruleId: Id,
  when: When,
  verdict: Verdict.optional(),
  event: z.object({
    instance: Id,
    channel: Id.optional(),
    thread: Id.optional(),
    from: Id,
    messages: z.array(z.object({ eventId: Id, body: z.string(), receivedAt: EpochMs }).strict()).min(1).max(64),
  }).strict(),
}).strict();
export type MatchContext = z.infer<typeof MatchContext>;
