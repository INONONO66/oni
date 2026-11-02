import { Bundle } from "@oni/agent";
import { Machine } from "@oni/protocol";
import { z } from "zod";

export const ChildWatch = z.strictObject({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  contact: z.string().min(1),
  child: z.string().min(1),
  turn: z.string().min(1),
  machine: z.string().min(1),
  cursor: Machine.AgentSessionCursor,
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
