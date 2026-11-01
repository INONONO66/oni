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

export const HumanInputNotification = z.object({
  machineId: z.string().min(1),
  at: EpochMs,
  source: z.enum(["pointer", "keyboard", "clipboard"]),
}).strict();
export type HumanInputNotification = z.infer<typeof HumanInputNotification>;

export const TransportFailureClass = z.enum([
  "authentication", "configuration", "host_unreachable", "remote_unavailable", "timeout", "superseded",
]);

export const TransportFacts = z.object({
  lastFailure: TransportFailureClass.nullable(),
  attempts: z.number().int().nonnegative(),
}).strict();
export type TransportFacts = z.infer<typeof TransportFacts>;

export const PingResult = z.object({ status: z.literal("alive") }).strict();
export type PingResult = z.infer<typeof PingResult>;
