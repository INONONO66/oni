import { z } from "zod";

export const ScreenBlocker = z.object({
  kind: z.enum([
    "screen_recording_denied", "accessibility_denied", "no_console_user",
    "other_console_user", "display_asleep", "no_x_display", "x_auth_refused",
    "x_display_forwarded", "wayland_only_no_x", "missing_x_libs",
    "no_atspi_bus", "observer_unavailable", "surface_enumeration_unavailable", "session_zero", "window_manager_missing",
    "input_monitoring_not_granted", "no_screen_backend", "input_backend_unavailable",
  ]),
  detail: z.string().optional(),
}).strict();
export type ScreenBlocker = z.infer<typeof ScreenBlocker>;

export const Screen = z.object({
  verdict: z.enum(["available", "partial", "unavailable"]),
  blockers: z.array(ScreenBlocker),
  display: z.object({
    kind: z.enum(["console", "virtual", "none"]),
    id: z.string().optional(),
    isolated: z.boolean(),
  }).strict(),
  grants: z.object({
    capture: z.boolean(),
    accessibility: z.boolean(),
    input: z.boolean(),
  }).strict(),
}).strict();
export type Screen = z.infer<typeof Screen>;
