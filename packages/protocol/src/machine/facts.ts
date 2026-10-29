import { z } from "zod";
import { EpochMs } from "../time.js";

export const HumanInput = z.object({
  lastAt: EpochMs,
  source: z.enum(["pointer", "keyboard", "both"]),
  events: z.number().int().nonnegative(),
}).strict();
export type HumanInput = z.infer<typeof HumanInput>;

export const Session = z.object({
  locked: z.boolean(),
  asleep: z.boolean(),
}).strict();
export type Session = z.infer<typeof Session>;

export const HumanInputUnavailable = z.enum(["input_monitoring_not_granted"]);
export type HumanInputUnavailable = z.infer<typeof HumanInputUnavailable>;

export const HumanInputNotification = z.object({
  machineId: z.string().min(1),
  at: EpochMs,
  source: z.enum(["pointer", "keyboard"]),
}).strict();
export type HumanInputNotification = z.infer<typeof HumanInputNotification>;
