import { chmodSync } from "node:fs";
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { isContained, normalizeExportRoot } from "./contained";
import { createIpcServer, createIpcTcpServer, type IpcServer, type IpcTlsIdentity } from "./ipc";
import { typedCall } from "./typed-call";
import { type BusEvent, type Ipc, Machine } from "@oni/protocol";
import { Deferred, Effect, Exit, Fiber, FiberSet, Semaphore, type Scope } from "effect";
import { MachinesFailure, MachineCellError, MachineRefusalError, TransportFailure, type MachineError } from "./errors";
import { decodeMachineFailure } from "./failure";
import { observeRefusal } from "./observe";
import { onAbort } from "./interrupt-on";
import { PingLiveness } from "./ping-liveness";
import { ClockSamples, capturedAt, clockSample } from "./clock-samples";
import { Reservations } from "./reservation";
import { ComputerWindows } from "./computer-windows";
import { ComputerRelay } from "./computer-relay";
import { IpcConnectionError, IpcRemoteError, IpcTimeoutError } from "./ipc/errors";
import { createPtyHandle, type PtyHandle } from "./pty-host";
import { createCapacity, type HostPlacement, type HostPlacementRequest, type LeaseClass, type LeaseScheduler } from "./capacity";
import type { AttachGenerationStore } from "./generation-store";
import type { StreamingMachineHandle, StreamWriteOptions, StreamWriteReceipt } from "./stream-write";
import type { z } from "zod";
interface MachineHostOptions {
  /**
   * The additive listener set (#1270): at least one of `unix` or `tcp`. Both
   * listeners serve the SAME attachment registry and request dispatcher.
   */
  readonly listen: {
    readonly unix?: string;
    readonly tcp?: { readonly host: string; readonly port: number };
  };
  /** Host TLS identity presented on the TCP listener; required when tcp is set. */
  readonly tls?: IpcTlsIdentity;
  /** Injected request-id entropy (#1245): required, no ambient crypto fallback. */
  readonly id: () => string;
  /** Callback dispatcher bound per listener (#1312): required, the composition chooses it. */
  readonly dispatcherBound: number;
  readonly enrollment: (id: Machine.MachineId) => Machine.Enrollment | undefined;
  /** Product-owned durable observation of capabilities the enrollment has not granted. */
  readonly requestCapabilities?: (offer: Machine.Offer, excess: readonly Machine.CapabilityId[]) => void;
  readonly pendingCapabilities?: (id: Machine.MachineId) => readonly Machine.CapabilityId[];
  readonly generations: AttachGenerationStore;
  readonly events: BusEvent.Sink;
  readonly now: () => number;
  /**
   * Required tool port (#1312): a host wired without one must say so with an
   * explicit implementation failing `host_tool_missing`, never a fabricated
   * `{ status: "failed" }` tool result.
   */
  readonly callTool: (call: Machine.ToolCall) => Effect.Effect<Machine.ToolCallResult, MachineError>;
  /** Composition supplies the captured tool.pre decision, not machine policy. */
  readonly decideAgentPermission?: (machineId: Machine.MachineId, request: Machine.AgentPermissionRequest) => Effect.Effect<Machine.AgentPermissionDecision, MachineError>;
  readonly agentPermissionDeadlineMs?: number;
  /**
   * Machine ids protected from fresh-offer supersession (#1271): while such
   * an id is attached, an offer without a generation is refused
   * `already_attached`. A reconnect proving the current generation may
   * replace its stale connection. The app protects its own machine id.
   * Fresh offers are refused before reading or changing the generation store.
   */
  readonly neverSupersede?: readonly Machine.MachineId[];
  /**
   * Age (host clock, since receipt) past which the latest `machine.report`
   * reads `live.stale: true` (#1555). Default 15 000 ms = three missed
   * heartbeats at the daemon's default cadence.
   */
  readonly staleAfterMs?: number;
  readonly pingTick?: Effect.Effect<void>;
  readonly capacity?: readonly Machine.CapacityRow[];
  readonly release?: () => Machine.Release | undefined;
  readonly scheduler?: LeaseScheduler;
  readonly idleTtlMs?: number;
  /**
   * Captured-input port (#1662): every `machine.input.*` call runs `forward`
   * only through this port, which records the call as a kernel `tool.pre`
   * effect and may refuse it. `forward` re-checks the attachment, generation
   * and grant before it sends. Absent, every typed input refuses
   * `permission_denied`; the host carries no input policy of its own.
   */
  readonly captureInput?: <R extends CapturedResult>(
    request: MachineInputCapture,
    forward: Effect.Effect<R, MachineError>,
  ) => Effect.Effect<R | CaptureRefusal, MachineError>;
}
/** Default `staleAfterMs`: three missed default-cadence heartbeats. */
const REPORT_STALE_AFTER_MS = 15_000;
const PING_INTERVAL_MS = 5_000;
const PING_TIMEOUT_MS = 15_000;
const AGENT_SESSION_CAPABILITY = "agent.session";
const AGENT_PERMISSION_DEADLINE_MS = 30_000;
/** Rust mclient gives a timed-out interpreter 2 s after SIGINT before killing it. */
const CELL_CLEANUP_MARGIN_MS = 3_000;
/** A bulk read still fits a single codemode tool reply after base64 encoding. */
const BULK_READ_MAX_BYTES = 8 * 1024 * 1024;
type Value<O extends Machine.FsValue["op"]> = Extract<Machine.FsValue, { op: O }>;
type WriteOptions = Pick<Extract<Machine.FsRequest, { op: "write" }>, "create">;
type ReadValue = Omit<Value<"read">, "data"> & { readonly data: Uint8Array };
type ExecValue = Omit<Extract<Machine.ExecResult, { status: "completed" }>, "stdout" | "stderr"> & { readonly stdout: Uint8Array; readonly stderr: Uint8Array };
type ScreenValue = Omit<Extract<Machine.ScreenReadResult, { status: "ok" }>, "png"> & { readonly png: Uint8Array };
type DetachReason = import("zod").infer<typeof Machine.Events.Detached.schema>["reason"];
type AgentSessionMethod =
  | typeof Machine.WireMethod.AgentSessionList | typeof Machine.WireMethod.AgentSessionOpen
  | typeof Machine.WireMethod.AgentSessionTail | typeof Machine.WireMethod.AgentSessionSend
  | typeof Machine.WireMethod.AgentSessionStop;
type AgentSessionRequest =
  | Machine.AgentSessionListRequest | Machine.AgentSessionOpenRequest | Machine.AgentSessionTailRequest
  | Machine.AgentSessionSendRequest | Machine.AgentSessionStopRequest;
export interface MachineHandle {
  readonly fs: {
    read(path: string, window?: { offset?: number; limit?: number }): Effect.Effect<ReadValue, MachineError>;
    write(path: string, data: Uint8Array, options?: WriteOptions): Effect.Effect<Value<"write">, MachineError>;
    list(path: string): Effect.Effect<Value<"list">, MachineError>;
    stat(path: string): Effect.Effect<Value<"stat">, MachineError>;
  };
  exec(cmd: string, cwd: string): Effect.Effect<ExecValue | Exclude<Machine.ExecResult, { status: "completed" }>, MachineError>;
  /** Computer use (#1274): bounded capture and guarded input over the same attachment. */
  screen(request: Machine.ScreenReadRequest): Effect.Effect<ScreenValue | Exclude<Machine.ScreenReadResult, { status: "ok" }>, MachineError>;
  input(request: Machine.InputWriteRequest): Effect.Effect<Machine.InputWriteResult, MachineError>;
  /** Persistent terminals (#1273): named tmux sessions behind one routed call seam. */
  readonly pty: PtyHandle;
  runCode(cell: Machine.CellRequest, signal?: AbortSignal): Effect.Effect<Machine.CellResult, MachineError>;
  peekCode(cellId: string): Effect.Effect<Machine.PeekAnswer, MachineError>;
  /** Optional for existing test doubles outside machines; real host handles always supply it. */
  readonly agentSession?: {
    list(request: Machine.AgentSessionListRequest): Effect.Effect<Machine.AgentSessionListResult, MachineError>;
    open(request: Machine.AgentSessionOpenRequest): Effect.Effect<Machine.AgentSessionOpenResult, MachineError>;
    tail(request: Machine.AgentSessionTailRequest): Effect.Effect<Machine.AgentSessionTailResult, MachineError>;
    send(request: Machine.AgentSessionSendRequest): Effect.Effect<Machine.AgentSessionSendResult, MachineError>;
    stop(request: Machine.AgentSessionStopRequest): Effect.Effect<Machine.AgentSessionStopResult, MachineError>;
  };
  /**
   * Computer use (#1662), gated by `computer.use` in the effective set AND
   * the live enrollment. Optional so structural fakes stay valid; the host
   * always provides it. The legacy `screen`/`input` pair above keeps its
   * `screen.read`/`input.write` gate and its callers unchanged.
   */
  readonly computer?: ComputerHandle;
}
/** Computer-use wire methods (#1662) the host originates. */
type ComputerMethod = (typeof Machine.WireMethod)["ScreenList" | "ScreenCapture" | "ScreenObserve" | "ScreenSettle" | "InputAction" | "InputPointer" | "InputKey" | "InputText" | "InputStatus" | "ComputerClose" | "StreamOpen" | "StreamSignal" | "StreamClose" | "CdpOpen" | "CdpChunk" | "CdpClose"] | LifecycleMethod;
type LifecycleMethod = (typeof Machine.WireMethod)["AppLaunch" | "AppQuit" | "WindowClose" | "WindowPark"];
type LifecycleParams = Machine.AppLaunchRequest | Machine.AppQuitRequest | Machine.WindowCloseRequest | Machine.WindowParkRequest;
type LifecycleResult = Machine.AppLaunchResult | Machine.AppQuitResult | Machine.WindowCloseResult | Machine.WindowParkResult;
type InputMethod = (typeof Machine.WireMethod)["InputPointer" | "InputKey" | "InputText"];
type InputParams = Machine.InputPointerRequest | Machine.InputKeyRequest | Machine.InputTextRequest;
type PointerCall = Machine.InputPointerRequest extends infer P ? P extends Machine.InputPointerRequest ? Omit<P, "requestId"> : never : never;
type ActionRequest = Omit<Machine.InputActionRequest, "requestId">;
type CapturedMethod = InputMethod | (typeof Machine.WireMethod)["ScreenObserve" | "ScreenSettle" | "InputAction"] | LifecycleMethod;
type CapturedParams = InputParams | Machine.ScreenObserveRequest | Machine.ScreenSettleRequest | Machine.InputActionRequest | LifecycleParams;
/** What a captured call answers when it was forwarded (#1689 adds observation). */
export type CapturedResult = Machine.InputWriteResult | Machine.ScreenObserveResult | Machine.ScreenSettleResult | LifecycleResult;
/** The capture port's own refusal, valid in every captured answer vocabulary. */
export type CaptureRefusal = Machine.ComputerRefusal | Machine.ComputerCancelled;
/** What the captured-input port records: the exact call the host would forward. */
export interface MachineInputCapture {
  readonly machineId: Machine.MachineId;
  /** The attachment generation when the call was captured; null when no peer was attached. */
  readonly generation: number | null;
  readonly method: CapturedMethod;
  readonly params: CapturedParams;
  readonly binding?: Machine.ComputerWindow;
}
/** Why a stream or channel ended: the peer's or host's close reason, or the attachment went away. */
export type RelayEnd = Machine.StreamCloseRequest["reason"] | Machine.CdpCloseRequest["reason"] | "detached" | "revoked";
export interface StreamListeners {
  /** One peer → host negotiation record, delivered once per accepted seq. */
  readonly onSignal: (signal: Machine.StreamSignalRequest) => void;
  readonly onClose: (reason: RelayEnd) => void;
}
export interface ChannelListeners {
  /** Opaque bytes of the channel; boundaries carry no meaning. */
  readonly onChunk: (data: Uint8Array) => void;
  readonly onClose: (reason: RelayEnd) => void;
}
/** A live stream handle: the host minted `streamId`; seq numbering is the host's. */
export interface ComputerStream {
  readonly streamId: string;
  readonly expiresAt: number;
  /** Host wall-clock milliseconds for a sidecar's client-monotonic timestamp. */
  capturedAt(capturedAtUs: number): number | undefined;
  signal(signal: Machine.StreamSignalRequest["signal"]): Effect.Effect<Machine.StreamSignalResult, MachineError>;
  close(): Effect.Effect<Machine.StreamCloseResult, MachineError>;
}
/** An opaque debugging-channel handle; the host relays bytes and never reads them. */
export interface ComputerChannel {
  readonly channelId: string;
  readonly expiresAt: number;
  send(data: Uint8Array): Effect.Effect<Machine.CdpChunkResult, MachineError>;
  close(): Effect.Effect<Machine.CdpCloseResult, MachineError>;
}
type ComputerCapture = Exclude<Machine.ScreenCaptureResult, { status: "ok" }> | (Omit<Extract<Machine.ScreenCaptureResult, { status: "ok" }>, "data"> & { readonly data: Buffer });
export interface ComputerHandle {
  readonly app: {
    launch(request: Machine.AppLaunchRequest): Effect.Effect<Machine.AppLaunchResult, MachineError>;
    quit(request: Machine.AppQuitRequest): Effect.Effect<Machine.AppQuitResult, MachineError>;
  };
  readonly window: {
    close(request: Machine.WindowCloseRequest): Effect.Effect<Machine.WindowCloseResult, MachineError>;
    park(request: Machine.WindowParkRequest): Effect.Effect<Machine.WindowParkResult, MachineError>;
  };
  list(request?: Machine.ScreenListRequest): Effect.Effect<Machine.ScreenListResult, MachineError>;
  capture(request: Machine.ScreenCaptureRequest): Effect.Effect<ComputerCapture, MachineError>;
  pointer(request: PointerCall): Effect.Effect<Machine.InputWriteResult, MachineError>;
  key(request: Omit<Machine.InputKeyRequest, "requestId">): Effect.Effect<Machine.InputWriteResult, MachineError>;
  text(request: Omit<Machine.InputTextRequest, "requestId">): Effect.Effect<Machine.InputWriteResult, MachineError>;
  /** Window-bound observation (#1689): captured like input, answered only by contract-3 peers. */
  observe(request: Machine.ScreenObserveRequest): Effect.Effect<Machine.ScreenObserveResult, MachineError>;
  settle(request: Machine.ScreenSettleRequest): Effect.Effect<Machine.ScreenSettleResult, MachineError>;
  action(request: ActionRequest): Effect.Effect<Machine.InputWriteResult, MachineError>;
  /** A lost input answer is never replayed; observe the window before deciding another action. */
  status(request: Machine.InputStatusRequest): Effect.Effect<Machine.InputStatusResult, MachineError>;
  readonly stream: {
    open(request: Omit<Machine.StreamOpenRequest, "streamId">, listeners: StreamListeners): Effect.Effect<ComputerStream | Extract<Machine.StreamOpenResult, { status: "refused" }>, MachineError>;
  };
  readonly cdp: {
    open(request: Omit<Machine.CdpOpenRequest, "channelId">, listeners: ChannelListeners): Effect.Effect<ComputerChannel | Extract<Machine.CdpOpenResult, { status: "refused" }>, MachineError>;
  };
}
interface RelayState {
  /** Last accepted peer → host seq (-1 before the first). */
  inbound: number;
  /** Next host → peer seq. */
  outbound: number;
  readonly lock: Semaphore.Semaphore;
  readonly end: (reason: RelayEnd) => void;
}
type Relay =
  | (RelayState & { readonly kind: "stream"; readonly listeners: StreamListeners })
  | (RelayState & { readonly kind: "cdp"; readonly listeners: ChannelListeners });
/** Attached enrollment, negotiated capabilities and optional resource observations. */
export type MachineInfo = Machine.Info & {
  readonly generation: number;
  readonly peer: Machine.Offer["peer"];
};
export interface MachineHost {
  readonly computer: {
    close(machineId: string): void;
  };
  list(): MachineInfo[];
  place(request: HostPlacementRequest, workClass?: LeaseClass): HostPlacement;
  capacity(): ReturnType<ReturnType<typeof createCapacity>["capacity"]>;
  get(id: Machine.MachineId): StreamingMachineHandle;
  /**
   * The attachment's effective exports with their offered roots (#1512): the
   * names the enrollment allows, each at the canonical root the daemon offered
   * — the same roots `fs`/`exec`/`pty` confine to. Refuses like `get` when the
   * machine is not attached.
   */
  exports(id: Machine.MachineId): readonly { readonly name: Machine.ExportName; readonly path: string }[];
  /** Enrollment persistence belongs to the caller; this revokes its live attachment. */
  unenroll(id: Machine.MachineId, reason?: "enrollment_removed" | "enrollment_replaced"): void;
  /** The bound endpoints — tcp carries the REAL port when the spec asked for 0. */
  readonly endpoints: {
    readonly unix?: string;
    readonly tcp?: { readonly host: string; readonly port: number };
  };
  close(): Effect.Effect<void, MachineError>;
}
/** The per-connection transport surface every machine operation routes through. */
type HostListener = Pick<IpcServer, "call" | "callConnection" | "useConnection" | "isConnected" | "peerFingerprintOf" | "disconnect">;
interface Attachment {
  readonly enrollment: Machine.Enrollment;
  readonly offer: Machine.Offer;
  readonly capabilities: readonly string[];
  readonly generation: number;
  /** Registry key: `<listener label>:<listener connection id>` — unique across listeners. */
  readonly key: string;
  /** The listener-local connection id `server` understands. */
  readonly rawId: string;
  readonly server: HostListener;
}
/** Where a request physically arrived; the handler judges, the transport reports. */
interface RequestSource {
  readonly key: string;
  readonly rawId: string;
  readonly server: HostListener;
}

function negotiate(offer: Machine.Offer, found: Machine.Enrollment | undefined, source: RequestSource) {
  return Effect.gen(function* () {
    if (found === undefined) return { status: "refused", reason: "machine_not_enrolled" } as const;
    const enrollment = yield* Effect.try({ try: () => Machine.Enrollment.parse(found), catch: decodeMachineFailure("enrollment.decode") });
    // Key pinning precedes contract negotiation so an intruder cannot displace a peer.
    const presented = source.server.peerFingerprintOf(source.rawId);
    if (presented !== undefined && presented !== enrollment.publicKey) return { status: "refused", reason: "peer_key_mismatch" } as const;
    if (!Machine.supportedContractVersions.some((version) => version === offer.peer.contractVersion))
      return { status: "refused", reason: "unsupported_contract" } as const;
    const capabilities = Machine.effectiveCapabilities(enrollment, offer);
    const exports = Machine.effectiveExports(enrollment, offer);
    if (capabilities.kind === "machine_mismatch" || exports.kind === "machine_mismatch")
      return { status: "refused", reason: "machine_mismatch" } as const;
    return { enrollment, capabilities: capabilities.capabilities, exports: exports.exports };
  });
}

function matchesGeneration(offer: Machine.Offer, current: number | undefined): boolean {
  return offer.generation === undefined || offer.generation === current;
}

function generationOf(store: AttachGenerationStore, issued: Set<string>, offer: Machine.Offer, active: () => boolean): Effect.Effect<number | undefined, MachinesFailure> {
  return Effect.gen(function* () {
    const current = yield* store.current(offer.machineId);
    if (!active()) return undefined;
    if (!matchesGeneration(offer, current)) return undefined;
    if (offer.generation !== undefined && issued.has(offer.machineId)) return current;
    return yield* mintGeneration(store, issued, offer, active, current);
  });
}

function mintGeneration(store: AttachGenerationStore, issued: Set<string>, offer: Machine.Offer, active: () => boolean, saved: number | undefined): Effect.Effect<number | undefined, MachinesFailure> {
  return Effect.gen(function* () {
    let current = saved;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const next = (current ?? 0) + 1;
      if (yield* store.compareAndSet(offer.machineId, current, next)) {
        issued.add(offer.machineId);
        return next;
      }
      if (attempt === 0) {
        current = yield* store.current(offer.machineId);
        if (!matchesGeneration(offer, current)) return undefined;
      }
      if (!active()) return undefined;
    }
    return undefined;
  });
}

export function createMachineHost(options: MachineHostOptions): Effect.Effect<MachineHost, MachineError, Scope.Scope> {
  return Effect.gen(function* () {
    const rows = yield* Effect.try({ try: () => Machine.CapacityRows.parse(options.capacity ?? []), catch: decodeMachineFailure("capacity.decode") });
    const admission = yield* Semaphore.make(1);
    const attachments = new Map<string, Attachment>();
    const connectionByMachine = new Map<string, string>();
    /** Machines that attached at least once: their detached window reads `disconnected`. */
    const known = new Set<string>();
    const issued = new Set<string>();
    const inFlight = new Map<string, Set<string>>();
    const permissions = new Map<string, Map<string, Deferred.Deferred<void>>>();
    const handles = new Map<string, StreamingMachineHandle>();
    const revoked = new Map<string, number>();
    const reservations = new Reservations();
    const computerWindows = new Map<string, ComputerWindows>();
    const computerRelays = new Map<string, ComputerRelay>();
    const dispatchComputerClose = yield* FiberSet.makeRuntime<never, void, never>();
    const lastGeneration = new Map<string, number>();
    let closed = false;
    /** Latest accepted heartbeat per attachment key, stamped with host receipt time. */
    const reports = new Map<string, { readonly report: Machine.Report; readonly receivedAt: number }>();
    const pings = new PingLiveness();
    const clocks = new Map<string, ClockSamples>();
    const staleAfterMs = options.staleAfterMs ?? REPORT_STALE_AFTER_MS;
    const capacity = createCapacity({ ...options, rows, list });
    function detach(key: string, reason: DetachReason): void {
      const attachment = attachments.get(key);
      if (attachment === undefined) return;
      attachments.delete(key);
      for (const pending of permissions.get(key)?.values() ?? [])
        Deferred.doneUnsafe(pending, Exit.succeed(undefined));
      permissions.delete(key);
      inFlight.delete(key);
      reports.delete(key);
      computerWindows.delete(attachment.offer.machineId);
      computerRelays.delete(attachment.offer.machineId);
      pings.detach(key);
      clocks.delete(key);
      endRelays(key);
      capacity.detach(attachment.offer.machineId, reason === "superseded" ? "stale_generation" : "disconnected");
      if (connectionByMachine.get(attachment.offer.machineId) === key) connectionByMachine.delete(attachment.offer.machineId);
      options.events.publish(Machine.Events.Detached, { machineId: attachment.offer.machineId, time: options.now(), reason });
    }
    function supersede(key: string, source: RequestSource): void {
      const stale = attachments.get(key);
      if (stale === undefined) return;
      detach(key, "superseded");
      if (key !== source.key) stale.server.disconnect(stale.rawId);
    }
    function callTool(call: Machine.ToolCall, key: string): Effect.Effect<Machine.ToolCallResult, MachineError> {
      return Effect.suspend(() => {
        if (!attachments.has(key) || !inFlight.get(key)?.has(call.cellId)) return new MachineCellError({ code: "unknown_cell_id", cellId: call.cellId, message: `no cell in flight: ${call.cellId}` });
        return options.callTool(call);
      });
    }
    function decidePermission(request: Machine.AgentPermissionRequest, source: RequestSource): Effect.Effect<Machine.AgentPermissionDecision> {
      return Effect.gen(function* () {
        const denied = (reason: "denied" | "timeout"): Machine.AgentPermissionDecision =>
          ({ status: "refused", sessionId: request.sessionId, requestId: request.requestId, reason });
        const peer = attachments.get(source.key);
        if (peer === undefined || !source.server.isConnected(source.rawId) || peer.offer.peer.kind !== "client" ||
          !peer.capabilities.includes(AGENT_SESSION_CAPABILITY) || options.decideAgentPermission === undefined)
          return denied("denied");
        const key = `${request.sessionId}\0${request.requestId}`;
        const pending = permissions.get(source.key) ?? new Map<string, Deferred.Deferred<void>>();
        if (pending.has(key)) return denied("denied");
        const disconnected = yield* Deferred.make<void>();
        pending.set(key, disconnected);
        permissions.set(source.key, pending);
        const verdict = yield* Effect.race(
          options.decideAgentPermission(peer.offer.machineId, request).pipe(
            Effect.map((decision) => {
              const parsed = Machine.AgentPermissionDecision.safeParse(decision);
              return parsed.success && parsed.data.sessionId === request.sessionId && parsed.data.requestId === request.requestId
                ? parsed.data : denied("denied");
            }),
            Effect.catch(() => Effect.succeed(denied("denied"))),
            Effect.timeoutOption(options.agentPermissionDeadlineMs ?? AGENT_PERMISSION_DEADLINE_MS),
            Effect.map((outcome) => outcome._tag === "Some" ? outcome.value : denied("timeout")),
          ),
          Deferred.await(disconnected).pipe(Effect.as(denied("denied"))),
        ).pipe(Effect.ensuring(Effect.sync(() => {
          pending.delete(key);
          if (pending.size === 0) permissions.delete(source.key);
        })));
        return attachments.get(source.key) === peer && source.server.isConnected(source.rawId) ? verdict : denied("denied");
      });
    }
    function admissionValid(offer: Machine.Offer, source: RequestSource, revision: number | undefined): "closed" | "machine_not_enrolled" | undefined {
      if (closed || !source.server.isConnected(source.rawId)) return "closed";
      if (revision !== revoked.get(offer.machineId) || options.enrollment(offer.machineId) === undefined)
        return "machine_not_enrolled";
    }
    function publishAttachment(offer: Machine.Offer, source: RequestSource, incumbent: string | undefined, generation: number, negotiated: {
      readonly enrollment: Machine.Enrollment;
      readonly capabilities: readonly Machine.CapabilityId[];
      readonly exports: readonly Machine.ExportName[];
    }): void {
      if (incumbent !== undefined) supersede(incumbent, source);
      supersede(source.key, source);
      attachments.set(source.key, { enrollment: negotiated.enrollment, offer, generation, capabilities: negotiated.capabilities, ...source });
      if (offer.capabilities?.includes("ping")) pings.attach(source.key, options.now());
      connectionByMachine.set(offer.machineId, source.key);
      known.add(offer.machineId);
      lastGeneration.set(offer.machineId, generation);
      computerWindows.set(offer.machineId, new ComputerWindows());
      computerRelays.set(offer.machineId, new ComputerRelay());
      options.events.publish(Machine.Events.Attached, { machineId: offer.machineId, time: options.now(), effectiveCapabilities: [...negotiated.capabilities] });
    }
    function recordExcess(offer: Machine.Offer, enrollment: Machine.Enrollment): Effect.Effect<void, MachineError> {
      const excess = offer.offeredCapabilities.filter((capability) => !enrollment.allowedCapabilities.includes(capability));
      return Effect.try({
        try: () => options.requestCapabilities?.(offer, excess),
        catch: decodeMachineFailure("capability.request"),
      }).pipe(Effect.asVoid);
    }
    function attach(offer: Machine.Offer, respond: (result: Machine.AttachResult) => void, source: RequestSource): Effect.Effect<void, MachineError> {
      return Effect.gen(function* () {
        const revision = revoked.get(offer.machineId);
        const negotiated = yield* negotiate(offer, options.enrollment(offer.machineId), source);
        if (negotiated.status === "refused") { respond(negotiated); return; }
        const incumbent = connectionByMachine.get(offer.machineId);
        if (offer.generation === undefined && incumbent !== undefined && options.neverSupersede?.includes(offer.machineId) === true) {
          respond({ status: "refused", reason: "already_attached" } satisfies Machine.AttachResult);
          return;
        }
        yield* recordExcess(offer, negotiated.enrollment);
        const generation = yield* generationOf(options.generations, issued, offer, () =>
          admissionValid(offer, source, revision) === undefined);
        const state = admissionValid(offer, source, revision);
        if (state === "closed") return;
        if (state === "machine_not_enrolled") {
          respond({ status: "refused", reason: "machine_not_enrolled" });
          return;
        }
        if (generation === undefined) {
          respond({ status: "refused", reason: "stale_generation" });
          return;
        }
        publishAttachment(offer, source, incumbent, generation, negotiated);
        respond({ status: "attached", generation, effectiveCapabilities: [...negotiated.capabilities], effectiveExports: [...negotiated.exports] } satisfies Machine.AttachResult);
      }).pipe(admission.withPermits(1));
    }
    /**
     * One heartbeat (#1555). Only the connection that attached may report,
     * and only for the machine it attached as; anything else is a typed
     * refusal and the host keeps nothing from it.
     */
    function report(params: Ipc.Request["params"], source: RequestSource, respond: (result: Machine.ReportResult) => void): Effect.Effect<void, MachinesFailure> {
      return Effect.gen(function* () {
        const attachment = attachments.get(source.key);
        if (attachment === undefined) { respond({ status: "refused", reason: "machine_not_attached" }); return; }
        const parsed = Machine.reportForVersion(attachment.offer.peer.contractVersion, params);
        if (!parsed.success) {
          if (attachment.offer.peer.contractVersion === 3) return yield* new MachinesFailure({ operation: "report.decode", cause: "invalid_report" });
          respond({ status: "refused", reason: "invalid_report" });
          return;
        }
        const incoming = parsed.data;
        if (attachment.offer.machineId !== incoming.machineId) { respond({ status: "refused", reason: "machine_mismatch" }); return; }
        const receivedAt = options.now();
        reports.set(source.key, { report: incoming, receivedAt });
        respond({ status: "accepted" });
        options.events.publish(Machine.Events.Reported, { machineId: incoming.machineId, time: receivedAt, reportedAt: incoming.reportedAt, load: incoming.load });
        yield* recoverInputs(attachment);
      });
    }
    function humanInput(incoming: Machine.HumanInputNotification, source: RequestSource): void {
      const attachment = attachments.get(source.key);
      if (attachment?.offer.machineId !== incoming.machineId) return;
      options.events.publish(Machine.Events.HumanInput, {
        ...incoming,
        time: options.now(),
      });
    }
    const directRequests = new Map<string, (params: Ipc.Request["params"], respond: (result: Ipc.Response["result"]) => void, source: RequestSource) => Effect.Effect<void, MachineError>>([
      [Machine.WireMethod.CallTool, (params, respond, source) =>
        Effect.try({ try: () => Machine.ToolCall.parse(params), catch: decodeMachineFailure("tool.decode") })
          .pipe(Effect.flatMap((call) => callTool(call, source.key)), Effect.map(respond))],
      [Machine.WireMethod.Report, (params, respond, source) =>
        report(params, source, respond)],
      [Machine.WireMethod.AgentPermission, (params, respond, source) =>
        Effect.try({ try: () => Machine.AgentPermissionRequest.parse(params), catch: decodeMachineFailure("agent.permission.request") })
          .pipe(Effect.flatMap((request) => decidePermission(request, source)), Effect.map(respond))],
      [Machine.WireMethod.Release, (_params, respond) => Effect.sync(() => {
        const release = options.release?.();
        respond(release === undefined
          ? { status: "refused", reason: "release_unavailable" }
          : { status: "available", release });
      })],
    ]);
    function ping(peer: Attachment): Effect.Effect<void> {
      return Effect.gen(function* () {
        if (attachments.get(peer.key) !== peer) return;
        if (pings.expired(peer.key, options.now())) {
          detach(peer.key, "ping_timeout");
          peer.server.disconnect(peer.rawId);
          return;
        }
        if (!pings.begin(peer.key)) return;
        yield* Effect.gen(function* () {
          const sentAt = options.now();
          const answer = yield* peer.server.callConnection(peer.rawId, Machine.WireMethod.Ping, {}, PING_TIMEOUT_MS).pipe(
            Effect.flatMap((raw) => Effect.try({ try: () => Machine.PingResult.parse(raw), catch: decodeMachineFailure("ping.decode") })),
            Effect.option,
          );
          const receivedAt = options.now();
          const accepted = answer._tag === "Some" && attachments.get(peer.key) === peer;
          pings.finish(peer.key, receivedAt, accepted);
          if (accepted && answer._tag === "Some") {
            const sample = clockSample(answer.value, sentAt, receivedAt);
            if (sample !== undefined) {
              const history = clocks.get(peer.key) ?? new ClockSamples();
              history.add(sample);
              clocks.set(peer.key, history);
            }
          }
        }).pipe(Effect.ensuring(Effect.sync(() => pings.finish(peer.key, options.now(), false))));
      });
    }
    function dispatchRequest(method: string, params: Ipc.Request["params"], respond: (result: Ipc.Response["result"]) => void, source: RequestSource): Effect.Effect<void, MachinesFailure> {
      return Effect.gen(function* () {
        const direct = directRequests.get(method);
        if (direct !== undefined) {
          yield* direct(params, respond, source);
          return;
        }
        const relayed = relayInbound(method, params, source.key);
        if (relayed !== undefined) {
          respond(yield* relayed);
          yield* closeRetired(source.key);
          return;
        }
        if (method !== Machine.WireMethod.Attach) return yield* new MachineRefusalError({ reason: "invalid_method", message: `invalid method: ${method}` });
        const offer = yield* Effect.try({ try: () => Machine.Offer.parse(params), catch: decodeMachineFailure("attach.decode") });
        yield* attach(offer, respond, source);
      }).pipe(Effect.mapError((error) => new MachinesFailure({ operation: "machine.request", cause: error.message || String(error) })));
    }
    /**
     * One shared dispatcher behind every listener. The label prefixes
     * listener-local connection ids so two listeners can never collide in the
     * shared registry; `bind` runs before the listener accepts a connection.
     */
    function makeListener(label: string) {
      let api: HostListener;
      return {
        handler: (method: string, params: Ipc.Request["params"], respond: (result: Ipc.Response["result"]) => void, _notify: (method: string, params?: Ipc.Notification["params"]) => void, rawId: string) =>
          method === Machine.WireMethod.EventHumanInput
            ? Effect.try({
              try: () => humanInput(Machine.HumanInputNotification.parse(params), { key: `${label}:${rawId}`, rawId, server: api }),
              catch: decodeMachineFailure("human_input.decode"),
            }).pipe(Effect.mapError((error) => new MachinesFailure({ operation: "machine.request", cause: error.message })))
            : dispatchRequest(method, params, respond, { key: `${label}:${rawId}`, rawId, server: api }),
        onDisconnect: (rawId: string) => Effect.sync(() => detach(`${label}:${rawId}`, "connection_closed")),
        bind<S extends HostListener>(server: S): S { api = server; return server; },
      };
    }
    const bindFailure = (error: import("./ipc").IpcError) => new TransportFailure({ operation: "host.listen", message: error.message, cause: String(error) });
    const tcpSpec = options.listen.tcp === undefined || options.tls === undefined ? undefined : { ...options.listen.tcp, tls: options.tls };
    if (options.listen.unix === undefined && options.listen.tcp === undefined)
      return yield* new MachinesFailure({ operation: "host.listen", cause: "machines.listen requires at least one of unix or tcp" });
    if (options.listen.tcp !== undefined && tcpSpec === undefined)
      return yield* new MachinesFailure({ operation: "host.listen", cause: "a tcp listener requires the host tls identity (certificate and privateKey)" });
    const servers: Array<Pick<IpcServer, "close">> = [];
    const unixPath = options.listen.unix;
    if (unixPath !== undefined) {
      const listener = makeListener("unix");
      servers.push(listener.bind(yield* createIpcServer(unixPath, listener.handler, { idSource: options.id, dispatcherBound: options.dispatcherBound, onDisconnect: listener.onDisconnect }).pipe(Effect.mapError(bindFailure))));
      yield* Effect.try({ try: () => chmodSync(unixPath, 0o600), catch: decodeMachineFailure("host.chmod") });
    }
    let tcpBound: { readonly host: string; readonly port: number } | undefined;
    if (tcpSpec !== undefined) {
      const listener = makeListener("tcp");
      const server = listener.bind(yield* createIpcTcpServer(tcpSpec, listener.handler, { idSource: options.id, dispatcherBound: options.dispatcherBound, onDisconnect: listener.onDisconnect }).pipe(Effect.mapError(bindFailure)));
      servers.push(server);
      tcpBound = { host: server.host, port: server.port };
    }
    yield* Effect.forkScoped(
      Effect.gen(function* () {
        while (true) {
          yield* (options.pingTick ?? Effect.sleep(PING_INTERVAL_MS));
          for (const peer of attachments.values()) {
            if (peer.offer.capabilities?.includes("ping")) yield* Effect.forkScoped(ping(peer));
          }
        }
      }),
    );

    function connection(id: string): Attachment {
      const key = connectionByMachine.get(id);
      const attachment = key === undefined ? undefined : attachments.get(key);
      if (attachment === undefined) {
        if (known.has(id)) throw new MachineRefusalError({ reason: "disconnected", message: `machine is disconnected: ${id}` });
        throw new MachineRefusalError({ reason: "machine_not_attached", message: `machine is not attached: ${id}` });
      }
      return attachment;
    }
    function agentPeer(id: string): Attachment {
      const peer = connection(id);
      if (peer.offer.peer.kind !== "client" || !peer.capabilities.includes(AGENT_SESSION_CAPABILITY))
        throw new MachineRefusalError({ reason: "invalid_method", message: "agent session capability is not granted" });
      return peer;
    }
    function agentCall<I extends AgentSessionRequest, O>(
      id: string,
      label: string,
      method: AgentSessionMethod,
      requestSchema: { parse(value: I): I },
      resultSchema: { parse(value: Ipc.Response["result"]): O },
      input: I,
      checks?: {
        readonly before?: (peer: Attachment, request: I) => Effect.Effect<void, MachineError>;
        readonly after?: (peer: Attachment, result: O) => Effect.Effect<void, MachineError>;
      },
    ): Effect.Effect<O, MachineError> {
      return Effect.gen(function* () {
        const request = yield* Effect.try({ try: () => requestSchema.parse(input), catch: decodeMachineFailure(`${label}.request`) });
        const peer = yield* Effect.try({ try: () => agentPeer(id), catch: decodeMachineFailure(`${label}.connection`) });
        if (checks?.before) yield* checks.before(peer, request);
        peer.server.useConnection(peer.rawId);
        const raw = yield* typedCall(peer.server, method, request).pipe(Effect.mapError(transportFailure(label)));
        if (attachments.get(peer.key) !== peer)
          return yield* new MachineRefusalError({ reason: "stale_generation", message: "agent session attachment was superseded" });
        const result = yield* Effect.try({ try: () => resultSchema.parse(raw), catch: decodeMachineFailure(`${label}.response`) });
        if (checks?.after) yield* checks.after(peer, result);
        return result;
      });
    }
    /**
     * ONE effective root set (#1512 r2 L11) both the host's routing
     * (`location`) and the consumer-facing listing (`exportsOf`) read: the
     * daemon's offered exports the enrollment allows — the set the daemon
     * negotiated at attach — at their normalized roots. An offered root the
     * enrollment does not allow is no candidate for either.
     */
    function effectiveRoots(peer: Attachment): readonly { readonly name: Machine.ExportName; readonly path: string }[] {
      const allowed = new Set(peer.enrollment.allowedExports ?? []);
      return (peer.offer.exports ?? [])
        .filter((entry) => allowed.has(entry.name))
        .map((entry) => ({ name: entry.name, path: normalizeExportRoot(entry.path) }));
    }
    function location(id: string, path: string) {
      const peer = connection(id);
      const absolute = posix.normalize(Machine.AbsolutePath.parse(path));
      const candidates = effectiveRoots(peer)
        .filter((entry) => isContained(entry.path, absolute))
        .sort((a, b) => b.path.length - a.path.length);
      const root = candidates[0];
      if (root === undefined) throw new MachineRefusalError({ reason: "export_not_available", message: "path is outside offered exports" });
      if (candidates[1]?.path === root.path) throw new MachineRefusalError({ reason: "ambiguous_export", message: "multiple exports name the same root" });
      return { peer, export: root.name, path: posix.relative(root.path, absolute) };
    }
    // A call that dies WITH its connection is the typed reconnect-window
    // refusal (#1270), never a transport diagnostic: it settles exactly once
    // and is never replayed.
    const transportFailure = (operation: string) => (error: import("./ipc").IpcError): MachineError =>
      error._tag === "IpcConnectionError"
        ? new MachineRefusalError({ reason: "disconnected", message: error.message || "connection closed" })
        : new TransportFailure({ operation, message: error.message || String(error), cause: String(error) });
    function filesystem<O extends Machine.FsValue["op"]>(id: string, path: string, op: O, extra: { data?: string; offset?: number; limit?: number } & WriteOptions = {}): Effect.Effect<Value<O>, MachineError> {
      return Effect.gen(function* () {
        const target = yield* Effect.try({ try: () => location(id, path), catch: decodeMachineFailure("fs.location") });
        const request = yield* Effect.try({ try: () => Machine.FsRequest.parse({ op, export: target.export, path: target.path, ...extra }), catch: decodeMachineFailure("fs.request") });
        target.peer.server.useConnection(target.peer.rawId);
        const raw = yield* typedCall(target.peer.server, Machine.WireMethod.FsOp, request).pipe(Effect.mapError(transportFailure("fs.call")));
        const result = yield* Effect.try({ try: () => Machine.FsResult.parse(raw), catch: decodeMachineFailure("fs.response") });
        if (result.status === "refused") return yield* new MachineRefusalError(result);
        if (result.value.op !== op) return yield* new MachineRefusalError({ reason: "invalid_response", message: "filesystem response operation mismatch" });
        return result.value as Value<O>;
      });
    }
    function streamCall(peer: Attachment, request: Machine.FsStreamRequest): Effect.Effect<Machine.FsStreamResult, MachineError> {
      return Effect.gen(function* () {
        peer.server.useConnection(peer.rawId);
        const raw = yield* typedCall(peer.server, Machine.WireMethod.FsStream, request).pipe(Effect.mapError(transportFailure("fs.stream")));
        const result = yield* Effect.try({ try: () => Machine.FsStreamResult.parse(raw), catch: decodeMachineFailure("fs.stream.response") });
        if (result.status === "refused") return yield* new MachineRefusalError(result);
        return result;
      });
    }
    function finishStream(peer: Attachment, transferId: string): Effect.Effect<void, MachineError> {
      return streamCall(peer, { op: "finish", transferId }).pipe(Effect.flatMap((result) => result.status === "finished"
        ? Effect.void : new MachineRefusalError({ reason: "invalid_response", message: "filesystem finish mismatch" })));
    }
    function withTransfer<A>(peer: Attachment, transferId: string, body: Effect.Effect<A, MachineError>): Effect.Effect<A, MachineError> {
      return body.pipe(Effect.ensuring(streamCall(peer, { op: "abort", transferId }).pipe(Effect.ignore)));
    }
    function readPart(peer: Attachment, transferId: string, seq: number): Effect.Effect<{ part: Extract<Machine.FsStreamResult, { status: "chunk" }>; data: Buffer }, MachineError> {
      return Effect.gen(function* () {
        const part = yield* streamCall(peer, { op: "read", transferId, seq });
        if (part.status !== "chunk" || part.seq !== seq) return yield* new MachineRefusalError({ reason: "invalid_response", message: "filesystem chunk mismatch" });
        const data = Buffer.from(part.data, "base64");
        if (data.length > Machine.FS_READ_MAX_BYTES) return yield* new MachineRefusalError({ reason: "invalid_response", message: "filesystem chunk exceeds cap" });
        return { part, data };
      });
    }
    function readBody(peer: Attachment, transferId: string, begin: Extract<Machine.FsStreamResult, { status: "begun" }>, offset: number): Effect.Effect<ReadValue, MachineError> {
      return Effect.gen(function* () {
        const chunks: Buffer[] = [];
        const hash = createHash("sha256");
        let bytesRead = 0;
        for (let seq = begin.seq;; seq += 1) {
          const { part, data } = yield* readPart(peer, transferId, seq);
          hash.update(data);
          chunks.push(data);
          bytesRead += data.length;
          if (!part.last) continue;
          if (part.digest !== hash.digest("hex")) return yield* new MachineRefusalError({ reason: "invalid_response", message: "filesystem digest mismatch" });
          yield* finishStream(peer, transferId);
          return { op: "read", data: Buffer.concat(chunks, bytesRead), bytesRead, size: begin.size, truncated: offset + bytesRead < begin.size };
        }
      });
    }
    function streamRead(id: string, path: string, window: { offset?: number; limit?: number }): Effect.Effect<ReadValue, MachineError> {
      return Effect.gen(function* () {
        const target = yield* Effect.try({ try: () => location(id, path), catch: decodeMachineFailure("fs.location") });
        const transferId = options.id();
        return yield* withTransfer(target.peer, transferId, Effect.gen(function* () {
          const request = yield* Effect.try({
            try: (): Extract<Machine.FsStreamRequest, { op: "begin" }> => Machine.FsStreamRequest.parse({ op: "begin", mode: "read", transferId, export: target.export, path: target.path, ...window }) as Extract<Machine.FsStreamRequest, { op: "begin" }>,
            catch: decodeMachineFailure("fs.stream.request"),
          });
          const begin = yield* streamCall(target.peer, { ...request, limit: Math.min(window.limit ?? Machine.FS_READ_MAX_BYTES, BULK_READ_MAX_BYTES) });
          if (begin.status !== "begun") return yield* new MachineRefusalError({ reason: "invalid_response", message: "filesystem begin mismatch" });
          return yield* readBody(target.peer, transferId, begin, window.offset ?? 0);
        }));
      });
    }
    function writePart(peer: Attachment, request: Extract<Machine.FsStreamRequest, { op: "write" }>, expectedBytes: number): Effect.Effect<void, MachineError> {
      return streamCall(peer, request).pipe(Effect.flatMap((part) => part.status === "written" && part.seq === request.seq && part.bytesWritten === expectedBytes && part.last === request.last
        ? Effect.void : new MachineRefusalError({ reason: "invalid_response", message: "filesystem write acknowledgement mismatch" })));
    }
    function streamWrite(id: string, path: string, data: Uint8Array, writeOptions: WriteOptions): Effect.Effect<Value<"write">, MachineError> {
      return Effect.gen(function* () {
        const target = yield* Effect.try({ try: () => location(id, path), catch: decodeMachineFailure("fs.location") });
        const transferId = options.id();
        return yield* withTransfer(target.peer, transferId, Effect.gen(function* () {
          const begin = yield* streamCall(target.peer, { op: "begin", mode: "write", transferId, export: target.export, path: target.path, ...writeOptions });
          if (begin.status !== "begun" || begin.seq !== 0) return yield* new MachineRefusalError({ reason: "invalid_response", message: "filesystem begin mismatch" });
          const hash = createHash("sha256");
          let written = 0;
          for (let seq = 0; written < data.length || seq === 0; seq += 1) {
            const chunk = data.subarray(written, written + Machine.FS_WRITE_MAX_BYTES);
            hash.update(chunk);
            const last = written + chunk.length === data.length;
            yield* writePart(target.peer, {
              op: "write", transferId, seq, data: Buffer.from(chunk).toString("base64"), last,
              ...(last ? { digest: hash.digest("hex") } : {}),
            }, written + chunk.length);
            written += chunk.length;
          }
          yield* finishStream(target.peer, transferId);
          return { op: "write" as const, bytesWritten: written };
        }));
      });
    }
    function writeStreamChunk(peer: Attachment, transferId: string, data: Uint8Array, hash: ReturnType<typeof createHash>, written: number, seq: number): Effect.Effect<{ written: number; seq: number }, MachineError> {
      return Effect.gen(function* () {
        let position = written;
        let sequence = seq;
        for (let offset = 0; offset < data.byteLength; offset += Machine.FS_WRITE_MAX_BYTES) {
          const part = data.subarray(offset, offset + Machine.FS_WRITE_MAX_BYTES);
          hash.update(part);
          position += part.byteLength;
          yield* writePart(peer, {
            op: "write", transferId, seq: sequence, data: Buffer.from(part).toString("base64"), last: false,
          }, position);
          sequence += 1;
        }
        return { written: position, seq: sequence };
      });
    }
    function checkStreamChunk(data: Uint8Array, remaining: number): Effect.Effect<Uint8Array, MachineError> {
      if (!(data instanceof Uint8Array))
        return new MachineRefusalError({ reason: "invalid_response", message: "filesystem producer chunk is not bytes" });
      if (data.byteLength > remaining)
        return new MachineRefusalError({ reason: "too_large", message: "filesystem stream exceeds bound" });
      return Effect.succeed(data);
    }
    function streamWriteBody(peer: Attachment, transferId: string, iterator: AsyncIterator<Uint8Array>, maxBytes: number, expectedBytes: number): Effect.Effect<StreamWriteReceipt, MachineError> {
      return Effect.gen(function* () {
        const hash = createHash("sha256");
        let written = 0;
        let seq = 0;
        for (;;) {
          const next = yield* Effect.tryPromise({
            try: () => iterator.next(),
            catch: decodeMachineFailure("fs.stream.producer"),
          });
          if (next.done) break;
          const data = yield* checkStreamChunk(next.value, maxBytes - written);
          ({ written, seq } = yield* writeStreamChunk(peer, transferId, data, hash, written, seq));
        }
        if (written !== expectedBytes)
          return yield* new MachineRefusalError({ reason: "invalid_response", message: "filesystem stream size mismatch" });
        const sha256 = hash.digest("hex");
        yield* writePart(peer, { op: "write", transferId, seq, data: "", last: true, digest: sha256 }, written);
        yield* finishStream(peer, transferId);
        return { op: "write", bytesWritten: written, sha256 };
      });
    }
    function closeStreamIterator(iterator: AsyncIterator<Uint8Array>, background: boolean): Effect.Effect<void, MachineError, Scope.Scope> {
      return Effect.gen(function* () {
        const closeIterator = iterator.return;
        if (closeIterator === undefined) return;
        const closing = yield* Effect.try({
          try: () => closeIterator.call(iterator),
          catch: decodeMachineFailure("fs.stream.producer.close"),
        });
        const release = Effect.tryPromise({
          try: () => closing,
          catch: decodeMachineFailure("fs.stream.producer.close"),
        });
        if (background) yield* release.pipe(
          Effect.catch((error) => Effect.logWarning(`filesystem stream producer cleanup failed: ${error}`)),
          Effect.forkScoped,
        );
        else yield* release;
      });
    }
    // Each release step runs even when an earlier one failed; a failure is logged, never hides the other.
    function releaseEach<A, R>(steps: readonly Effect.Effect<A, MachineError, R>[]): Effect.Effect<void, never, R> {
      return Effect.forEach(steps, (step) => step.pipe(
        Effect.catch((failure) => Effect.logWarning(`filesystem stream cleanup failed: ${failure}`)),
      ), { discard: true });
    }
    function writeStream(id: string, path: string, chunks: AsyncIterable<Uint8Array>, settings: StreamWriteOptions): Effect.Effect<StreamWriteReceipt, MachineError> {
      return Effect.suspend(() => {
        const { maxBytes, expectedBytes, signal } = settings;
        if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || !Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || expectedBytes > maxBytes)
          return new MachineRefusalError({ reason: "invalid_response", message: "invalid stream size bounds" });
        if (signal.aborted) return new MachineRefusalError({ reason: "closed", message: "filesystem stream aborted" });
        return Effect.scoped(Effect.gen(function* () {
          const target = yield* Effect.try({ try: () => location(id, path), catch: decodeMachineFailure("fs.location") });
          const transferId = options.id();
          const iterator = chunks[Symbol.asyncIterator]();
          let completed = false;
          let beginDispatched = false;
          const cancelled = onAbort(signal, Effect.fail(new MachineRefusalError({ reason: "closed", message: "filesystem stream aborted" })));
          const operation = Effect.gen(function* () {
            beginDispatched = true;
            const begin = yield* streamCall(target.peer, {
              op: "begin", mode: "write", transferId, export: target.export, path: target.path, create: "exclusive",
            });
            if (begin.status !== "begun" || begin.seq !== 0 || begin.size !== 0)
              return yield* new MachineRefusalError({ reason: "invalid_response", message: "filesystem begin mismatch" });
            const receipt = yield* streamWriteBody(target.peer, transferId, iterator, maxBytes, expectedBytes);
            completed = true;
            return receipt;
          }).pipe(Effect.raceFirst(cancelled));
          // R05: an unfinished transfer releases the peer staging and the producer independently, in a
          // finalizer that also covers caller interruption.
          const cleanup = (interrupted: boolean) => releaseEach([
            ...(beginDispatched ? [streamCall(target.peer, { op: "abort", transferId })] : []),
            closeStreamIterator(iterator, interrupted || signal.aborted),
          ]);
          return yield* operation.pipe(Effect.onExit((exit) => completed ? Effect.void : cleanup(Exit.hasInterrupts(exit))));
        }));
      });
    }
    function get(id: string): StreamingMachineHandle {
      const existing = handles.get(id);
      if (existing !== undefined) return existing;
      const terminal = createPtyHandle((method, params, timeoutMs) => Effect.gen(function* () {
        const peer = yield* Effect.try({ try: () => connection(id), catch: decodeMachineFailure("pty.connection") });
        peer.server.useConnection(peer.rawId);
        return yield* peer.server.call(method, params as Ipc.Request["params"], timeoutMs).pipe(Effect.mapError(transportFailure("pty.call")));
      }), (name) => capacity.terminalClosed(id, name));
      const handle: StreamingMachineHandle = {
        fs: {
          read: (path, window = {}) => window.limit === undefined || window.limit <= Machine.FS_READ_MAX_BYTES
            ? filesystem(id, path, "read", window).pipe(Effect.map((value) => ({ ...value, data: Buffer.from(value.data, "base64") })))
            : streamRead(id, path, window),
          write: (path, data, writeOptions = {}) => data.byteLength <= Machine.FS_WRITE_MAX_BYTES
            ? filesystem(id, path, "write", { data: Buffer.from(data).toString("base64"), ...writeOptions })
            : streamWrite(id, path, data, writeOptions),
          writeStream: (path, chunks, settings) => writeStream(id, path, chunks, settings),
          list: (path) => filesystem(id, path, "list"), stat: (path) => filesystem(id, path, "stat"),
        },
        exec: (cmd, cwd) => Effect.gen(function* () {
          const peer = yield* Effect.try({ try: () => connection(id), catch: decodeMachineFailure("exec.connection") });
          const request = yield* Effect.try({ try: () => Machine.ExecRequest.parse({ cmd, cwd }), catch: decodeMachineFailure("exec.request") });
          peer.server.useConnection(peer.rawId);
          const raw = yield* typedCall(peer.server, Machine.WireMethod.Exec, request, Machine.EXEC_TIMEOUT_MS + 1000).pipe(Effect.mapError(transportFailure("exec.call")));
          const result = yield* Effect.try({ try: () => Machine.ExecResult.parse(raw), catch: decodeMachineFailure("exec.response") });
          return result.status === "completed" ? { ...result, stdout: Buffer.from(result.stdout, "base64"), stderr: Buffer.from(result.stderr, "base64") } : result;
        }),
        screen: (request) => Effect.gen(function* () {
          const parsed = yield* Effect.try({ try: () => Machine.ScreenReadRequest.parse(request), catch: decodeMachineFailure("screen.request") });
          const peer = yield* Effect.try({ try: () => connection(id), catch: decodeMachineFailure("screen.connection") });
          peer.server.useConnection(peer.rawId);
          const raw = yield* typedCall(peer.server, Machine.WireMethod.ScreenRead, parsed, Machine.EXEC_TIMEOUT_MS + 1000).pipe(Effect.mapError(transportFailure("screen.call")));
          const result = yield* Effect.try({ try: () => Machine.ScreenReadResult.parse(raw), catch: decodeMachineFailure("screen.response") });
          return result.status === "ok" ? { ...result, png: Buffer.from(result.png, "base64") } : result;
        }),
        input: (request) => Effect.gen(function* () {
          const parsed = yield* Effect.try({ try: () => Machine.InputWriteRequest.parse(request), catch: decodeMachineFailure("input.request") });
          const peer = yield* Effect.try({ try: () => connection(id), catch: decodeMachineFailure("input.connection") });
          peer.server.useConnection(peer.rawId);
          const raw = yield* typedCall(peer.server, Machine.WireMethod.InputWrite, parsed, Machine.EXEC_TIMEOUT_MS + 1000).pipe(Effect.mapError(transportFailure("input.call")));
          return yield* Effect.try({ try: () => Machine.InputWriteResult.parse(raw), catch: decodeMachineFailure("input.response") });
        }),
        pty: {
          ...terminal,
          read: (name, readOptions) => terminal.read(name, readOptions).pipe(Effect.tap((view) => Effect.sync(() => {
            if (view.status === "ok" && view.data.length > 0)
              options.events.publish(Machine.Events.PtyOutput, { machineId: id, time: options.now(), name, bytes: view.data.length, cursor: view.cursor });
          }))),
        },
        runCode: (cell, signal) => Effect.scoped(Effect.gen(function* () {
          const request = yield* Effect.try({ try: () => Machine.CellRequest.parse(cell), catch: decodeMachineFailure("cell.request") });
          if (signal?.aborted) return yield* Effect.interrupt;
          const peer = yield* Effect.try({ try: () => connection(id), catch: decodeMachineFailure("cell.connection") });
          const cells = inFlight.get(peer.key) ?? new Set<string>();
          if (cells.has(request.cellId)) return yield* new MachineCellError({ code: "duplicate_cell_id", cellId: request.cellId, message: `cell is already in flight: ${request.cellId}` });
          cells.add(request.cellId);
          inFlight.set(peer.key, cells);
          const cancel = Effect.suspend(() => {
            if (!attachments.has(peer.key)) return Effect.void;
            peer.server.useConnection(peer.rawId);
            return typedCall(peer.server, Machine.WireMethod.CancelCode, { cellId: request.cellId }).pipe(Effect.asVoid, Effect.mapError(transportFailure("cell.cancel")));
          });
          const cancellation = signal ? yield* Effect.forkScoped(onAbort(signal, Effect.void).pipe(Effect.andThen(cancel))) : undefined;
          peer.server.useConnection(peer.rawId);
          return yield* typedCall(peer.server, Machine.WireMethod.RunCode, request, request.timeoutMs + CELL_CLEANUP_MARGIN_MS).pipe(
            Effect.mapError(transportFailure("cell.call")),
            Effect.flatMap((raw) => Effect.try({ try: () => Machine.CellResult.parse(raw), catch: decodeMachineFailure("cell.response") })),
            Effect.tap(() => cancellation && signal?.aborted ? Fiber.join(cancellation) : Effect.void),
            Effect.onInterrupt(() => Effect.orDie(cancel)),
            Effect.ensuring(Effect.sync(() => { cells.delete(request.cellId); })),
          );
        })),
        peekCode: (cellId) => Effect.gen(function* () {
          const request = yield* Effect.try({ try: () => Machine.PeekCode.parse({ cellId }), catch: decodeMachineFailure("cell.peek.request") });
          const peer = yield* Effect.try({ try: () => connection(id), catch: decodeMachineFailure("cell.peek.connection") });
          if (inFlight.get(peer.key)?.has(request.cellId) !== true) return { running: false, output: { stdout: "", stderr: "" } };
          peer.server.useConnection(peer.rawId);
          const raw = yield* typedCall(peer.server, Machine.WireMethod.PeekCode, request).pipe(Effect.mapError(transportFailure("cell.peek")));
          return yield* Effect.try({ try: () => Machine.PeekAnswer.parse(raw), catch: decodeMachineFailure("cell.peek.response") });
        }),
        agentSession: {
          list: (input) => agentCall(id, "agent.list", Machine.WireMethod.AgentSessionList, Machine.AgentSessionListRequest, Machine.AgentSessionListResult, input),
          open: (input) => agentCall(id, "agent.open", Machine.WireMethod.AgentSessionOpen, Machine.AgentSessionOpenRequest, Machine.AgentSessionOpenResult, input, {
            after: (peer, result) => result.status === "ok" && result.cursor.generation !== peer.generation
              ? new MachineRefusalError({ reason: "stale_generation", message: "agent session cursor generation mismatch" }) : Effect.void,
          }),
          tail: (input) => agentCall(id, "agent.tail", Machine.WireMethod.AgentSessionTail, Machine.AgentSessionTailRequest, Machine.AgentSessionTailResult, input, {
            before: (peer, request) => "cursor" in request && request.cursor.generation !== peer.generation
              ? new MachineRefusalError({ reason: "stale_generation", message: "agent session cursor generation mismatch" }) : Effect.void,
            after: (peer, result) => result.status === "ok" && result.cursor.generation !== peer.generation
              ? new MachineRefusalError({ reason: "stale_generation", message: "agent session cursor generation mismatch" }) : Effect.void,
          }),
          send: (input) => agentCall(id, "agent.send", Machine.WireMethod.AgentSessionSend, Machine.AgentSessionSendRequest, Machine.AgentSessionSendResult, input),
          stop: (input) => agentCall(id, "agent.stop", Machine.WireMethod.AgentSessionStop, Machine.AgentSessionStopRequest, Machine.AgentSessionStopResult, input),
        },
        computer: computerHandle(id),
      };
      handles.set(id, handle);
      return handle;
    }
    const close = Effect.suspend(() => {
      closed = true;
      for (const key of attachments.keys()) detach(key, "host_closed");
      return Effect.forEach(servers, (server) => server.close(), { discard: true }).pipe(Effect.mapError(transportFailure("host.close")));
    });
    yield* Effect.addFinalizer(() => Effect.orDie(close));
    function list(): MachineInfo[] {
      return [...attachments.values()].map(({ enrollment, offer, generation, capabilities, key }): MachineInfo => {
        const latest = reports.get(key);
        const info: MachineInfo = {
          ...structuredClone(enrollment),
          tags: [...(enrollment.tags ?? [])],
          capabilities: [...capabilities],
          pendingCapabilities: [...(options.pendingCapabilities?.(offer.machineId) ?? [])],
          generation,
          peer: { ...offer.peer },
          os: offer.platform.split("-")[0] ?? offer.platform,
          arch: offer.platform.split("-").slice(1).join("-"),
          ...(offer.resources === undefined ? {} : { resources: { ...offer.resources } }),
        };
        if (latest === undefined) return info;
        const { machineId: _machineId, streams: _streams, ...facts } = latest.report;
        const offset = clocks.get(key)?.best()?.clockOffsetMs;
        const windows = computerWindows.get(offer.machineId)?.windows;
        return { ...info, live: {
          ...structuredClone(facts),
          ...(offset === undefined || facts.transport === undefined ? {} : { transport: { ...facts.transport, clockOffsetMs: offset } }),
          ...(windows === undefined || windows.size === 0 ? {} : { windows: Object.fromEntries(windows) }),
          stale: options.now() - latest.receivedAt > staleAfterMs,
        } };
      }).sort((a, b) => a.machineId.localeCompare(b.machineId));
    }
    /** The effective roots a consumer may resolve a path against: a root two allowed exports share is one `location` refuses as ambiguous, so it is not offered here either. */
    function exportsOf(id: string): readonly { readonly name: Machine.ExportName; readonly path: string }[] {
      const roots = effectiveRoots(connection(id));
      return roots.filter((entry) => roots.every((other) => other === entry || other.path !== entry.path));
    }
    // ---- Computer use (#1662) ----
    /** Open streams and debugging channels per attachment key; cleared on detach. */
    const relays = new Map<string, Map<string, Relay>>();
    function endRelays(key: string): void {
      const open = relays.get(key);
      relays.delete(key);
      for (const relay of open?.values() ?? []) relay.end("detached");
    }
    function relaysOf(key: string): Map<string, Relay> {
      const open = relays.get(key) ?? new Map<string, Relay>();
      relays.set(key, open);
      return open;
    }
    /** The relay `relayId` of `kind` on attachment `key`, or why there is none. */
    function findRelay<K extends Relay["kind"]>(key: string, relayId: string, kind: K): Extract<Relay, { kind: K }> | "machine_not_attached" | "not_found" {
      if (!attachments.has(key)) return "machine_not_attached";
      const relay = relays.get(key)?.get(relayId);
      return relay?.kind === kind ? relay as Extract<Relay, { kind: K }> : "not_found";
    }
    /** Removes the relay and reports its end once; false when it was already gone. */
    function endRelay(key: string, relayId: string, reason: RelayEnd): boolean {
      const relay = relays.get(key)?.get(relayId);
      if (relay === undefined) return false;
      relays.get(key)?.delete(relayId);
      relay.end(reason);
      return true;
    }
    /**
     * Both must hold, judged live on every call: the CURRENT enrollment
     * grants `computer.use` (a peer's offer never grants it), and the
     * attachment's effective set holds it, which the peer only offers while
     * a display session is available.
     */
    function computerGrant(id: string, peer: Attachment): "granted" | "permission_denied" | "not_available" {
      if (options.enrollment(id)?.allowedCapabilities.includes(Machine.WellKnownCapability.computerUse) !== true) return "permission_denied";
      return peer.capabilities.includes(Machine.WellKnownCapability.computerUse) ? "granted" : "not_available";
    }
    function decode<S extends z.ZodType>(schema: S, raw: Ipc.Response["result"], operation: string): Effect.Effect<z.output<S>, MachineError> {
      return Effect.try({ try: () => schema.parse(raw), catch: decodeMachineFailure(operation) });
    }
    function computerCall<M extends ComputerMethod, S extends z.ZodType>(peer: Attachment, method: M, params: Ipc.Request["params"], schema: S, timeoutMs = Machine.EXEC_TIMEOUT_MS): Effect.Effect<z.output<S>, MachineError> {
      return Effect.suspend(() => {
        peer.server.useConnection(peer.rawId);
        return peer.server.call(method, params, timeoutMs + 1000);
      }).pipe(Effect.mapError(transportFailure(`${method}.call`)), Effect.flatMap((raw) => decode(schema, raw, `${method}.response`)));
    }
    function recoverInputs(peer: Attachment): Effect.Effect<void> {
      return Effect.forEach(reservations.pending(peer.offer.machineId), (entry) =>
        computerCall(peer, Machine.WireMethod.InputStatus, { requestId: entry.requestId }, Machine.InputStatusResult).pipe(
          Effect.tap((result) => Effect.sync(() => {
            if (result.status === "ok" && (result.state === "completed" || result.state === "cancelled")) reservations.release(entry.machineId, entry.requestId);
          })),
          Effect.catch(() => Effect.void),
        ), { discard: true });
    }
    function attached(id: string, operation: string): Effect.Effect<Attachment, MachineError> {
      return Effect.try({ try: () => connection(id), catch: decodeMachineFailure(operation) });
    }
    function inputRefusal(grant: "permission_denied" | "not_available"): Machine.InputWriteResult {
      return { status: "refused", reason: grant === "permission_denied" ? "permission_denied" : "input_not_available" };
    }
    /**
     * The captured body: attachment and grant refusals are answered here, so
     * a refused or disconnected call is captured like an admitted one. Sends
     * only while `peer` (the attachment at capture time, if any) is still THE
     * attachment of `id` and the grant still holds.
     */
    function forwardCaptured<R extends CapturedResult>(id: string, peer: Attachment | undefined, method: CapturedMethod, refuse: (grant: "permission_denied" | "not_available") => R, send: (peer: Attachment) => Effect.Effect<R, MachineError>): Effect.Effect<R, MachineError> {
      return Effect.gen(function* () {
        const current = yield* attached(id, `${method}.connection`);
        if (current !== peer) return yield* new MachineRefusalError({ reason: "stale_generation", message: `attachment changed before ${method}: ${id}` });
        const grant = computerGrant(id, peer);
        if (grant !== "granted") return refuse(grant);
        return yield* send(peer);
      });
    }
    function captured<R extends CapturedResult>(id: string, method: CapturedMethod, params: CapturedParams, refuse: (grant: "permission_denied" | "not_available") => R, send: (peer: Attachment) => Effect.Effect<R, MachineError>): Effect.Effect<R | CaptureRefusal, MachineError> {
      if (options.captureInput === undefined) return Effect.succeed({ status: "refused", reason: "permission_denied", message: "input requires a captured tool.pre effect" } as const);
      const key = connectionByMachine.get(id);
      const peer = key === undefined ? undefined : attachments.get(key);
      const binding = computerWindows.get(id)?.resolve(params);
      const forward = forwardCaptured(id, peer, method, refuse, send);
      return options.captureInput({
        machineId: id, generation: peer?.generation ?? null, method, params,
        ...(binding === undefined ? {} : { binding }),
      }, computerRelays.get(id)?.run(forward) ?? forward);
    }
    function sendInput(peer: Attachment, method: InputMethod | typeof Machine.WireMethod.InputAction, params: InputParams | Machine.InputActionRequest): Effect.Effect<Machine.InputWriteResult, MachineError> {
      return Effect.suspend(() => {
        peer.server.useConnection(peer.rawId);
        return peer.server.call(method, params, Machine.EXEC_TIMEOUT_MS + 1000);
      }).pipe(
        Effect.map((raw) => ({ kind: "reply", raw } as const)),
        Effect.catchIf((error) => error instanceof IpcConnectionError || error instanceof IpcTimeoutError || error instanceof IpcRemoteError,
          (error) => Effect.succeed({
            kind: "lost", reason: error instanceof IpcRemoteError ? "cancelled" : "transport_lost",
          } as const)),
        Effect.mapError(transportFailure(`${method}.call`)),
        Effect.flatMap((outcome) => outcome.kind === "lost"
          ? Effect.succeed({ status: "unverifiable", reason: outcome.reason, dispatched: "unknown", hint: "re_observe" } as const)
          : decode(Machine.InputWriteResult, outcome.raw, `${method}.response`)),
      );
    }
    function dispatchInput<P extends InputParams | Machine.InputActionRequest>(id: string, method: InputMethod | typeof Machine.WireMethod.InputAction, schema: z.ZodType<P>, request: Omit<P, "requestId">): Effect.Effect<Machine.InputWriteResult, MachineError> {
      return Effect.gen(function* () {
        const key = connectionByMachine.get(id);
        const peer = key === undefined ? undefined : attachments.get(key);
        const generation = peer?.generation ?? lastGeneration.get(id) ?? 1;
        const requestId = reservations.mint(id, generation);
        const params = yield* decode(schema, { ...request, requestId }, `${method}.request`);
        return yield* captured(id, method, params, inputRefusal, (current) => {
          const target = "target" in params && params.target !== undefined
            ? `${params.target.pid}:${params.target.windowId}` : "*";
          const reserved = reservations.reserve(id, current.generation, target, requestId);
          if (reserved === "window_busy") return Effect.succeed({ status: "refused", reason: "window_busy" } as const);
          let terminal = false;
          return sendInput(current, method, params).pipe(
            Effect.tap((answer) => Effect.sync(() => { terminal = answer.status !== "unverifiable"; })),
            Effect.ensuring(Effect.sync(() => { if (terminal) reservations.release(id, requestId); })),
          );
        });
      });
    }
    function pointer(id: string, request: PointerCall): Effect.Effect<Machine.InputWriteResult, MachineError> {
      return dispatchInput(id, Machine.WireMethod.InputPointer, Machine.InputPointerRequest, { ...request, delivery: request.delivery ?? "background" });
    }
    function observation(id: string, request: Machine.ScreenObserveRequest): Effect.Effect<Machine.ScreenObserveResult | CaptureRefusal, MachineError> {
      return decode(Machine.ScreenObserveRequest, request, "screen.observe.request").pipe(Effect.flatMap((params) =>
        captured(id, Machine.WireMethod.ScreenObserve, params, observeRefusal, (peer) =>
          computerCall(peer, Machine.WireMethod.ScreenObserve, params, Machine.ScreenObserveResult).pipe(
            Effect.tap((result) => Effect.sync(() => computerWindows.get(id)?.observe(result))),
          ))));
    }
    function screenGate(id: string, operation: string): Effect.Effect<Attachment | "permission_denied" | "not_available", MachineError> {
      return attached(id, operation).pipe(Effect.map((peer) => {
        const grant = computerGrant(id, peer);
        return grant === "granted" ? peer : grant;
      }));
    }

    function lifecycle<P extends LifecycleParams, R extends LifecycleResult>(id: string, method: LifecycleMethod, schema: z.ZodType<P>, request: P, answer: z.ZodType<R>): Effect.Effect<R | CaptureRefusal | Extract<LifecycleResult, { status: "refused" }>, MachineError> {
      const refused = (grant: "permission_denied" | "not_available") => ({ status: "refused", reason: grant === "permission_denied" ? grant : "machine_not_attached" }) as const;
      return decode(schema, request, `${method}.request`).pipe(Effect.flatMap((params) => captured<R | Extract<LifecycleResult, { status: "refused" }>>(id, method, params, refused, (peer) => {
        const timeout = "app" in params ? Math.min(30_000, Math.max(1, params.timeoutMs ?? 10_000)) + 1000 : 3000;
        return computerCall(peer, method, params, answer, timeout).pipe(Effect.tap((result) => Effect.sync(() => {
          if ("app" in params && result.status === "ok" && "pid" in result)
            computerWindows.get(id)?.launch(params, result);
        })));
      })));
    }
    /** One sequence step shared by both relay kinds: repeat of the last accepted seq is idempotent. */
    function advance(relay: Relay, seq: number): "fresh" | "repeat" | "gap" {
      if (seq === relay.inbound) return "repeat";
      if (seq !== relay.inbound + 1) return "gap";
      relay.inbound = seq;
      return "fresh";
    }
    /** Relays a withdrawn grant retired whose peer side still needs the host's close, per attachment key. */
    const retired = new Map<string, Array<{ readonly kind: Relay["kind"]; readonly relayId: string }>>();
    /**
     * The live enrollment check of an EXISTING relay, either direction: when
     * `computer.use` is no longer granted the relay is retired at once (its
     * listener ends `revoked`) and queued for a peer close.
     */
    function withdrawn(key: string, relayId: string, kind: Relay["kind"]): boolean {
      const peer = attachments.get(key);
      if (peer === undefined || computerGrant(peer.offer.machineId, peer) === "granted") return false;
      endRelay(key, relayId, "revoked");
      retired.set(key, [...(retired.get(key) ?? []), { kind, relayId }]);
      return true;
    }
    /** Sends the queued peer closes; the relay is already gone host-side, so a failed close changes nothing. */
    function closeRetired(key: string): Effect.Effect<void> {
      const queued = retired.get(key) ?? [];
      retired.delete(key);
      const peer = attachments.get(key);
      if (peer === undefined) return Effect.void;
      return Effect.forEach(queued, ({ kind, relayId }) => (kind === "stream"
        ? computerCall(peer, Machine.WireMethod.StreamClose, { streamId: relayId, reason: "requested" }, Machine.StreamCloseResult)
        : computerCall(peer, Machine.WireMethod.CdpClose, { channelId: relayId, reason: "requested" }, Machine.CdpCloseResult)).pipe(Effect.ignore), { discard: true });
    }
    const STREAM_REVOKED = { status: "refused", reason: "stream_not_found", message: "computer.use is no longer granted" } as const;
    function acceptSignal(key: string, request: Machine.StreamSignalRequest): Machine.StreamSignalResult {
      const relay = findRelay(key, request.streamId, "stream");
      if (relay === "machine_not_attached") return { status: "refused", reason: relay };
      if (relay === "not_found") return { status: "refused", reason: "stream_not_found" };
      if (withdrawn(key, request.streamId, "stream")) return STREAM_REVOKED;
      const step = advance(relay, request.seq);
      if (step === "gap") return { status: "refused", reason: "invalid_sequence" };
      if (step === "fresh") relay.listeners.onSignal(request);
      return { status: "accepted", seq: request.seq };
    }
    function acceptChunk(key: string, chunk: Machine.CdpChunk): Machine.CdpChunkResult {
      const relay = findRelay(key, chunk.channelId, "cdp");
      if (relay === "machine_not_attached") return { status: "refused", reason: relay };
      if (relay === "not_found") return { status: "refused", reason: "channel_not_found" };
      if (withdrawn(key, chunk.channelId, "cdp")) return { status: "refused", reason: "channel_closed" };
      const step = advance(relay, chunk.seq);
      if (step === "gap") return { status: "refused", reason: "invalid_sequence" };
      if (step === "fresh") relay.listeners.onChunk(Buffer.from(chunk.data, "base64"));
      return { status: "accepted", seq: chunk.seq };
    }
    function closeAnswer(key: string, relayId: string, kind: Relay["kind"], reason: RelayEnd): "closed" | "machine_not_attached" | "not_found" {
      const relay = findRelay(key, relayId, kind);
      if (typeof relay === "string") return relay;
      endRelay(key, relayId, reason);
      return "closed";
    }
    /** Peer → host relay methods; undefined for any other method. */
    function relayInbound(method: string, params: Ipc.Request["params"], key: string): Effect.Effect<Ipc.Response["result"], MachineError> | undefined {
      if (method === Machine.WireMethod.EventPrivate)
        return decode(Machine.PrivateEvent, params, "private.event.decode").pipe(Effect.map((event) => {
          const peer = attachments.get(key);
          if (peer === undefined) return { status: "refused", reason: "machine_not_attached" } as const;
          if (peer.offer.machineId !== event.machineId) return { status: "refused", reason: "machine_mismatch" } as const;
          options.events.publish(Machine.Events.Private, { machineId: event.machineId, time: options.now(), target: event.target, state: event.state });
          return { status: "accepted" } as const;
        }));
      if (method === Machine.WireMethod.StreamSignal)
        return decode(Machine.StreamSignalRequest, params, "stream.signal.decode").pipe(Effect.map((request) => acceptSignal(key, request)));
      if (method === Machine.WireMethod.CdpChunk)
        return decode(Machine.CdpChunk, params, "cdp.chunk.decode").pipe(Effect.map((chunk) => acceptChunk(key, chunk)));
      if (method === Machine.WireMethod.StreamClose)
        return decode(Machine.StreamCloseRequest, params, "stream.close.decode").pipe(Effect.map(({ streamId, reason }): Machine.StreamCloseResult => {
          const state = closeAnswer(key, streamId, "stream", reason);
          return state === "closed" ? { status: "closed", streamId } : { status: "refused", reason: state === "not_found" ? "stream_not_found" : state };
        }));
      if (method === Machine.WireMethod.CdpClose)
        return decode(Machine.CdpCloseRequest, params, "cdp.close.decode").pipe(Effect.map(({ channelId, reason }): Machine.CdpCloseResult => {
          const state = closeAnswer(key, channelId, "cdp", reason);
          return state === "closed" ? { status: "closed", channelId } : { status: "refused", reason: state === "not_found" ? "channel_not_found" : state };
        }));
      return undefined;
    }
    /**
     * Registers the relay BEFORE the open is sent (a peer record racing the
     * open answer is delivered, and concurrent opens share the bound), then
     * keeps it only when the peer opened exactly the id the host minted.
     */
    function openRelay<R>(peer: Attachment, relayId: string, relay: Relay, opened: Effect.Effect<R, MachineError>, echoed: (result: R) => string | undefined): Effect.Effect<R, MachineError> {
      const open = relaysOf(peer.key);
      open.set(relayId, relay);
      const drop = Effect.sync(() => { open.delete(relayId); });
      return opened.pipe(Effect.onError(() => drop), Effect.flatMap((result): Effect.Effect<R, MachineError> => {
        const echo = echoed(result);
        if (echo === undefined) return drop.pipe(Effect.as(result));
        if (echo !== relayId) return drop.pipe(Effect.andThen(Effect.fail(new MachineRefusalError({ reason: "invalid_response", message: `peer opened ${echo} for ${relayId}` }))));
        return Effect.succeed(result);
      }));
    }
    function signalRefusal(key: string, streamId: string, outbound: number, expiresAt: number): Machine.StreamSignalResult | undefined {
      const live = findRelay(key, streamId, "stream");
      if (live === "machine_not_attached") return { status: "refused", reason: live };
      if (live === "not_found") return { status: "refused", reason: "stream_not_found" };
      if (options.now() >= expiresAt) return { status: "refused", reason: "stream_expired" };
      if (outbound >= Machine.STREAM_MAX_SIGNALS) return { status: "refused", reason: "signal_limit" };
      return undefined;
    }
    function streamOf(peer: Attachment, streamId: string, relay: Extract<Relay, { kind: "stream" }>, expiresAt: number): ComputerStream {
      return {
        streamId, expiresAt,
        capturedAt: (capturedAtUs) => {
          const offset = clocks.get(peer.key)?.best()?.clockOffsetMs;
          return offset === undefined ? undefined : capturedAt(capturedAtUs, offset);
        },
        signal: (signal) => relay.lock.withPermits(1)(Effect.gen(function* () {
          const refusal = signalRefusal(peer.key, streamId, relay.outbound, expiresAt);
          if (refusal !== undefined) return refusal;
          if (withdrawn(peer.key, streamId, "stream")) return yield* closeRetired(peer.key).pipe(Effect.as(STREAM_REVOKED));
          const request = yield* decode(Machine.StreamSignalRequest, { streamId, seq: relay.outbound, signal }, "stream.signal.request");
          const result = yield* computerCall(peer, Machine.WireMethod.StreamSignal, request, Machine.StreamSignalResult);
          if (result.status === "accepted") relay.outbound += 1;
          return result;
        })),
        close: () => Effect.suspend(() => {
          if (!endRelay(peer.key, streamId, "requested")) return Effect.succeed<Machine.StreamCloseResult>({ status: "refused", reason: attachments.has(peer.key) ? "stream_not_found" : "machine_not_attached" });
          return computerCall(peer, Machine.WireMethod.StreamClose, { streamId, reason: "requested" }, Machine.StreamCloseResult);
        }),
      };
    }
    function channelOf(peer: Attachment, channelId: string, relay: Extract<Relay, { kind: "cdp" }>, expiresAt: number): ComputerChannel {
      return {
        channelId, expiresAt,
        send: (data) => relay.lock.withPermits(1)(Effect.gen(function* () {
          const live = findRelay(peer.key, channelId, "cdp");
          if (live === "machine_not_attached") return { status: "refused", reason: live } as const;
          if (live === "not_found") return { status: "refused", reason: "channel_not_found" } as const;
          if (withdrawn(peer.key, channelId, "cdp")) return yield* closeRetired(peer.key).pipe(Effect.as({ status: "refused", reason: "channel_closed" } as const));
          const chunk = yield* decode(Machine.CdpChunk, { channelId, seq: relay.outbound, data: Buffer.from(data).toString("base64") }, "cdp.chunk.request");
          const result = yield* computerCall(peer, Machine.WireMethod.CdpChunk, chunk, Machine.CdpChunkResult);
          if (result.status === "accepted") relay.outbound += 1;
          return result;
        })),
        close: () => Effect.suspend(() => {
          if (!endRelay(peer.key, channelId, "requested")) return Effect.succeed<Machine.CdpCloseResult>({ status: "refused", reason: attachments.has(peer.key) ? "channel_not_found" : "machine_not_attached" });
          return computerCall(peer, Machine.WireMethod.CdpClose, { channelId, reason: "requested" }, Machine.CdpCloseResult);
        }),
      };
    }
    function openStream(id: string, request: Omit<Machine.StreamOpenRequest, "streamId">, listeners: StreamListeners): Effect.Effect<ComputerStream | Extract<Machine.StreamOpenResult, { status: "refused" }>, MachineError> {
      return Effect.gen(function* () {
        const peer = yield* screenGate(id, "stream.connection");
        if (peer === "permission_denied") return { status: "refused", reason: peer } as const;
        if (peer === "not_available") return { status: "refused", reason: "stream_not_available" } as const;
        const streams = [...relaysOf(peer.key).values()].filter((relay) => relay.kind === "stream").length;
        if (streams >= Machine.STREAM_MAX_CONCURRENT) return { status: "refused", reason: "stream_limit" } as const;
        const streamId = options.id();
        const params = yield* decode(Machine.StreamOpenRequest, { ...request, streamId }, "stream.open.request");
        const relay: Extract<Relay, { kind: "stream" }> = { kind: "stream", inbound: -1, outbound: 0, lock: Semaphore.makeUnsafe(1), listeners, end: (reason) => listeners.onClose(reason) };
        const opened = yield* openRelay(peer, streamId, relay, computerCall(peer, Machine.WireMethod.StreamOpen, params, Machine.StreamOpenResult), (result) => result.status === "opened" ? result.streamId : undefined);
        return opened.status === "opened" ? streamOf(peer, streamId, relay, opened.expiresAt) : opened;
      });
    }
    function openChannel(id: string, request: Omit<Machine.CdpOpenRequest, "channelId">, listeners: ChannelListeners): Effect.Effect<ComputerChannel | Extract<Machine.CdpOpenResult, { status: "refused" }>, MachineError> {
      return Effect.gen(function* () {
        const peer = yield* screenGate(id, "cdp.connection");
        if (peer === "permission_denied") return { status: "refused", reason: "cdp_not_available", message: "computer.use is not granted" } as const;
        if (peer === "not_available") return { status: "refused", reason: "cdp_not_available" } as const;
        const channelId = options.id();
        const params = yield* decode(Machine.CdpOpenRequest, { ...request, channelId }, "cdp.open.request");
        const relay: Extract<Relay, { kind: "cdp" }> = { kind: "cdp", inbound: -1, outbound: 0, lock: Semaphore.makeUnsafe(1), listeners, end: (reason) => listeners.onClose(reason) };
        const opened = yield* openRelay(peer, channelId, relay, computerCall(peer, Machine.WireMethod.CdpOpen, params, Machine.CdpOpenResult), (result) => result.status === "opened" ? result.channelId : undefined);
        return opened.status === "opened" ? channelOf(peer, channelId, relay, opened.expiresAt) : opened;
      });
    }
    function computerHandle(id: string): ComputerHandle {
      return {
        app: {
          launch: (request) => lifecycle(id, Machine.WireMethod.AppLaunch, Machine.AppLaunchRequest, request, Machine.AppLaunchResult),
          quit: (request) => lifecycle(id, Machine.WireMethod.AppQuit, Machine.AppQuitRequest, request, Machine.AppQuitResult),
        },
        window: {
          close: (request) => lifecycle(id, Machine.WireMethod.WindowClose, Machine.WindowCloseRequest, request, Machine.WindowCloseResult),
          park: (request) => lifecycle(id, Machine.WireMethod.WindowPark, Machine.WindowParkRequest, request, Machine.WindowParkResult),
        },
        list: (request = {}) => Effect.gen(function* () {
          const params = yield* decode(Machine.ScreenListRequest, request, "screen.list.request");
          const peer = yield* screenGate(id, "screen.list.connection");
          if (typeof peer === "string") return { status: "refused", reason: peer === "permission_denied" ? peer : "screen_not_available" } as const;
          return yield* computerCall(peer, Machine.WireMethod.ScreenList, params, Machine.ScreenListResult).pipe(
            Effect.tap((result) => Effect.sync(() => computerWindows.get(id)?.list(result))),
          );
        }),
        capture: (request) => Effect.gen(function* () {
          const params = yield* decode(Machine.ScreenCaptureRequest, request, "screen.capture.request");
          const peer = yield* screenGate(id, "screen.capture.connection");
          if (typeof peer === "string") return { status: "refused", reason: peer === "permission_denied" ? peer : "screen_not_available" } as const;
          const result = yield* computerCall(peer, Machine.WireMethod.ScreenCapture, params, Machine.ScreenCaptureResult);
          if (result.status !== "ok") return result;
          computerWindows.get(id)?.capture(params, result.captureId);
          const data = Buffer.from(result.data, "base64");
          // The base64 length bound admits up to two decoded bytes past the legacy ceiling.
          return data.length > Machine.SCREEN_PNG_MAX_BYTES
            ? { status: "refused", reason: "capture_failed", message: `capture exceeds ${Machine.SCREEN_PNG_MAX_BYTES} bytes` } as const
            : { ...result, data };
        }),
        pointer: (request) => pointer(id, request),
        key: (request) => dispatchInput(id, Machine.WireMethod.InputKey, Machine.InputKeyRequest, request),
        text: (request) => dispatchInput(id, Machine.WireMethod.InputText, Machine.InputTextRequest, request),
        observe: (request) => observation(id, request),
        settle: (request) => decode(Machine.ScreenSettleRequest, request, "screen.settle.request").pipe(
          Effect.flatMap((params) => captured(id, Machine.WireMethod.ScreenSettle, params, (grant): Machine.ScreenSettleResult => grant === "permission_denied"
            ? { status: "refused", reason: grant }
            : { status: "unsupported", blocker: "no_observer" }, (peer) => computerCall(peer, Machine.WireMethod.ScreenSettle, params, Machine.ScreenSettleResult, params.timeoutMs))),
          Effect.catchTag("MachineRefusalError", (error) => error.reason === "machine_not_attached" || error.reason === "disconnected"
            ? Effect.succeed({ status: "refused", reason: "machine_not_attached" } as const)
            : Effect.fail(error)),
        ),
        action: (request) => dispatchInput(id, Machine.WireMethod.InputAction, Machine.InputActionRequest, request),
        status: (request) => decode(Machine.InputStatusRequest, request, "input.status.request").pipe(Effect.flatMap((params) =>
          screenGate(id, "input.status.connection").pipe(Effect.flatMap((peer) => typeof peer === "string"
            ? Effect.succeed({ status: "refused", reason: "request_unknown" } as const)
            : computerCall(peer, Machine.WireMethod.InputStatus, params, Machine.InputStatusResult).pipe(
              Effect.tap((result) => Effect.sync(() => {
                if (result.status === "ok" && (result.state === "completed" || result.state === "cancelled")) reservations.release(id, result.requestId);
              })),
            ))))),
        stream: { open: (request, listeners) => openStream(id, request, listeners) },
        cdp: { open: (request, listeners) => openChannel(id, request, listeners) },
      };
    }
    return {
      get, list, place: capacity.place, capacity: capacity.capacity, exports: exportsOf,
      computer: {
        close(id) {
          computerRelays.get(id)?.close();
          const key = connectionByMachine.get(id);
          const peer = key === undefined ? undefined : attachments.get(key);
          if (peer === undefined) return;
          computerRelays.set(id, new ComputerRelay());
          dispatchComputerClose(computerCall(peer, Machine.WireMethod.ComputerClose, {
            generation: peer.generation, through: reservations.nextSequence(id),
          }, Machine.ComputerCloseResult).pipe(Effect.asVoid, Effect.catch(() => Effect.sync(() => {
            detach(peer.key, "superseded");
            peer.server.disconnect(peer.rawId);
          }))));
        },
      },
      unenroll(id, reason = "enrollment_removed") {
        revoked.set(id, (revoked.get(id) ?? 0) + 1);
        const key = connectionByMachine.get(id);
        const attachment = key === undefined ? undefined : attachments.get(key);
        if (attachment === undefined) return;
        detach(attachment.key, reason);
        attachment.server.disconnect(attachment.rawId);
      },
      endpoints: { ...(unixPath === undefined ? {} : { unix: unixPath }), ...(tcpBound === undefined ? {} : { tcp: tcpBound }) },
      close: () => close,
    };
  });
}
