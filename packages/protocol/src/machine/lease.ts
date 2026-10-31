import { z } from "zod";
import { EpochMs } from "../time.js";
import { AppIdentity } from "./schema.js";
import { WindowTarget } from "./target.js";

const Identity = z.string().min(1).max(4096);
const Apps = z.union([z.array(Identity).min(1).max(512), z.literal("any")]);
const Purpose = z.string().min(1).max(4096);
const Budget = z.object({ actionsPerHour: z.number().int().positive() }).strict();
const Lease = z.object({
  sessionId: z.string().min(1),
  machineId: z.string().min(1),
  apps: Apps,
  foreground: z.object({ purpose: Purpose, expiresAt: EpochMs }).strict().optional(),
  expiresAt: EpochMs,
  budget: Budget.default({ actionsPerHour: 1500 }),
  admittedAt: z.array(EpochMs).default([]),
  usage: z.object({ count: z.number().int().nonnegative(), resetAt: EpochMs.nullable() }).strict().optional(),
  revision: z.number().int().positive(),
});

export const ComputerLease = z.discriminatedUnion("state", [
  Lease.extend({ state: z.literal("active") }).strict(),
  Lease.extend({
    state: z.literal("paused"),
    pauseReason: z.enum(["human_input", "takeover", "private", "locked", "asleep"]),
  }).strict(),
  Lease.extend({
    state: z.literal("ended"),
    endReason: z.enum(["expired", "stopped", "owner_ended", "detached"]),
  }).strict(),
]);
export type ComputerLease = z.infer<typeof ComputerLease>;

export const ComputerRequest = z.object({
  apps: Apps,
  budget: Budget.optional(),
  foreground: z.object({ purpose: Purpose }).strict().optional(),
  minutes: z.number().int().min(5).max(120),
}).strict();
export type ComputerRequest = z.infer<typeof ComputerRequest>;

export const ComputerExclusion = z.object({
  machineId: z.string().min(1),
  app: Identity,
}).strict();
export type ComputerExclusion = z.infer<typeof ComputerExclusion>;

export const ComputerWindow = z.object({
  pid: z.number().int().positive(),
  windowId: z.number().int().nonnegative(),
  app: z.union([AppIdentity, z.object({ bundleId: z.string().min(1).max(256) }).strict()]),
  epoch: z.number().int().nonnegative().optional(),
}).strict();
export type ComputerWindow = z.infer<typeof ComputerWindow>;

export const ComputerRefusal = z.discriminatedUnion("reason", [
  z.object({
    status: z.literal("refused"),
    reason: z.enum([
      "permission_denied", "lease_missing", "lease_expired", "target_unbound",
      "app_out_of_scope", "foreground_not_granted", "excluded",
      "stale_capture", "stale_observation",
      "paused:takeover", "paused:private", "paused:locked", "paused:asleep",
    ]),
    message: z.string().min(1).max(256).optional(),
  }).strict(),
  z.object({
    status: z.literal("refused"),
    reason: z.literal("paused:human_input"),
    humanActiveMs: z.number().int().nonnegative(),
    retryAfterMs: z.number().int().nonnegative(),
    message: z.string().min(1).max(256).optional(),
  }).strict(),
  z.object({
    status: z.literal("refused"),
    reason: z.literal("budget_exhausted"),
    resetAt: EpochMs,
  }).strict(),
]);
export type ComputerRefusal = z.infer<typeof ComputerRefusal>;

export const ComputerCancelled = z.object({
  status: z.literal("unverifiable"),
  reason: z.literal("cancelled"),
  dispatched: z.literal("unknown"),
  hint: z.literal("re_observe"),
}).strict();
export type ComputerCancelled = z.infer<typeof ComputerCancelled>;

export const ComputerKeep = z.object({
  machineId: z.string().min(1),
  target: z.union([z.number().int().positive(), WindowTarget.required({ epoch: true })]),
  reason: z.enum(["deliverable", "handoff"]),
}).strict();
export type ComputerKeep = z.infer<typeof ComputerKeep>;

export const ComputerCloseRequest = z.object({
  generation: z.number().int().positive(),
  through: z.number().int().positive(),
}).strict();
export type ComputerCloseRequest = z.infer<typeof ComputerCloseRequest>;
export const ComputerCloseResult = z.object({ status: z.literal("closed") }).strict();
export type ComputerCloseResult = z.infer<typeof ComputerCloseResult>;
