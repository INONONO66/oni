import { Core } from "@oni/agent";
import type { MachineHost, MachineInputCapture, CapturedResult } from "@oni/machines";
import { Machine, PlainValueSchema, canonicalJson } from "@oni/protocol";
import { z } from "zod";
import type { ComputerStore } from "./computer-store";

const Capture = z.object({
  machineId: Machine.MachineId,
  generation: z.number().nullable(),
  params: z.union([
    Machine.InputPointerRequest, Machine.InputKeyRequest, Machine.InputTextRequest,
    Machine.InputActionRequest, Machine.ScreenObserveRequest, Machine.ScreenSettleRequest,
    Machine.AppLaunchRequest, Machine.AppQuitRequest, Machine.WindowCloseRequest, Machine.WindowParkRequest,
  ]),
  binding: Machine.ComputerWindow.optional(),
}).strict();
type PauseReason = Extract<Machine.ComputerLease, { state: "paused" }>["pauseReason"];
type EndReason = Extract<Machine.ComputerLease, { state: "ended" }>["endReason"];
export interface LaunchedWindow {
  readonly machineId: string;
  readonly target: Required<Machine.WindowTarget>;
  readonly launchedBy: { readonly sessionId: string; readonly turn: string };
  keep?: Machine.ComputerKeep["reason"];
}

export class ComputerPolicy {
  readonly turns = new Map<string, string>();
  readonly launched: LaunchedWindow[] = [];
  private readonly pausedTurns = new Map<string, string | undefined>();
  private readonly detached = new Map<string, () => void>();
  constructor(
    readonly store: ComputerStore,
    readonly ports: {
      readonly now: () => number;
      readonly host: () => Pick<MachineHost, "list" | "get" | "computer">;
      readonly scheduler: { schedule(delayMs: number, task: () => void): () => void };
      readonly exclusions: readonly string[];
    },
  ) {}

  readonly now = () => this.ports.now();

  readonly guard: { decide: Core.NamedGuard["decide"] } = {
    decide: ({ value, when }) => {
      const capture = Capture.parse(value);
      const sessionId = z.string().parse(when.sessionId);
      const reason = this.refusal(sessionId, z.string().parse(when.op), capture);
      return reason === undefined ? { verdict: "allow" } : { verdict: "deny", payload: { reason } };
    },
  };

  private refusal(sessionId: string, method: string, capture: z.infer<typeof Capture>): Machine.ComputerRefusal["reason"] | undefined {
    const { machineId, params, binding } = capture;
    const lease = this.store.get(sessionId, machineId);
    if (lease === undefined || lease.state === "ended") return "lease_missing";
    if (lease.expiresAt <= this.now()) {
      this.end(sessionId, machineId, "expired");
      return "lease_expired";
    }
    const session = this.ports.host().list().find((info) => info.machineId === machineId)?.live?.session;
    if (session?.locked || session?.asleep) {
      const reason = session.locked ? "locked" : "asleep";
      this.pause(machineId, reason);
      return `paused:${reason}`;
    }
    if (lease.state === "paused") {
      const resumedTurn = this.turns.get(sessionId);
      const canObserve = method === Machine.WireMethod.ScreenObserve && !("since" in params) &&
        resumedTurn !== undefined && resumedTurn !== this.pausedTurns.get(`${sessionId}:${machineId}`);
      if (!canObserve) return `paused:${lease.pauseReason}`;
    }
    return this.scope(lease, params, binding);
  }

  private scope(lease: Machine.ComputerLease, params: MachineInputCapture["params"], binding: Machine.ComputerWindow | undefined): Machine.ComputerRefusal["reason"] | undefined {
    const identities = "app" in params ? ["bundleId" in params.app ? params.app.bundleId : params.app.path]
      : binding === undefined ? [] : [
        ...("path" in binding.app ? [binding.app.path] : []),
        ...(binding.app.bundleId === null ? [] : [binding.app.bundleId]),
      ];
    if (identities.length === 0) return "target_unbound";
    if (this.store.exclusions().some((row) => row.machineId === lease.machineId && identities.includes(row.app))) return "excluded";
    if (lease.apps !== "any" && !lease.apps.some((app) => identities.includes(app))) return "app_out_of_scope";
    if ("delivery" in params && params.delivery === "foreground" &&
      (lease.foreground === undefined || lease.foreground.expiresAt <= this.now())) return "foreground_not_granted";
  }

  pause(machineId: string, reason: PauseReason): void {
    for (const lease of this.store.list()) {
      if (lease.machineId !== machineId || lease.state === "ended") continue;
      this.pausedTurns.set(`${lease.sessionId}:${machineId}`, this.turns.get(lease.sessionId));
      this.store.pause(lease.sessionId, machineId, reason);
    }
  }

  end(sessionId: string, machineId: string, reason: EndReason = "owner_ended"): void {
    const lease = this.store.get(sessionId, machineId);
    if (lease === undefined || lease.state === "ended") return;
    this.store.end(sessionId, machineId, reason);
    this.ports.host().computer.close(machineId);
  }

  stop(sessionId: string): void {
    for (const lease of this.store.list()) if (lease.sessionId === sessionId) this.end(sessionId, lease.machineId, "stopped");
  }

  attached(machineId: string): void {
    for (const app of this.ports.exclusions) this.store.exclude({ machineId, app });
    this.detached.get(machineId)?.();
    this.detached.delete(machineId);
  }

  initialize(): void {
    for (const lease of this.store.list()) this.watch(lease.machineId);
  }

  watch(machineId: string): void {
    if (this.ports.host().list().some((info) => info.machineId === machineId)) return;
    this.transportLost(machineId);
  }

  transportLost(machineId: string): void {
    if (!this.store.list().some((lease) => lease.machineId === machineId && lease.state !== "ended")) return;
    if (this.detached.has(machineId)) return;
    const cancel = this.ports.scheduler.schedule(120_000, () => {
      if (this.detached.get(machineId) !== cancel) return;
      this.detached.delete(machineId);
      for (const lease of this.store.list())
        if (lease.machineId === machineId) this.end(lease.sessionId, machineId, "detached");
    });
    this.detached.set(machineId, cancel);
  }

  keep(sessionId: string, turn: string, record: Machine.ComputerKeep): void {
    const windows = this.launched.filter((entry) =>
      entry.machineId === record.machineId && entry.launchedBy.sessionId === sessionId && entry.launchedBy.turn === turn &&
      (typeof record.target === "number" ? entry.target.pid === record.target
        : entry.target.pid === record.target.pid && entry.target.windowId === record.target.windowId && entry.target.epoch === record.target.epoch));
    if (windows.length === 0) throw new Core.ToolRefused("provision", "target was not launched in this turn");
    for (const window of windows) window.keep = record.reason;
  }

  answered(sessionId: string, request: MachineInputCapture, result: CapturedResult): void {
    if (request.method === Machine.WireMethod.ScreenObserve && result.status === "ok" && "observationId" in result) {
      if (result.private) this.pause(request.machineId, "private");
      else if (this.turns.get(sessionId) !== this.pausedTurns.get(`${sessionId}:${request.machineId}`))
        this.store.resume(sessionId, request.machineId);
    }
    if (request.method !== Machine.WireMethod.AppLaunch || result.status !== "ok" || !("windows" in result)) return;
    const turn = this.turns.get(sessionId);
    if (turn === undefined) throw new Core.ToolRefused("computer", "launch requires a running turn");
    for (const target of result.windows)
      this.launched.push({ machineId: request.machineId, target, launchedBy: { sessionId, turn } });
  }

  intent(request: MachineInputCapture) {
    return PlainValueSchema.parse(JSON.parse(canonicalJson({
      machineId: request.machineId, generation: request.generation, params: request.params,
      ...(request.binding === undefined ? {} : { binding: request.binding }),
    })));
  }
}
