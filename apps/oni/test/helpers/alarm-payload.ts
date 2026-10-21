import type { PlainValue } from "@oni/protocol";
import { z } from "zod";

// JSON.parse returns a JSON value, not an alarm payload. No narrowing cast:
// the domain schema validates every field after this primitive boundary.
const decodeJson: (content: string) => PlainValue = JSON.parse;
const summary = z
  .object({
    watchId: z.string().min(1),
    reason: z.enum(["exit", "source_error"]),
    exitCode: z.number().int().nullable(),
  })
  .strict();
const pathEvent = z.object({ path: z.string(), event: z.enum(["create", "modify"]) }).strict();

export function alarmSummary(content: string): z.infer<typeof summary> {
  return summary.parse(decodeJson(content));
}

export function alarmPathEvent(content: string): z.infer<typeof pathEvent> {
  return pathEvent.parse(decodeJson(content));
}
