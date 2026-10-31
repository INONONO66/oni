import { z } from "zod";
import type { JsonShapedValue } from "../json.js";
import { Report } from "./schema.js";

const ReportV3 = Report.extend({
  screen: z.object({ permission: z.enum(["granted", "denied", "unsupported"]) }).strict().optional(),
  humanInputUnavailable: z.literal("input_monitoring_not_granted").optional(),
});

/** Decode the admitted peer's report once; v3 proves capture only, never input or AX. */
export function decodeReport(version: number, value: JsonShapedValue) {
  if (version !== 3) return Report.safeParse(value);
  const parsed = ReportV3.safeParse(value);
  if (!parsed.success) return parsed;
  const { screen, humanInputUnavailable, ...report } = parsed.data;
  if (screen === undefined && humanInputUnavailable === undefined) return Report.safeParse(report);
  const permission = screen?.permission ?? "unsupported";
  const capture = permission === "granted";
  return Report.safeParse({
    ...report,
    screen: {
      verdict: capture ? "partial" : "unavailable",
      blockers: [
        { kind: permission === "unsupported" ? "no_screen_backend"
          : capture ? "accessibility_denied" : "screen_recording_denied" },
        ...(humanInputUnavailable === undefined ? [] : [{ kind: humanInputUnavailable }]),
      ],
      display: { kind: permission === "unsupported" ? "none" : "console", isolated: false },
      grants: { capture, accessibility: false, input: false },
    },
  });
}
