import { z } from "zod";
import { BusEvent } from "../bus/index.js";
import { CapabilityId, Enrollment, LeaseRefusal, Load, MachineId, PtyCursor, PtySessionName, uniqueCapabilities } from "./schema.js";
import { EpochMs } from "../time.js";

const EventBase = z.object({
  machineId: MachineId,
  time: EpochMs,
});

export const Events = {
  Enrolled: BusEvent.define("machine.enrolled", EventBase.extend({ enrollment: Enrollment }), {
    visibility: "llm_reason",
  }),
  Unenrolled: BusEvent.define("machine.unenrolled", EventBase, { visibility: "llm_reason" }),
  LeaseRefused: BusEvent.define("machine.lease_refused", LeaseRefusal.extend({ time: EpochMs }), {
    visibility: "llm_reason",
  }),
  /** A daemon attached and negotiation settled: this is the effective set in force. */
  Attached: BusEvent.define(
    "machine.attached",
    EventBase.extend({
      effectiveCapabilities: z.array(CapabilityId).superRefine(uniqueCapabilities),
    }),
    { visibility: "llm_reason" },
  ),
  Detached: BusEvent.define("machine.detached", EventBase.extend({
    reason: z.enum(["connection_closed", "superseded_by_reattach", "host_closed", "enrollment_removed", "enrollment_replaced"]),
  }), {
    visibility: "llm_reason",
  }),
  /**
   * The host accepted one `machine.report` heartbeat (#1555): `time` is the
   * host's receipt like every machine event, `reportedAt` the daemon's own
   * clock. Ephemeral: a beat every few seconds per machine is not a reason.
   */
  Reported: BusEvent.define("machine.reported", EventBase.extend({ reportedAt: EpochMs, load: Load }), {
    visibility: "ephemeral",
  }),
  PtyOutput: BusEvent.define("machine.pty_output", EventBase.extend({
    name: PtySessionName,
    bytes: z.number().int().nonnegative(),
    cursor: PtyCursor,
  }), { visibility: "llm_reason" }),
} as const;
