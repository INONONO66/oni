import { z } from "zod";

export const ScreenBlocker = z.object({
  kind: z.enum([
    "screen_recording_denied", "accessibility_denied", "no_console_user",
    "other_console_user", "display_asleep", "no_x_display", "x_auth_refused",
    "x_display_forwarded", "wayland_only_no_x", "missing_x_libs",
    "no_atspi_bus", "observer_unavailable", "session_zero", "window_manager_missing",
    "input_monitoring_not_granted", "no_screen_backend", "input_backend_unavailable",
    "accessibility_unavailable",
    "restart_bound",
  ]),
  detail: z.string().optional(),
}).strict();
export type ScreenBlocker = z.infer<typeof ScreenBlocker>;

export const ScreenNeedStep = z.enum([
  "screen_recording_grant", "accessibility_grant", "portal_consent",
  "service_install", "linger_enable", "uinput_group", "console_login", "x11_session",
]);
export type ScreenNeedStep = z.infer<typeof ScreenNeedStep>;

export const ScreenNeed = z.object({
  step: ScreenNeedStep,
  action: z.string().min(1),
  onScreen: z.boolean(),
  blocker: ScreenBlocker.shape.kind.optional(),
}).strict();
export type ScreenNeed = z.infer<typeof ScreenNeed>;

export const Screen = z.object({
  verdict: z.enum(["available", "partial", "unavailable"]),
  blockers: z.array(ScreenBlocker),
  needs: z.array(ScreenNeed).optional(),
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
}).strict().superRefine((screen, ctx) => {
  if (screen.verdict === "available" && screen.needs !== undefined)
    ctx.addIssue({ code: "custom", path: ["needs"], message: "available screen has no needs" });
});
export type Screen = z.infer<typeof Screen>;
