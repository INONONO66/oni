import { MachinesFailure, MachineRefusalError, type LeaseHandle, type LeaseClass, type MachineError, type MachineHandle, type MachineHost, type MachineInfo } from "@oni/machines";
import type { ChannelListeners, ComputerChannel, ComputerHandle, ComputerStream, StreamListeners } from "@oni/machines";
import { listenForAbort, Machine } from "@oni/protocol";
import { Deferred, Effect, Exit, Fiber, Scope } from "effect";
import { z } from "zod";
import { CodemodeError, type CodeError } from "./errors";
import { decodeCodeFailure } from "./failure";
export * from "./errors";

type Failure = CodeError | MachineError;
type Caller = (call: Machine.ToolCall) => Effect.Effect<Machine.ToolCallResult, Failure>;
export interface RunOptions {
  readonly timeoutMs?: number;
  readonly waitMs?: number;
  readonly signal?: AbortSignal;
  readonly ownership?: { retain(): () => void; interrupt?(): void };
  readonly bindings?: Pick<CodemodeOptions, "tools" | "boundary">;
}
interface BackgroundCell {
  readonly tenant: string;
  readonly machineId: string;
  readonly controller: AbortController;
  readonly execution: Fiber.Fiber<Machine.CellResult, Failure>;
  readonly done: boolean;
  readonly quarantined: boolean;
}
const RETAINED_SETTLED_CELLS = 64;
export interface CodemodeOptions {
  /** Injected cell-id entropy (#1245): required, no ambient crypto fallback. */
  readonly id: () => string;
  readonly machines?: Pick<MachineHost, "list" | "get" | "place">;
  readonly self?: string;
  readonly completion?: (request: Machine.CompletionRequest) => Effect.Effect<string, Failure>;
  /**
   * #1305: resolves a projected tool result's stored output for the owning
   * tenant; `undefined` answers as the typed `unknown_output` error. The
   * prelude's `tool_output(output_id)` rides this host op — never a catalog
   * tool, the model-door surface stays sealed.
   */
  readonly toolOutput?: (tenant: string, outputId: string) => Effect.Effect<{ readonly text: string; readonly bytes: number; readonly mediaType?: string } | undefined, Failure>;
  readonly tools?: (tenant: string) => Caller;
  readonly boundary?: (tenant: string) => (call: Machine.ToolCall, body: () => Effect.Effect<Machine.ToolCallResult, Failure>) => Effect.Effect<Machine.ToolCallResult, Failure>;
}
const LeaseInput = z.object({ leaseId: z.string().min(1).nullish() }).strict();
const PathLeaseInput = z.object({ machineId: Machine.MachineId, path: Machine.AbsolutePath }).merge(LeaseInput);
const WriteLeaseInput = PathLeaseInput.extend({ data: z.string() });
const ShellInput = Machine.ExecRequest.extend({ machineId: Machine.MachineId }).merge(LeaseInput);
const RunInput = z.object({ machineId: Machine.MachineId, code: z.string() }).merge(LeaseInput);
const ToolOutputInput = z.object({ outputId: z.string().regex(/^sha256:[0-9a-f]{64}$/) }).strict();
const ScreenInput = Machine.ScreenReadRequest.extend({ machineId: Machine.MachineId }).merge(LeaseInput);
const InputInput = Machine.InputWriteRequest.extend({ machineId: Machine.MachineId }).merge(LeaseInput);
const FindInput = Machine.PlacementRequest.extend({
  prefer: Machine.PlacementRequest.shape.prefer.optional(),
});
const PtyOpenInput = Machine.PtyOpenRequest.extend({ machineId: Machine.MachineId, workClass: z.enum(["pty", "job"]).optional() }).merge(LeaseInput);
const PtyWriteInput = Machine.PtyWriteRequest.extend({ machineId: Machine.MachineId }).merge(LeaseInput);
const PtyReadInput = Machine.PtyReadRequest.extend({ machineId: Machine.MachineId }).merge(LeaseInput);
const PtyResizeInput = Machine.PtyResizeRequest.extend({ machineId: Machine.MachineId }).merge(LeaseInput);
const PtyCloseInput = Machine.PtyCloseRequest.extend({ machineId: Machine.MachineId }).merge(LeaseInput);
const PtyListInput = z.object({ machineId: Machine.MachineId }).merge(LeaseInput);

/** One app-owned scope retains background cells. */
export function createCodemode(options: CodemodeOptions) {
  return Effect.gen(function* () {
    const scope = yield* Scope.Scope;
    const handles = new Map<string, ReturnType<typeof makeHandle>>();
    const live = new Map<string, { caller: Caller; tenant: string; timeoutMs: number; signal?: AbortSignal; ownership?: RunOptions["ownership"]; boundary?: ReturnType<NonNullable<CodemodeOptions["boundary"]>> }>();
    const lifetime = new AbortController();
    const running = new Set<Deferred.Deferred<void>>();
    const background = new Map<string, BackgroundCell>();
    const leases = new Map<string, LeaseHandle>();
    let closed = false;
    function requireOpen(): void {
      if (closed) throw new CodemodeError({ reason: "closed", message: "codemode is closed" });
    }
    function machines(): NonNullable<CodemodeOptions["machines"]> {
      requireOpen();
      if (!options.machines) throw new CodemodeError({ reason: "machines_not_bound", message: "machine port is not bound" });
      return options.machines;
    }
    function withLease<T>(target: { machineId: string; leaseId?: string | null }, operation: (lease?: LeaseHandle) => Effect.Effect<T, Failure>): Effect.Effect<T, Failure> {
      return Effect.suspend(() => {
        const { machineId, leaseId } = target;
        if (leaseId === undefined || leaseId === null) return operation();
        const lease = leases.get(leaseId);
        if (lease === undefined || lease.machineId !== machineId)
          return Effect.fail(new CodemodeError({ reason: "lease_expired", message: `lease_expired: ${leaseId}` }));
        return operation(lease);
      }).pipe(Effect.mapError((error) =>
          error instanceof MachineRefusalError && (error.reason === "lease_expired" || error.reason === "machine_saturated")
            ? new CodemodeError({ reason: error.reason, message: error.message, credit: error.credit })
            : error));
    }
    function useMachine<T>(target: { machineId: string; leaseId?: string | null }, operation: Effect.Effect<T, Failure>, workClass: LeaseClass) {
      return withLease(target, (lease) => lease ? lease.renewWhile(operation, workClass) : operation);
    }
    function reserve(request: Parameters<MachineHost["place"]>[0], workClass: LeaseClass) {
      const outcome = machines().place(request, workClass);
      if (outcome.kind === "no_member") throw new CodemodeError({ reason: "machine_not_found", message: "no machine matches the request" });
      if (outcome.kind === "all_stale") throw new CodemodeError({ reason: "all_stale", message: "all matching machines are stale" });
      if (outcome.kind === "machine_saturated") throw new CodemodeError({ reason: "machine_saturated", message: `machine_saturated: ${outcome.machineId} (${outcome.reason})`, credit: outcome });
      leases.set(outcome.lease.id, outcome.lease);
      outcome.lease.signal.addEventListener("abort", () => {
        leases.delete(outcome.lease.id);
        handles.delete(`${outcome.machineId}\0${outcome.lease.id}`);
      }, { once: true });
      return outcome;
    }
    function select(query: z.input<typeof FindInput>) {
      const parsed = FindInput.parse(query);
      return reserve({ ...parsed, prefer: parsed.prefer ?? "spread" }, "exec");
    }
    function makeHandle(id: string, leaseId?: string | null) {
      const target = (): MachineHandle => machines().get(id);
      const binding = { machineId: id, leaseId };
      function pty<T extends { readonly status: "ok" | "refused" }>(
        name: string,
        operation: Effect.Effect<T, Failure>,
        work: { readonly op: "open" | "use"; readonly workClass?: "pty" | "job" } = { op: "use" },
      ) {
        const use = (lease?: LeaseHandle) => lease ? lease.renewPtyWhile(operation, { name, ...work }) : operation;
        if (leaseId == null && work.workClass === "job")
          return Effect.acquireUseRelease(
            Effect.try({ try: () => reserve({ machineId: id }, "job").lease, catch: decodeCodeFailure("job.admit") }),
            (lease) => withLease({ machineId: id, leaseId: lease.id }, use),
            (lease) => Effect.sync(() => lease.release()),
          );
        return withLease(binding, use);
      }
      return {
        id,
        read: (path: string) => useMachine(binding, Effect.suspend(() => target().fs.read(path)), "exec"),
        write: (path: string, data: Uint8Array) => useMachine(binding, Effect.suspend(() => target().fs.write(path, data)), "exec"),
        ls: (path: string) => useMachine(binding, Effect.suspend(() => target().fs.list(path)), "exec"),
        bash: (command: string, cwd: string) => useMachine(binding, Effect.suspend(() => target().exec(command, cwd)), "exec"),
        eval: (cell: Machine.CellRequest, signal?: AbortSignal) => useMachine(binding, Effect.suspend(() => target().runCode(cell, signal)), "eval"),
        screen: (request: Machine.ScreenReadRequest) => useMachine(binding, Effect.suspend(() => target().screen(request)), "exec"),
        input: (request: Machine.InputWriteRequest) => useMachine(binding, Effect.suspend(() => target().input(request)), "exec"),
        // Persistent terminals (#1273): mirror of MachineHandle.pty.
        pty: {
          open: (name: string, cwd: string, workClass: "pty" | "job" = "pty") => pty(name, Effect.suspend(() => target().pty.open(name, cwd)), { op: "open", workClass }),
          write: (name: string, data: Uint8Array) => pty(name, Effect.suspend(() => target().pty.write(name, data))),
          read: (name: string, options?: { cursor?: string; waitMs?: number }) => pty(name, Effect.suspend(() => target().pty.read(name, options))),
          resize: (name: string, cols: number, rows: number) => pty(name, Effect.suspend(() => target().pty.resize(name, cols, rows))),
          close: (name: string) => pty(name, Effect.suspend(() => target().pty.close(name))),
          list: () => useMachine(binding, Effect.suspend(() => target().pty.list()), "pty"),
        },
        computer: computerHandle(id, target, binding),
      };
    }
    /**
     * Computer use (#1662): the host's `MachineHandle.computer` under the
     * wire op names, every call (including each later stream signal and
     * channel send) behind the same lease fence as the other handle methods.
     * The host keeps the grant, enrollment and input-capture checks.
     */
    function computerHandle(id: string, target: () => MachineHandle, binding: { machineId: string; leaseId?: string | null }) {
      const fenced = <T>(operation: Effect.Effect<T, Failure>) => useMachine(binding, operation, "exec");
      const use = <T>(operation: (computer: ComputerHandle) => Effect.Effect<T, Failure>) => fenced(Effect.suspend(() => {
        const computer = target().computer;
        return computer === undefined
          ? Effect.fail(new CodemodeError({ reason: "computer_not_bound", message: `machine ${id} exposes no computer surface` }))
          : operation(computer);
      }));
      const stream = (open: ComputerStream) => ({
        streamId: open.streamId, expiresAt: open.expiresAt,
        signal: (signal: Machine.StreamSignalRequest["signal"]) => fenced(open.signal(signal)),
        close: () => fenced(open.close()),
      });
      const channel = (open: ComputerChannel) => ({
        channelId: open.channelId, expiresAt: open.expiresAt,
        send: (data: Uint8Array) => fenced(open.send(data)),
        close: () => fenced(open.close()),
      });
      return {
        screen: {
          list: (request?: Machine.ScreenListRequest) => use((computer) => computer.list(request)),
          capture: (request: Machine.ScreenCaptureRequest) => use((computer) => computer.capture(request)),
          observe: (request: Machine.ScreenObserveRequest) => use((computer) => computer.observe(request)),
          settle: (request: Machine.ScreenSettleRequest) => use((computer) => computer.settle(request)),
        },
        input: {
          pointer: (request: Machine.InputPointerRequest) => use((computer) => computer.pointer(request)),
          key: (request: Machine.InputKeyRequest) => use((computer) => computer.key(request)),
          text: (request: Machine.InputTextRequest) => use((computer) => computer.text(request)),
          action: (request: Machine.InputActionRequest) => use((computer) => computer.action(request)),
        },
        app: {
          launch: (request: Machine.AppLaunchRequest) => use((computer) => computer.app.launch(request)),
          quit: (request: Machine.AppQuitRequest) => use((computer) => computer.app.quit(request)),
        },
        window: {
          close: (request: Machine.WindowCloseRequest) => use((computer) => computer.window.close(request)),
          park: (request: Machine.WindowParkRequest) => use((computer) => computer.window.park(request)),
        },
        stream: {
          open: (request: Omit<Machine.StreamOpenRequest, "streamId">, listeners: StreamListeners) =>
            use((computer) => computer.stream.open(request, listeners)).pipe(Effect.map((opened) => "status" in opened ? opened : stream(opened))),
        },
        cdp: {
          open: (request: Omit<Machine.CdpOpenRequest, "channelId">, listeners: ChannelListeners) =>
            use((computer) => computer.cdp.open(request, listeners)).pipe(Effect.map((opened) => "status" in opened ? opened : channel(opened))),
        },
      };
    }
    function getMachine(id: string, leaseId?: string | null) {
      const parsed = Machine.MachineId.parse(id);
      requireOpen();
      const key = `${parsed}\0${leaseId ?? ""}`;
      let handle = handles.get(key);
      if (!handle) { handle = makeHandle(parsed, leaseId); handles.set(key, handle); }
      return handle;
    }
    function callTool(call: Machine.ToolCall): Effect.Effect<Machine.ToolCallResult, Failure> {
      return Effect.suspend(() => {
        const binding = live.get(call.cellId);
        if (!binding) return Effect.succeed({ status: "failed", error: `no tools are bound to cell ${call.cellId}` } as const);
        return binding.boundary ? binding.boundary(call, () => dispatch(call)) : dispatch(call);
      });
    }
    function dispatchCatalog(call: Machine.ToolCall): Effect.Effect<Machine.ToolCallResult | undefined, Failure> {
      if (call.name === "codemode.listMachines") return Effect.try({ try: () => Machine.ToolCallResult.parse({ status: "completed", value: machines().list() }), catch: decodeCodeFailure("machines.list") });
      if (call.name === "codemode.findMachine") return Effect.try({ try: (): Machine.ToolCallResult => { const selected = select(z.object({ query: FindInput }).strict().parse(call.arguments).query); return { status: "completed", value: { machineId: selected.machineId, leaseId: selected.lease.id } }; }, catch: decodeCodeFailure("machines.find") });
      return Effect.succeed(undefined);
    }
    function dispatchMachineOp(call: Machine.ToolCall): Effect.Effect<Machine.ToolCallResult | undefined, Failure> {
      return Effect.gen(function* () {
        if (call.name === "codemode.read") {
          const input = yield* Effect.try({ try: () => PathLeaseInput.parse(call.arguments), catch: decodeCodeFailure("read.arguments") });
          const value = yield* getMachine(input.machineId, input.leaseId).read(input.path);
          return { status: "completed", value: { ...value, data: Buffer.from(value.data).toString("base64") } };
        }
        if (call.name === "codemode.write") {
          const input = yield* Effect.try({ try: () => WriteLeaseInput.parse(call.arguments), catch: decodeCodeFailure("write.arguments") });
          return { status: "completed", value: yield* getMachine(input.machineId, input.leaseId).write(input.path, Buffer.from(input.data, "base64")) };
        }
        if (call.name === "codemode.ls") {
          const input = yield* Effect.try({ try: () => PathLeaseInput.parse(call.arguments), catch: decodeCodeFailure("ls.arguments") });
          return { status: "completed", value: yield* getMachine(input.machineId, input.leaseId).ls(input.path) };
        }
        if (call.name === "codemode.bash") {
          const input = yield* Effect.try({ try: () => ShellInput.parse(call.arguments), catch: decodeCodeFailure("bash.arguments") });
          const value = yield* getMachine(input.machineId, input.leaseId).bash(input.cmd, input.cwd);
          return { status: "completed", value: value.status === "completed" ? { ...value, stdout: Buffer.from(value.stdout).toString("base64"), stderr: Buffer.from(value.stderr).toString("base64") } : value };
        }
        return undefined;
      });
    }
    /** Computer use (#1274): same handle + authorization path, no model tool. */
    function dispatchComputerOp(call: Machine.ToolCall): Effect.Effect<Machine.ToolCallResult | undefined, Failure> {
      return Effect.gen(function* () {
        if (call.name === "codemode.screen") {
          const input = yield* Effect.try({ try: () => ScreenInput.parse(call.arguments), catch: decodeCodeFailure("screen.arguments") });
          const { machineId, leaseId, ...request } = input;
          const value = yield* getMachine(machineId, leaseId).screen(request);
          return { status: "completed", value: value.status === "ok" ? { ...value, png: Buffer.from(value.png).toString("base64") } : value };
        }
        if (call.name === "codemode.input") {
          const input = yield* Effect.try({ try: () => InputInput.parse(call.arguments), catch: decodeCodeFailure("input.arguments") });
          const { machineId, leaseId, ...request } = input;
          return { status: "completed", value: yield* getMachine(machineId, leaseId).input(request) };
        }
        return undefined;
      });
    }
    /** Persistent terminals (#1273): named tmux sessions over the same handle. */
    function ptyArgs<Shape extends z.ZodType>(call: Machine.ToolCall, schema: Shape, operation: string): Effect.Effect<z.output<Shape>, Failure> {
      return Effect.try({ try: () => schema.parse(call.arguments), catch: decodeCodeFailure(`${operation}.arguments`) });
    }
    function dispatchPtyIo(call: Machine.ToolCall): Effect.Effect<Machine.ToolCallResult | undefined, Failure> {
      return Effect.gen(function* () {
        if (call.name === "codemode.ptyOpen") {
          const input = yield* ptyArgs(call, PtyOpenInput, "ptyOpen");
          return { status: "completed", value: yield* getMachine(input.machineId, input.leaseId).pty.open(input.name, input.cwd, input.workClass) };
        }
        if (call.name === "codemode.ptyWrite") {
          const input = yield* ptyArgs(call, PtyWriteInput, "ptyWrite");
          return { status: "completed", value: yield* getMachine(input.machineId, input.leaseId).pty.write(input.name, Buffer.from(input.data, "base64")) };
        }
        if (call.name === "codemode.ptyRead") {
          const { machineId, leaseId, name, ...window } = yield* ptyArgs(call, PtyReadInput, "ptyRead");
          const value = yield* getMachine(machineId, leaseId).pty.read(name, window);
          return { status: "completed", value: value.status === "ok" ? { ...value, data: Buffer.from(value.data).toString("base64") } : value };
        }
        return undefined;
      });
    }
    function dispatchPtyControl(call: Machine.ToolCall): Effect.Effect<Machine.ToolCallResult | undefined, Failure> {
      return Effect.gen(function* () {
        if (call.name === "codemode.ptyResize") {
          const input = yield* ptyArgs(call, PtyResizeInput, "ptyResize");
          return { status: "completed", value: yield* getMachine(input.machineId, input.leaseId).pty.resize(input.name, input.cols, input.rows) };
        }
        if (call.name === "codemode.ptyClose") {
          const input = yield* ptyArgs(call, PtyCloseInput, "ptyClose");
          return { status: "completed", value: yield* getMachine(input.machineId, input.leaseId).pty.close(input.name) };
        }
        if (call.name === "codemode.ptyList") {
          const input = yield* ptyArgs(call, PtyListInput, "ptyList");
          return { status: "completed", value: yield* getMachine(input.machineId, input.leaseId).pty.list() };
        }
        return undefined;
      });
    }
    /** #1305: the prelude's `tool_output` host op — full stored bytes, typed unknown. */
    function readStoredOutput(call: Machine.ToolCall, tenant: string, read: NonNullable<CodemodeOptions["toolOutput"]>): Effect.Effect<Machine.ToolCallResult, Failure> {
      return Effect.gen(function* () {
        const input = yield* Effect.try({ try: () => ToolOutputInput.parse(call.arguments), catch: decodeCodeFailure("toolOutput.arguments") });
        const stored = yield* read(tenant, input.outputId);
        if (stored === undefined)
          return yield* new CodemodeError({ reason: "unknown_output", message: `no stored output ${input.outputId}` });
        return { status: "completed", value: { text: stored.text, bytes: stored.bytes, ...(stored.mediaType === undefined ? {} : { mediaType: stored.mediaType }) } };
      });
    }
    function dispatchHostOp(call: Machine.ToolCall, binding: NonNullable<ReturnType<typeof live.get>>): Effect.Effect<Machine.ToolCallResult | undefined, Failure> {
      return Effect.gen(function* () {
        if (call.name === "codemode.eval") {
          const input = yield* Effect.try({ try: () => RunInput.parse(call.arguments), catch: decodeCodeFailure("eval.arguments") });
          const started = yield* launch(input.machineId, input.code, `${binding.tenant}/nested`, binding.caller, { timeoutMs: binding.timeoutMs, signal: binding.signal, ownership: binding.ownership, leaseId: input.leaseId }, binding.boundary);
          return { status: "completed", value: yield* Fiber.join(started.entry.execution) };
        }
        if (call.name === "completion" && options.completion) {
          const input = yield* Effect.try({ try: () => Machine.CompletionRequest.parse(call.arguments), catch: decodeCodeFailure("completion.arguments") });
          return { status: "completed", value: yield* options.completion(input) };
        }
        if (call.name === "tool_output" && options.toolOutput)
          return yield* readStoredOutput(call, binding.tenant, options.toolOutput);
        return undefined;
      });
    }
    function dispatch(call: Machine.ToolCall): Effect.Effect<Machine.ToolCallResult, Failure> {
      return Effect.gen(function* () {
        const binding = live.get(call.cellId);
        if (!binding) return yield* new CodemodeError({ reason: "unknown_cell_id", message: "cell has settled" });
        const resolvers = [dispatchCatalog, dispatchMachineOp, dispatchComputerOp, dispatchPtyIo, dispatchPtyControl, (op: Machine.ToolCall) => dispatchHostOp(op, binding)];
        for (const resolve of resolvers) {
          const result = yield* resolve(call);
          if (result !== undefined) return result;
        }
        return yield* binding.caller(call);
      });
    }
    function tenantCell(cellId: string, tenant: string): BackgroundCell {
      requireOpen(); const entry = background.get(cellId);
      if (!entry || entry.tenant !== tenant) throw new CodemodeError({ reason: "unknown_cell_id", message: "no such cell" });
      return entry;
    }
    function settle(cellId: string, entry: BackgroundCell) {
      if (!entry.quarantined) background.delete(cellId);
      return Fiber.join(entry.execution);
    }
    function retainSettled(): void {
      const settled = [...background].filter(([, entry]) => entry.done && !entry.quarantined);
      for (const [cellId] of settled.slice(0, Math.max(0, settled.length - RETAINED_SETTLED_CELLS))) background.delete(cellId);
    }
    function peek(cellId: string, tenant: string): Effect.Effect<Machine.CellState, Failure> {
      return Effect.gen(function* () {
        const entry = yield* Effect.try({ try: () => tenantCell(cellId, tenant), catch: decodeCodeFailure("cell.peek") });
        if (entry.done) return yield* settle(cellId, entry);
        const view = yield* machines().get(entry.machineId).peekCode(cellId);
        if ("status" in view) return view;
        if (!background.has(cellId)) return yield* new CodemodeError({ reason: "unknown_cell_id", message: "no such cell" });
        return view.running ? { status: "running", cellId, output: view.output } : yield* settle(cellId, entry);
      });
    }
    function stop(cellId: string, tenant: string): Effect.Effect<Machine.CellResult, Failure> {
      return Effect.try({ try: () => tenantCell(cellId, tenant), catch: decodeCodeFailure("cell.stop") }).pipe(Effect.flatMap((entry) => { entry.controller.abort(); return settle(cellId, entry); }));
    }
    function launch(id: string, code: string, tenant: string, caller: Caller, runOptions: RunOptions & { readonly leaseId?: string | null }, boundary = (runOptions.bindings ?? options).boundary?.(tenant)) {
      return Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
        const timeoutMs = runOptions.timeoutMs ?? 15_000;
        const cellId = options.id();
        const controller = new AbortController();
        const signal = AbortSignal.any([lifetime.signal, controller.signal, ...(runOptions.signal ? [runOptions.signal] : [])]);
        const handle = yield* Effect.try({ try: () => machines().get(id), catch: decodeCodeFailure("cell.launch") });
        const release = runOptions.ownership?.retain();
        const interrupt = () => runOptions.ownership?.interrupt?.();
        const detach = listenForAbort(signal, interrupt);
        live.set(cellId, { caller, tenant, timeoutMs, signal, boundary, ownership: runOptions.ownership });
        const settled = yield* Deferred.make<void>();
        running.add(settled);
        let done = false;
        let entered = false;
        let quarantined = false;
        const operation = Effect.suspend(() => {
          entered = true;
          return handle.runCode({ cellId, code, tenant, timeoutMs }, signal);
        });
        const work = runOptions.waitMs === undefined
          ? useMachine({ machineId: id, leaseId: runOptions.leaseId }, operation, "eval")
          : Effect.acquireUseRelease(
            Effect.try({ try: () => reserve({ machineId: id }, "job").lease, catch: decodeCodeFailure("cell.admit") }),
            (lease) => lease.renewWhile(operation, "job"),
            (lease) => Effect.sync(() => lease.release()),
          );
        const execution = yield* Effect.forkIn(restore(work), scope);
        const entry: BackgroundCell = { tenant, machineId: id, controller, execution,
          get done() { return done; }, get quarantined() { return quarantined; } };
        execution.addObserver((exit) => {
          detach();
          if (Exit.isFailure(exit)) interrupt();
          done = true;
          quarantined = entered && Exit.isFailure(exit) && release !== undefined;
          if (!quarantined) { release?.(); live.delete(cellId); }
          else background.set(cellId, entry);
          running.delete(settled);
          Deferred.doneUnsafe(settled, Exit.void);
          retainSettled();
        });
        return { cellId, entry };
      }));
    }
    const close = () => Effect.gen(function* () {
      closed = true; lifetime.abort();
      for (const lease of leases.values()) lease.release();
      leases.clear();
      handles.clear();
      yield* Effect.forEach([...running], Deferred.await, { discard: true });
      if ([...background.values()].some((entry) => entry.quarantined))
        return yield* new MachinesFailure({ operation: "shutdown.cell_unsettled", cause: "physical termination was not witnessed" });
      live.clear();
    }).pipe(Effect.mapError((error) => new MachinesFailure({ operation: "code.close", cause: String(error) })));
    yield* Effect.addFinalizer(() => Effect.orDie(close()));
    return {
      listMachines: (): MachineInfo[] => machines().list(), getMachine,
      findMachine: (query: { tag: string; requires?: Machine.CapabilityId[]; prefer?: Machine.PlacementRequest["prefer"] }) => {
        const selected = select(query);
        return makeHandle(selected.machineId, selected.lease.id);
      },
      callTool: (call: Machine.ToolCall) => callTool(call).pipe(Effect.mapError((error) => new MachinesFailure({ operation: "code.tool", cause: error.message || String(error) }))),
      close,
      cell: {
        run: (code: string, tenant: string, runOptions: RunOptions = {}): Effect.Effect<Machine.CellState, Failure> => Effect.gen(function* () {
          const target = yield* Effect.try({ try: () => machines().list().find((entry) => entry.machineId === (options.self ?? "self")), catch: decodeCodeFailure("cell.select") });
          if (!target?.capabilities.includes(Machine.WellKnownCapability.pythonKernel)) return { status: "refused", reason: "kernel_not_available" };
          const caller = (runOptions.bindings ?? options).tools?.(tenant) ?? (() => Effect.succeed({ status: "failed", error: "this cell exposes no tools" } as const));
          const started = yield* launch(target.machineId, code, tenant, caller, runOptions);
          if (runOptions.waitMs === undefined) return yield* Fiber.join(started.entry.execution);
          background.set(started.cellId, started.entry);
          const result = yield* Fiber.join(started.entry.execution).pipe(Effect.timeoutOption(runOptions.waitMs), Effect.onError(() => Effect.sync(() => { if (!started.entry.quarantined) background.delete(started.cellId); })));
          if (result._tag === "Some") { background.delete(started.cellId); return result.value; }
          return yield* peek(started.cellId, tenant);
        }), peek, stop,
      },
    };
  });
}
