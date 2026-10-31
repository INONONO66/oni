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
  private readonly humanAt = new Map<string, number>();
  private readonly humanStart = new Map<string, number>();
  private readonly freshObservations = new Map<string, Set<string>>();
  private readonly freshCaptures = new Map<string, Set<string>>();
  private readonly detached = new Map<string, () => void>();
  private readonly budgetRefusals = new Map<string, number>();
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

  captureRefusal(request: MachineInputCapture, reason: string, terminal: string): Machine.ComputerRefusal {
    if (reason === "paused:human_input") return this.humanRefusal(request.machineId);
    if (reason === "budget_exhausted" && "requestId" in request.params) {
      const key = `${request.machineId}:${request.params.requestId}`;
      const resetAt = this.budgetRefusals.get(key);
      this.budgetRefusals.delete(key);
      if (resetAt !== undefined) return { status: "refused", reason: "budget_exhausted", resetAt };
    }
    const refused = Machine.ComputerRefusal.safeParse({ status: "refused", reason });
    return refused.success ? refused.data
      : { status: "refused", reason: "permission_denied", message: `machine input not executed: ${terminal}` };
  }

  readonly guard: { decide: Core.NamedGuard["decide"] } = {
    decide: ({ value, when }): ReturnType<Core.NamedGuard["decide"]> => {
      const capture = Capture.parse(value);
      const sessionId = z.string().parse(when.sessionId);
      const method = z.string().parse(when.op);
      const reason = this.refusal(sessionId, method, capture);
      if (reason !== undefined) return { verdict: "deny", payload: { reason } };
      if (method.startsWith("machine.input.")) {
        const lease = this.store.get(sessionId, capture.machineId);
        if (lease === undefined || lease.state === "ended") return { verdict: "deny", payload: { reason: "lease_missing" } };
        const resetAt = this.store.admit(lease, this.now());
        if (resetAt !== undefined) {
          if ("requestId" in capture.params) this.budgetRefusals.set(`${capture.machineId}:${capture.params.requestId}`, resetAt);
          return { verdict: "deny", payload: { reason: "budget_exhausted", resetAt } };
        }
      }
      return { verdict: "allow" };
    },
  };

  private refusal(sessionId: string, method: string, capture: z.infer<typeof Capture>): Machine.ComputerRefusal["reason"] | "paused:human_input" | undefined {
    const { machineId, params, binding } = capture;
    const lease = this.store.get(sessionId, machineId);
    if (lease === undefined || lease.state === "ended") return "lease_missing";
    if (lease.expiresAt <= this.now()) {
      this.end(sessionId, machineId, "expired");
      return "lease_expired";
    }
    const live = this.ports.host().list().find((info) => info.machineId === machineId)?.live;
    const session = live?.session;
    if (session?.locked || session?.asleep) {
      const reason = session.locked ? "locked" : "asleep";
      this.pause(machineId, reason);
      return `paused:${reason}`;
    }
    const humanActive = lease.state === "active" && this.humanRecentlyActive(machineId, live?.humanInput?.lastAt);
    if (humanActive && method !== Machine.WireMethod.ScreenObserve && method !== Machine.WireMethod.ScreenSettle)
      return "paused:human_input";
    if (lease.state === "paused") {
      if (method === Machine.WireMethod.ScreenObserve || method === Machine.WireMethod.ScreenSettle) return this.scope(lease, params, binding);
      return `paused:${lease.pauseReason}`;
    }
    const stale = this.staleAnchor(sessionId, machineId, params);
    if (stale !== undefined) return stale;
    return this.scope(lease, params, binding);
  }

  private humanRecentlyActive(machineId: string, reportedAt: number | undefined): boolean {
    const at = Math.max(this.humanAt.get(machineId) ?? 0, reportedAt ?? 0);
    if (at === 0 || this.now() - at >= this.store.humanQuietMs()) return false;
    this.pause(machineId, "human_input", at);
    return true;
  }

  private staleAnchor(
    sessionId: string, machineId: string, params: MachineInputCapture["params"],
  ): "stale_observation" | "stale_capture" | undefined {
    if (!this.humanAt.has(machineId) || !("requestId" in params)) return;
    const key = `${sessionId}:${machineId}`;
    const anchor = "at" in params ? params.at : params;
    if ("observationId" in anchor && !this.freshObservations.get(key)?.has(anchor.observationId))
      return "stale_observation";
    if ("captureId" in anchor && !this.freshCaptures.get(key)?.has(anchor.captureId))
      return "stale_capture";
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

  humanActiveMs(machineId: string): number {
    const reported = this.ports.host().list().find((info) => info.machineId === machineId)?.live?.humanInput?.lastAt;
    return Math.max(0, this.now() - Math.max(this.humanAt.get(machineId) ?? 0, reported ?? 0));
  }

  humanRefusal(machineId: string): Machine.ComputerRefusal {
    const humanActiveMs = this.humanActiveMs(machineId);
    return Machine.ComputerRefusal.parse({
      status: "refused", reason: "paused:human_input",
      humanActiveMs, retryAfterMs: Math.max(0, this.store.humanQuietMs() - humanActiveMs),
      ...(this.now() - (this.humanStart.get(machineId) ?? this.now()) < this.store.maxWaitMs()
        ? {} : { message: "A person is using the machine; end this turn." }),
    });
  }

  pause(machineId: string, reason: PauseReason, at = this.now()): void {
    if (reason === "human_input") {
      if (!this.humanStart.has(machineId)) this.humanStart.set(machineId, at);
      this.humanAt.set(machineId, Math.max(this.humanAt.get(machineId) ?? 0, at));
    }
    for (const lease of this.store.list()) {
      if (lease.machineId !== machineId || lease.state === "ended") continue;
      const key = `${lease.sessionId}:${machineId}`;
      this.freshObservations.delete(key);
      this.freshCaptures.delete(key);
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
      const lease = this.store.get(sessionId, request.machineId);
      if (result.private) this.pause(request.machineId, "private");
      else if (!("since" in request.params) && this.turns.get(sessionId) !== this.pausedTurns.get(`${sessionId}:${request.machineId}`) &&
        !(lease?.state === "paused" && lease.pauseReason === "human_input" &&
          this.humanActiveMs(request.machineId) < this.store.humanQuietMs())) {
        const key = `${sessionId}:${request.machineId}`;
        this.freshObservations.set(key, new Set([result.observationId]));
        this.freshCaptures.set(key, new Set(result.screenshot === undefined ? [] : [result.screenshot.captureId]));
        this.store.resume(sessionId, request.machineId);
        if (!this.store.list().some((row) =>
          row.machineId === request.machineId && row.state === "paused" && row.pauseReason === "human_input"))
          this.humanStart.delete(request.machineId);
      }
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
