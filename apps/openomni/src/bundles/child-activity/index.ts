import { Bundle } from "@openomni/agent";
import { TranscriptRef } from "@openomni/protocol";
import { z } from "zod";

const Location = TranscriptRef.pick({ machine: true, export: true, path: true, parser: true });
export const ChildWatch = z.strictObject({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  child: z.string().min(1),
  turn: z.string().min(1),
  occupant: z.strictObject({ command: z.string().min(1), version: z.string().optional() }),
  /** Verified locations supplied by the child's launcher or attachment. */
  spool: Location.optional(),
  transcript: Location.optional(),
});
export type ChildWatch = z.infer<typeof ChildWatch>;
export const CHILD_WATCH = "child.watch";

export function childActivityPurposes(cadence: Bundle.AlarmPurposeHandler): Bundle.AlarmBundlePurposes {
  return { bundle: "child-activity", purposes: [{ name: CHILD_WATCH, handler: cadence }] };
}

/** Uses the existing alarm cadence and action intake; it declares no new journal kind. */
export function childActivityBundle(cadence: Bundle.AlarmPurposeHandler) {
  return Bundle.define({
    name: "child-activity",
    requires: [Bundle.AlarmPort, Bundle.ActionPort],
    purposes: { [CHILD_WATCH]: cadence },
  });
}
