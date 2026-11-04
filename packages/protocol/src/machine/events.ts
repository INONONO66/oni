import { z } from "zod";
import { BusEvent } from "../bus/index.js";
import { CapabilityId, Enrollment, LeaseRefusal, Load, MachineId, PeerLease, PeerLeaseOp, PtyCursor, PtySessionName, uniqueCapabilities } from "./schema.js";
import { EpochMs } from "../time.js";
import { HumanInputNotification } from "./facts.js";
import { PrivateEvent, WindowTarget } from "./observe.js";

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
    reason: z.enum(["connection_closed", "host_closed", "enrollment_removed", "enrollment_replaced", "superseded_by_reattach", "superseded", "ping_timeout"]),
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
  HumanInput: BusEvent.define("machine.human_input", HumanInputNotification.extend({ time: EpochMs }), {
    visibility: "llm_reason",
  }),
  PtyOutput: BusEvent.define("machine.pty_output", EventBase.extend({
    name: PtySessionName,
    bytes: z.number().int().nonnegative(),
    cursor: PtyCursor,
  }), { visibility: "llm_reason" }),
  Private: BusEvent.define("machine.private", EventBase.extend({
    target: WindowTarget.required({ epoch: true }),
    state: z.enum(["entered", "left"]),
    reason: PrivateEvent.shape.reason.optional(),
  }), { visibility: "llm_reason" }),
  /**
   * Peer lease receipts (#1841). `machineId` is the lease's `from` machine, the
   * one whose reach grew; `issued` carries the whole record, `used` names the
   * op routed under it, `ended` says whether the clock or the host ended it.
   */
  PeerLeaseIssued: BusEvent.define("machine.peer_lease_issued", EventBase.extend({ lease: PeerLease }), {
    visibility: "llm_reason",
  }),
  PeerLeaseUsed: BusEvent.define("machine.peer_lease_used", EventBase.extend({
    leaseId: PeerLease.shape.id,
    to: MachineId,
    op: PeerLeaseOp,
  }), { visibility: "llm_reason" }),
  PeerLeaseEnded: BusEvent.define("machine.peer_lease_ended", EventBase.extend({
    leaseId: PeerLease.shape.id,
    to: MachineId,
    reason: z.enum(["expired", "revoked"]),
  }), { visibility: "llm_reason" }),
} as const;
