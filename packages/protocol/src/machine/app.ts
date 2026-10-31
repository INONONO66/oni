import { z } from "zod";
import { WindowTarget } from "./target.js";
import { ComputerCancelled } from "./lease.js";

const Pid = z.number().int().min(1).max(2_147_483_647);
const Text = z.string().min(1).max(4096);
const EnvironmentKey = z.enum([
  "DISPLAY", "XAUTHORITY", "WAYLAND_DISPLAY", "XDG_SESSION_TYPE",
  "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR", "HOME", "PATH", "LANG",
]);
const Refused = z.object({
  status: z.literal("refused"),
  reason: z.enum([
    "app_not_found", "launch_failed", "excluded", "permission_denied",
    "machine_not_attached", "unsupported", "process_not_found",
    "epoch_changed", "window_not_found",
    "lease_missing", "lease_expired", "target_unbound", "app_out_of_scope",
    "foreground_not_granted", "stale_capture", "stale_observation", "paused:human_input", "paused:takeover",
    "paused:private", "paused:locked", "paused:asleep", "budget_exhausted", "private", "clipboard_not_granted",
  ]),
  blocker: z.enum(["launch_timeout", "launch_failed", "platform"]).optional(),
  message: z.string().min(1).max(256).optional(),
  humanActiveMs: z.number().int().nonnegative().optional(),
  retryAfterMs: z.number().int().nonnegative().optional(),
  resetAt: z.number().nonnegative().optional(),
}).strict();

export const AppLaunchRequest = z.object({
  app: z.union([
    z.object({ bundleId: z.string().min(1).max(256) }).strict(),
    z.object({ path: Text, args: z.array(z.string().max(4096)).max(256).optional() }).strict(),
  ]),
  activate: z.literal(false),
  env: z.partialRecord(EnvironmentKey, z.string().max(4096)).optional(),
  freshInstance: z.boolean().optional(),
  timeoutMs: z.number().int().positive().optional(),
}).strict();
export type AppLaunchRequest = z.infer<typeof AppLaunchRequest>;

export const AppLaunchResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), pid: Pid, windows: z.array(WindowTarget.required({ epoch: true })).max(512) }).strict(),
  Refused,
  ComputerCancelled,
]);
export type AppLaunchResult = z.infer<typeof AppLaunchResult>;

export const AppQuitRequest = z.object({ pid: Pid }).strict();
export type AppQuitRequest = z.infer<typeof AppQuitRequest>;
export const AppQuitResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), exited: z.boolean() }).strict(), Refused, ComputerCancelled,
]);
export type AppQuitResult = z.infer<typeof AppQuitResult>;

export const WindowCloseRequest = z.object({ target: WindowTarget.required({ epoch: true }) }).strict();
export type WindowCloseRequest = z.infer<typeof WindowCloseRequest>;
export const WindowCloseResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), closed: z.boolean() }).strict(), Refused, ComputerCancelled,
]);
export type WindowCloseResult = z.infer<typeof WindowCloseResult>;
export const WindowParkRequest = z.object({ target: WindowTarget.required({ epoch: true }) }).strict();
export type WindowParkRequest = z.infer<typeof WindowParkRequest>;
export const WindowParkResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), parked: z.boolean() }).strict(), Refused, ComputerCancelled,
]);
export type WindowParkResult = z.infer<typeof WindowParkResult>;
