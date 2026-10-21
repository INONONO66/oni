import { type BusEvent, Machine } from "@oni/protocol";
import { Effect } from "effect";
import { MachineRefusalError } from "./errors";
import type { MachineInfo } from "./host";

export interface LeaseScheduler {
  schedule(delayMs: number, task: () => void): () => void;
}
export type LeaseClass = keyof NonNullable<Machine.CapacityRow["classCosts"]>;
export type HostPlacementRequest = Machine.PlacementRequest | { readonly machineId: string };
export interface LeaseHandle {
  readonly id: string;
  readonly machineId: string;
  readonly signal: AbortSignal;
  renewWhile<A, E, R>(operation: Effect.Effect<A, E, R>, workClass?: LeaseClass): Effect.Effect<A, E | MachineRefusalError, R>;
  renewPtyWhile<A extends { readonly status: "ok" | "refused" }, E, R>(
    operation: Effect.Effect<A, E, R>,
    session: { readonly name: string; readonly op: "open" | "use"; readonly workClass?: "pty" | "job" },
  ): Effect.Effect<A, E | MachineRefusalError, R>;
  release(): void;
}
export type HostPlacement = Exclude<Machine.PlacementOutcome, { kind: "placed" | "machine_saturated" }>
  | { readonly kind: "placed"; readonly machineId: string; readonly lease: LeaseHandle }
  | ({ readonly kind: "machine_saturated" } & Machine.LeaseRefusal);
interface EffectiveCapacity {
  readonly machineId: string;
  readonly slots: number | null;
  readonly memReserveBytes: number;
  readonly classCosts: NonNullable<Machine.CapacityRow["classCosts"]>;
}
interface Claim {
  readonly cost: number;
  users: number;
  retained: boolean;
}
interface Lease {
  readonly handle: LeaseHandle;
  readonly cost: number;
  readonly exclusive: boolean;
  readonly claims: Set<Claim>;
  readonly terminals: Map<string, Claim>;
  readonly arm: () => void;
  cancel?: () => void;
}
interface CapacityOptions {
  readonly rows: readonly Machine.CapacityRow[];
  readonly list: () => MachineInfo[];
  readonly id: () => string;
  readonly now: () => number;
  readonly events: BusEvent.Sink;
  readonly scheduler?: LeaseScheduler;
  readonly idleTtlMs?: number;
}

/** Admission and lease accounting share one synchronous decision boundary. */
export function createCapacity(options: CapacityOptions) {
  const leases = new Map<string, Set<Lease>>();
  const ttl = options.idleTtlMs ?? 10_000;
  function effective(machine: MachineInfo): EffectiveCapacity {
    const tagged = options.rows.filter((row) => "tag" in row && machine.tags.includes(row.tag));
    const exact = options.rows.filter((row) => "machineId" in row && row.machineId === machine.machineId);
    return [...tagged, ...exact].reduce<EffectiveCapacity>((current, row) => ({
      machineId: machine.machineId,
      slots: row.slots ?? current.slots,
      memReserveBytes: row.memReserveBytes ?? current.memReserveBytes,
      classCosts: { ...(row.classCosts ?? current.classCosts) },
    }), { machineId: machine.machineId, slots: machine.resources?.cpus ?? null,
      memReserveBytes: 0, classCosts: { exec: 1, eval: 1, pty: 1, job: 1 } });
  }
  function activeCost(lease: Lease): number {
    let total = 0;
    for (const claim of lease.claims) total += claim.cost;
    return total;
  }
  function leaseCost(lease: Lease): number {
    const reserved = lease.handle.signal.aborted ? 0 : lease.cost;
    return lease.exclusive ? (lease.claims.size > 0 ? lease.cost : reserved) : Math.max(reserved, activeCost(lease));
  }
  function used(machineId: string): number {
    let total = 0;
    for (const lease of leases.get(machineId) ?? []) total += leaseCost(lease);
    return total;
  }
  function credit(machine: MachineInfo, extra: number, holder?: Lease): Machine.LeaseRefusal | undefined {
    const policy = effective(machine);
    const inFlight = used(machine.machineId);
    const base = { machineId: machine.machineId, slots: policy.slots, inFlight };
    const exclusive = [...(leases.get(machine.machineId) ?? [])].some((lease) => lease !== holder && lease.exclusive);
    if ((extra > 0 && exclusive) || (policy.slots !== null && inFlight + extra > policy.slots)) return { ...base, reason: "slots" };
    const memoryAvailableBytes = machine.live?.stale === false ? machine.live.load.memoryAvailableBytes : undefined;
    if (memoryAvailableBytes !== undefined && memoryAvailableBytes < policy.memReserveBytes)
      return { ...base, reason: "memory", memoryAvailableBytes, memReserveBytes: policy.memReserveBytes };
    return undefined;
  }
  function refused(refusal: Machine.LeaseRefusal): MachineRefusalError {
    options.events.publish(Machine.Events.LeaseRefused, { ...refusal, time: options.now() });
    return new MachineRefusalError({ reason: "machine_saturated", message: `machine_saturated: ${refusal.machineId} (${refusal.reason})`, credit: refusal });
  }
  function remove(lease: Lease): void {
    lease.cancel?.();
    lease.cancel = undefined;
    leases.get(lease.handle.machineId)?.delete(lease);
  }
  function settle(lease: Lease, claim: Claim): void {
    if (claim.users === 0 && !claim.retained) lease.claims.delete(claim);
    if (lease.claims.size > 0) return;
    if (lease.handle.signal.aborted) remove(lease);
    else lease.arm();
  }
  function reserve(machineId: string, reservation: { cost: number; exclusive: boolean; workClass: LeaseClass }): LeaseHandle {
    const scheduler = options.scheduler;
    if (scheduler === undefined)
      throw new MachineRefusalError({ reason: "lease_scheduler_missing", message: "machine leases require an injected scheduler" });
    const controller = new AbortController();
    let timerVersion = 0;
    const cancel = (): void => {
      timerVersion += 1;
      const pending = lease.cancel;
      lease.cancel = undefined;
      pending?.();
    };
    const arm = (): void => {
      cancel();
      const version = timerVersion;
      const expiresAt = options.now() + ttl;
      const expire = (): void => {
        if (version !== timerVersion || controller.signal.aborted || lease.claims.size > 0) return;
        lease.cancel = undefined;
        const remaining = expiresAt - options.now();
        if (remaining > 0) lease.cancel = scheduler.schedule(remaining, expire);
        else handle.release();
      };
      lease.cancel = scheduler.schedule(ttl, expire);
    };
    function acquire(workClass: LeaseClass, name?: string): Effect.Effect<Claim, MachineRefusalError> {
      return Effect.suspend(() => {
        const machine = options.list().find((entry) => entry.machineId === machineId);
        if (controller.signal.aborted || machine === undefined)
          return Effect.fail(new MachineRefusalError({ reason: "lease_expired", message: `lease_expired: ${handle.id}` }));
        const held = name === undefined ? undefined : lease.terminals.get(name);
        const claim = held ?? { cost: effective(machine).classCosts[workClass], users: 0, retained: false };
        const extra = lease.exclusive || held !== undefined ? 0 : Math.max(lease.cost, activeCost(lease) + claim.cost) - leaseCost(lease);
        const refusal = credit(machine, extra, lease);
        if (refusal !== undefined) return Effect.fail(refused(refusal));
        claim.users += 1;
        lease.claims.add(claim);
        cancel();
        return Effect.succeed(claim);
      });
    }
    const releaseClaim = (claim: Claim) => Effect.sync(() => {
      claim.users -= 1;
      settle(lease, claim);
    });
    const handle: LeaseHandle = {
      id: options.id(), machineId, signal: controller.signal,
      release() {
        controller.abort();
        cancel();
        if (lease.claims.size === 0) remove(lease);
      },
      renewWhile: (operation, workClass = reservation.workClass) =>
        Effect.acquireUseRelease(acquire(workClass), () => operation, releaseClaim),
      renewPtyWhile: (operation, session) => Effect.acquireUseRelease(
        acquire(session.workClass ?? "pty", session.name),
        (claim) => operation.pipe(Effect.tap((result) => Effect.sync(() => {
          if (session.op === "open" && result.status === "ok" && !lease.terminals.has(session.name)) {
            claim.retained = true;
            lease.terminals.set(session.name, claim);
          }
        }))),
        releaseClaim,
      ),
    };
    const lease: Lease = { handle, ...reservation, claims: new Set(), terminals: new Map(), arm };
    const members = leases.get(machineId) ?? new Set<Lease>();
    members.add(lease);
    leases.set(machineId, members);
    arm();
    return handle;
  }
  function place(query: HostPlacementRequest, workClass: LeaseClass = "exec"): HostPlacement {
    const exact = "machineId" in query ? query.machineId : undefined;
    const request: Machine.PlacementRequest = "machineId" in query ? { tag: query.machineId, prefer: "spread" } : query;
    const members = options.list().filter((machine) => exact === undefined || machine.machineId === exact);
    const facts = members.map((machine) => {
      const policy = effective(machine);
      const blocked = credit(machine, policy.classCosts[workClass]) !== undefined;
      // Old load is unknown, not a current memory refusal or ranking signal.
      const stale = machine.live?.stale === true;
      return { ...machine, tags: exact === undefined ? machine.tags : [exact], resources: stale ? undefined : machine.resources, live: stale ? undefined : machine.live,
        leases: used(machine.machineId), slots: blocked ? 0 : stale ? undefined : policy.slots ?? undefined };
    });
    const outcome = Machine.place(request, facts);
    if (outcome.kind === "placed") {
      const policy = members.map(effective).find((row) => row.machineId === outcome.machineId);
      if (policy === undefined) throw new MachineRefusalError({ reason: "machine_not_attached", message: outcome.machineId });
      const exclusive = request.prefer === "exclusive";
      return { ...outcome, lease: reserve(outcome.machineId, {
        cost: exclusive ? policy.slots ?? policy.classCosts[workClass] : policy.classCosts[workClass], exclusive, workClass,
      }) };
    }
    if (outcome.kind !== "machine_saturated") return outcome;
    const member = members.find((machine) => (exact !== undefined || machine.tags.includes(request.tag)) && (request.requires ?? []).every((capability) => machine.capabilities.includes(capability)));
    if (member === undefined) return { kind: "no_member" };
    const policy = effective(member);
    const refusal = credit(member, policy.classCosts[workClass]) ?? {
      machineId: member.machineId, reason: "slots" as const, slots: policy.slots, inFlight: used(member.machineId),
    };
    refused(refusal);
    return { kind: "machine_saturated", ...refusal };
  }
  return {
    place,
    capacity: () => options.list().map(effective),
    terminalClosed(machineId: string, name: string) {
      for (const lease of leases.get(machineId) ?? []) {
        const claim = lease.terminals.get(name);
        if (claim === undefined) continue;
        lease.terminals.delete(name);
        claim.retained = false;
        settle(lease, claim);
      }
    },
    detach(machineId: string) {
      for (const lease of leases.get(machineId) ?? []) {
        lease.handle.release();
        remove(lease);
      }
      leases.delete(machineId);
    },
  };
}
