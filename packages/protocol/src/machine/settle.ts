import { z } from "zod";
import { WindowTarget } from "./observe.js";
import { ObservationId } from "./schema.js";
import { ComputerCancelled } from "./lease.js";

export const ScreenSettleRequest = z.object({
  target: WindowTarget.required({ epoch: true }),
  quietMs: z.number().int().min(50).max(2000).optional(),
  timeoutMs: z.number().int().min(100).max(30_000).default(5000),
}).strict();
export type ScreenSettleRequest = z.input<typeof ScreenSettleRequest>;

export const ScreenSettleResult = z.union([
  ComputerCancelled,
  z.object({ status: z.literal("settled"), method: z.literal("accessibility"), observationId: ObservationId }).strict(),
  z.object({ status: z.literal("settled"), method: z.literal("pixels"), captureId: z.string().min(1) }).strict(),
  z.object({ status: z.literal("pending"), method: z.literal("accessibility"), observationId: ObservationId, changesInWindow: z.number().int().nonnegative() }).strict(),
  z.object({ status: z.literal("pending"), method: z.literal("pixels"), changesInWindow: z.number().int().nonnegative() }).strict(),
  z.object({ status: z.literal("unsupported"), blocker: z.enum(["accessibility_not_granted", "no_observer"]) }).strict(),
  z.object({ status: z.literal("destroyed") }).strict(),
  z.object({ status: z.literal("refused"), reason: z.enum([
    "window_not_found", "epoch_changed", "permission_denied", "machine_not_attached",
    "lease_missing", "lease_expired", "target_unbound", "app_out_of_scope",
    "foreground_not_granted", "excluded", "paused:human_input", "paused:takeover",
    "paused:private", "paused:locked", "paused:asleep",
  ]), message: z.string().min(1).max(256).optional() }).strict(),
]);
export type ScreenSettleResult = z.infer<typeof ScreenSettleResult>;
