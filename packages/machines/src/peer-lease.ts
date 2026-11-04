import { type BusEvent, Machine } from "@oni/protocol";
import type { LeaseScheduler } from "./capacity";
import { MachineRefusalError } from "./errors";

/**
 * Host-owned peer leases (#1841): the only way one machine reaches another.
 * Every lease is time-bounded on the host clock and published at issue, at
 * each use and when the clock or the host ends it; the issue fact goes out
 * before the lease is stored, so a sink that refuses it leaves no lease. Nothing
 * here is durable: a restarted host starts with no reach between machines.
 */
export interface PeerLeaseStore {
  /** Issues a lease from the record minus what the host fills (`id`, `expiresAt`); refuses `peer_lease_invalid` for a self lease or a record the contract rejects. */
  issue(request: Omit<Machine.PeerLease, "id" | "expiresAt">): Machine.PeerLease;
  /** Ends a lease early; `undefined` when no such lease is live. */
  revoke(leaseId: string): Machine.PeerLease | undefined;
  /** Ends every live lease `where` selects (a finished delegation, a machine leaving the host), journaling each as `revoked`. */
  revokeAll(where: (lease: Machine.PeerLease) => boolean): Machine.PeerLease[];
  /** The live lease letting `from` reach `to` for `op`, journaling its use; `undefined` refuses. */
  peerLease(
    from: Machine.MachineId,
    to: Machine.MachineId,
    op: Machine.PeerLeaseOp,
  ): Machine.PeerLease | undefined;
  /** Every machine `from` currently holds a lease to. */
  peerTargets(from: Machine.MachineId): Machine.MachineId[];
  list(): Machine.PeerLease[];
}

export function createPeerLeases(options: {
  readonly id: () => string;
  readonly now: () => number;
  readonly events: BusEvent.Sink;
  readonly scheduler?: LeaseScheduler;
}): PeerLeaseStore {
  const leases = new Map<string, { readonly lease: Machine.PeerLease; cancel?: () => void }>();
  function end(leaseId: string, reason: "expired" | "revoked"): Machine.PeerLease | undefined {
    const entry = leases.get(leaseId);
    if (entry === undefined) return undefined;
    leases.delete(leaseId);
    entry.cancel?.();
    options.events.publish(Machine.Events.PeerLeaseEnded, {
      machineId: entry.lease.from,
      time: options.now(),
      leaseId,
      to: entry.lease.to,
      reason,
    });
    return entry.lease;
  }
  function live(): Machine.PeerLease[] {
    const now = options.now();
    for (const { lease } of [...leases.values()])
      if (lease.expiresAt <= now) end(lease.id, "expired");
    return [...leases.values()].map((entry) => entry.lease);
  }
  function arm(lease: Machine.PeerLease): (() => void) | undefined {
    const expire = (): void => {
      const entry = leases.get(lease.id);
      if (entry === undefined) return;
      const remaining = lease.expiresAt - options.now();
      if (remaining > 0) entry.cancel = options.scheduler?.schedule(remaining, expire);
      else end(lease.id, "expired");
    };
    return options.scheduler?.schedule(lease.ttlMs, expire);
  }
  function revokeAll(where: (lease: Machine.PeerLease) => boolean): Machine.PeerLease[] {
    const ended = live().filter(where);
    for (const lease of ended) end(lease.id, "revoked");
    return ended;
  }
  return {
    issue(request) {
      const parsed = Machine.PeerLease.safeParse({
        ...request,
        id: options.id(),
        expiresAt: options.now() + request.ttlMs,
      });
      if (!parsed.success || parsed.data.from === parsed.data.to)
        throw new MachineRefusalError({
          reason: "peer_lease_invalid",
          message: `peer_lease_invalid: ${parsed.success ? "a machine needs no lease to itself" : parsed.error.issues.map((issue) => issue.message).join("; ")}`,
        });
      const lease = parsed.data;
      options.events.publish(Machine.Events.PeerLeaseIssued, {
        machineId: lease.from,
        time: options.now(),
        lease,
      });
      leases.set(lease.id, { lease, cancel: arm(lease) });
      return lease;
    },
    revoke: (leaseId) => revokeAll((lease) => lease.id === leaseId)[0],
    revokeAll,
    peerLease(from, to, op) {
      const lease = live().find(
        (entry) => entry.from === from && entry.to === to && entry.ops.includes(op),
      );
      if (lease !== undefined)
        options.events.publish(Machine.Events.PeerLeaseUsed, {
          machineId: from,
          time: options.now(),
          leaseId: lease.id,
          to,
          op,
        });
      return lease;
    },
    peerTargets: (from) =>
      live()
        .filter((lease) => lease.from === from)
        .map((lease) => lease.to),
    list: live,
  };
}
