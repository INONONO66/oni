import { chmodSync } from "node:fs";
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { isContained, normalizeExportRoot } from "./contained";
import { createIpcServer, createIpcTcpServer, type IpcServer, type IpcTlsIdentity } from "./ipc";
import { typedCall } from "./typed-call";
import { type BusEvent, type Ipc, Machine } from "@openomni/protocol";
import { Effect, Fiber, type Scope } from "effect";
import { MachinesFailure, MachineCellError, MachineRefusalError, TransportFailure, type MachineError } from "./errors";
import { decodeMachineFailure } from "./failure";
import { onAbort } from "./interrupt-on";
import { createPtyHandle, type PtyHandle } from "./pty-host";
import { createCapacity, type HostPlacement, type HostPlacementRequest, type LeaseClass, type LeaseScheduler } from "./capacity";

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
  readonly events: BusEvent.Sink;
  readonly now: () => number;
  /**
   * Required tool port (#1312): a host wired without one must say so with an
   * explicit implementation failing `host_tool_missing`, never a fabricated
   * `{ status: "failed" }` tool result.
   */
  readonly callTool: (call: Machine.ToolCall) => Effect.Effect<Machine.ToolCallResult, MachineError>;
  /**
   * Machine ids whose live attachment is never superseded (#1271): while such
   * an id is attached, a second offer for it from another connection is
   * refused `already_attached` instead of detaching the incumbent. The app
   * passes the self machine id so no same-uid process can hijack the brain's
   * own fs/shell plane through the reattach-supersede path.
   */
  readonly neverSupersede?: readonly Machine.MachineId[];
  /**
   * Age (host clock, since receipt) past which the latest `machine.report`
   * reads `live.stale: true` (#1555). Default 15 000 ms = three missed
   * heartbeats at the daemon's default cadence.
   */
  readonly staleAfterMs?: number;
  readonly capacity?: readonly Machine.CapacityRow[];
  readonly scheduler?: LeaseScheduler;
  readonly idleTtlMs?: number;
}
/** Default `staleAfterMs`: three missed default-cadence heartbeats. */
const REPORT_STALE_AFTER_MS = 15_000;
/** A bulk read still fits a single codemode tool reply after base64 encoding. */
const BULK_READ_MAX_BYTES = 8 * 1024 * 1024;
type Value<O extends Machine.FsValue["op"]> = Extract<Machine.FsValue, { op: O }>;
type ReadValue = Omit<Value<"read">, "data"> & { readonly data: Uint8Array };
type ExecValue = Omit<Extract<Machine.ExecResult, { status: "completed" }>, "stdout" | "stderr"> & { readonly stdout: Uint8Array; readonly stderr: Uint8Array };
type ScreenValue = Omit<Extract<Machine.ScreenReadResult, { status: "ok" }>, "png"> & { readonly png: Uint8Array };
export interface MachineHandle {
  readonly fs: {
    read(path: string, window?: { offset?: number; limit?: number }): Effect.Effect<ReadValue, MachineError>;
    write(path: string, data: Uint8Array): Effect.Effect<Value<"write">, MachineError>;
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
}
/** Attached enrollment, negotiated capabilities and optional resource observations. */
export type MachineInfo = Machine.Info;
export interface MachineHost {
  list(): MachineInfo[];
  place(request: HostPlacementRequest, workClass?: LeaseClass): HostPlacement;
  capacity(): ReturnType<ReturnType<typeof createCapacity>["capacity"]>;
  get(id: Machine.MachineId): MachineHandle;
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
type HostListener = Pick<IpcServer, "call" | "useConnection" | "peerFingerprintOf" | "disconnect">;
interface Attachment {
  readonly enrollment: Machine.Enrollment;
  readonly offer: Machine.Offer;
  readonly capabilities: readonly string[];
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

export function createMachineHost(options: MachineHostOptions): Effect.Effect<MachineHost, MachineError, Scope.Scope> {
  return Effect.gen(function* () {
    const rows = yield* Effect.try({ try: () => Machine.CapacityRows.parse(options.capacity ?? []), catch: decodeMachineFailure("capacity.decode") });
    const attachments = new Map<string, Attachment>();
    const connectionByMachine = new Map<string, string>();
    /** Machines that attached at least once: their detached window reads `disconnected`. */
    const known = new Set<string>();
    const inFlight = new Map<string, Set<string>>();
    const handles = new Map<string, MachineHandle>();
    /** Latest accepted heartbeat per attachment key, stamped with host receipt time. */
    const reports = new Map<string, { readonly report: Machine.Report; readonly receivedAt: number }>();
    const staleAfterMs = options.staleAfterMs ?? REPORT_STALE_AFTER_MS;
    const capacity = createCapacity({ ...options, rows, list });
    function detach(key: string, reason: import("zod").infer<typeof Machine.Events.Detached.schema>["reason"]): void {
      const attachment = attachments.get(key);
      if (attachment === undefined) return;
      attachments.delete(key);
      inFlight.delete(key);
      reports.delete(key);
      capacity.detach(attachment.offer.machineId);
      if (connectionByMachine.get(attachment.offer.machineId) === key) connectionByMachine.delete(attachment.offer.machineId);
      options.events.publish(Machine.Events.Detached, { machineId: attachment.offer.machineId, time: options.now(), reason });
    }
    /**
     * A live attachment on another connection is detached in favor of the new
     * offer — unless the id is in `neverSupersede` (#1271): then the incumbent
     * stays authoritative and the caller must refuse `already_attached`.
     */
    function supersedeIncumbent(machineId: string, sourceKey: string): boolean {
      const stale = connectionByMachine.get(machineId);
      if (stale === undefined || stale === sourceKey) return true;
      if (options.neverSupersede?.includes(machineId) === true) return false;
      detach(stale, "superseded_by_reattach");
      return true;
    }
    function callTool(call: Machine.ToolCall, key: string): Effect.Effect<Machine.ToolCallResult, MachineError> {
      return Effect.suspend(() => {
        if (!attachments.has(key) || !inFlight.get(key)?.has(call.cellId)) return new MachineCellError({ code: "unknown_cell_id", cellId: call.cellId, message: `no cell in flight: ${call.cellId}` });
        return options.callTool(call);
      });
    }
    function attach(offer: Machine.Offer, respond: (result: Machine.AttachResult) => void, source: RequestSource): Effect.Effect<void, MachineError> {
      return Effect.gen(function* () {
        const found = options.enrollment(offer.machineId);
        if (found === undefined) { respond({ status: "refused", reason: "machine_not_enrolled" } satisfies Machine.AttachResult); return; }
        const enrollment = yield* Effect.try({ try: () => Machine.Enrollment.parse(found), catch: decodeMachineFailure("enrollment.decode") });
        // Pinned admission (#1270): a TCP peer is judged by its mutual-TLS key
        // BEFORE anything else about the offer is honored. A mismatch admits
        // nothing — the currently valid attachment (if any) stays authoritative.
        const presented = source.server.peerFingerprintOf(source.rawId);
        if (presented !== undefined && presented !== enrollment.publicKey) { respond({ status: "refused", reason: "peer_key_mismatch" } satisfies Machine.AttachResult); return; }
        const outcome = Machine.effectiveCapabilities(enrollment, offer);
        const exports = Machine.effectiveExports(enrollment, offer);
        if (outcome.kind === "machine_mismatch" || exports.kind === "machine_mismatch") { respond({ status: "refused", reason: "machine_mismatch" } satisfies Machine.AttachResult); return; }
        if (!supersedeIncumbent(offer.machineId, source.key)) {
          respond({ status: "refused", reason: "already_attached" } satisfies Machine.AttachResult);
          return;
        }
        detach(source.key, "superseded_by_reattach");
        attachments.set(source.key, { enrollment, offer, capabilities: outcome.capabilities, ...source });
        connectionByMachine.set(offer.machineId, source.key);
        known.add(offer.machineId);
        options.events.publish(Machine.Events.Attached, { machineId: offer.machineId, time: options.now(), effectiveCapabilities: [...outcome.capabilities] });
        respond({ status: "attached", effectiveCapabilities: [...outcome.capabilities], effectiveExports: [...exports.exports] } satisfies Machine.AttachResult);
      });
    }
    /**
     * One heartbeat (#1555). Only the connection that attached may report,
     * and only for the machine it attached as; anything else is a typed
     * refusal and the host keeps nothing from it.
     */
    function report(incoming: Machine.Report, source: RequestSource): Machine.ReportResult {
      const attachment = attachments.get(source.key);
      if (attachment === undefined) return { status: "refused", reason: "machine_not_attached" };
      if (attachment.offer.machineId !== incoming.machineId) return { status: "refused", reason: "machine_mismatch" };
      const receivedAt = options.now();
      reports.set(source.key, { report: incoming, receivedAt });
      options.events.publish(Machine.Events.Reported, { machineId: incoming.machineId, time: receivedAt, reportedAt: incoming.reportedAt, load: incoming.load });
      return { status: "accepted" };
    }
    function dispatchRequest(method: string, params: Ipc.Request["params"], respond: (result: Ipc.Response["result"]) => void, source: RequestSource): Effect.Effect<void, MachinesFailure> {
      return Effect.gen(function* () {
        if (method === Machine.WireMethod.CallTool) {
          const call = yield* Effect.try({ try: () => Machine.ToolCall.parse(params), catch: decodeMachineFailure("tool.decode") });
          respond(yield* callTool(call, source.key));
          return;
        }
        if (method === Machine.WireMethod.Report) {
          const incoming = yield* Effect.try({ try: () => Machine.Report.parse(params), catch: decodeMachineFailure("report.decode") });
          respond(report(incoming, source));
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
          dispatchRequest(method, params, respond, { key: `${label}:${rawId}`, rawId, server: api }),
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

    function connection(id: string): Attachment {
      const key = connectionByMachine.get(id);
      const attachment = key === undefined ? undefined : attachments.get(key);
      if (attachment === undefined) {
        if (known.has(id)) throw new MachineRefusalError({ reason: "disconnected", message: `machine is disconnected: ${id}` });
        throw new MachineRefusalError({ reason: "machine_not_attached", message: `machine is not attached: ${id}` });
      }
      return attachment;
    }
    function location(id: string, path: string) {
      const peer = connection(id);
      const absolute = posix.normalize(Machine.AbsolutePath.parse(path));
      const candidates = (peer.offer.exports ?? [])
        .map((entry) => ({ ...entry, path: normalizeExportRoot(entry.path) }))
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
    function filesystem<O extends Machine.FsValue["op"]>(id: string, path: string, op: O, extra: { data?: string; offset?: number; limit?: number } = {}): Effect.Effect<Value<O>, MachineError> {
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
    function streamWrite(id: string, path: string, data: Uint8Array): Effect.Effect<Value<"write">, MachineError> {
      return Effect.gen(function* () {
        const target = yield* Effect.try({ try: () => location(id, path), catch: decodeMachineFailure("fs.location") });
        const transferId = options.id();
        return yield* withTransfer(target.peer, transferId, Effect.gen(function* () {
          const begin = yield* streamCall(target.peer, { op: "begin", mode: "write", transferId, export: target.export, path: target.path });
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
    function get(id: string): MachineHandle {
      const existing = handles.get(id);
      if (existing !== undefined) return existing;
      const terminal = createPtyHandle((method, params, timeoutMs) => Effect.gen(function* () {
        const peer = yield* Effect.try({ try: () => connection(id), catch: decodeMachineFailure("pty.connection") });
        peer.server.useConnection(peer.rawId);
        return yield* peer.server.call(method, params as Ipc.Request["params"], timeoutMs).pipe(Effect.mapError(transportFailure("pty.call")));
      }), (name) => capacity.terminalClosed(id, name));
      const handle: MachineHandle = {
        fs: {
          read: (path, window = {}) => window.limit === undefined || window.limit <= Machine.FS_READ_MAX_BYTES
            ? filesystem(id, path, "read", window).pipe(Effect.map((value) => ({ ...value, data: Buffer.from(value.data, "base64") })))
            : streamRead(id, path, window),
          write: (path, data) => data.byteLength <= Machine.FS_WRITE_MAX_BYTES
            ? filesystem(id, path, "write", { data: Buffer.from(data).toString("base64") })
            : streamWrite(id, path, data),
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
          return yield* typedCall(peer.server, Machine.WireMethod.RunCode, request, request.timeoutMs + 1000).pipe(
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
      };
      handles.set(id, handle);
      return handle;
    }
    const close = Effect.suspend(() => {
      for (const key of attachments.keys()) detach(key, "host_closed");
      return Effect.forEach(servers, (server) => server.close(), { discard: true }).pipe(Effect.mapError(transportFailure("host.close")));
    });
    yield* Effect.addFinalizer(() => Effect.orDie(close));
    function list(): MachineInfo[] {
      return [...attachments.values()].map(({ enrollment, offer, capabilities, key }): MachineInfo => {
        const latest = reports.get(key);
        return {
          ...structuredClone(enrollment),
          tags: [...(enrollment.tags ?? [])],
          capabilities: [...capabilities],
          os: offer.platform.split("-")[0] ?? offer.platform,
          arch: offer.platform.split("-").slice(1).join("-"),
          ...(offer.resources === undefined ? {} : { resources: { ...offer.resources } }),
          ...(latest === undefined ? {} : { live: { reportedAt: latest.report.reportedAt, load: { ...latest.report.load }, stale: options.now() - latest.receivedAt > staleAfterMs } }),
        };
      }).sort((a, b) => a.machineId.localeCompare(b.machineId));
    }
    return {
      get, list, place: capacity.place, capacity: capacity.capacity,
      unenroll(id, reason = "enrollment_removed") {
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
