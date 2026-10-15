import { z } from "zod";
import { BusEvent } from "../bus/index.js";
import { CapabilityId, Load, MachineId, uniqueCapabilities } from "./schema.js";
import { EpochMs } from "../time.js";

const EventBase = z.object({
  machineId: MachineId,
  time: EpochMs,
});

export const Events = {
  /** A daemon attached and negotiation settled: this is the effective set in force. */
  Attached: BusEvent.define(
    "machine.attached",
    EventBase.extend({
      effectiveCapabilities: z.array(CapabilityId).superRefine(uniqueCapabilities),
    }),
    { visibility: "llm_reason" },
  ),
  Detached: BusEvent.define("machine.detached", EventBase.extend({ reason: z.string().min(1) }), {
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
} as const;
