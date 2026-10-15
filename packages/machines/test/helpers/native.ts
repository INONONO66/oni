import { Effect } from "effect";
import type { Machine } from "@openomni/protocol";
import * as Native from "../../src";
import { createFsDriver as fsDriver } from "../../src/fs";
import { decodeMachineFailure } from "../../src/failure";
import { acquire, run, sync } from "../ipc/helpers/effects";
export * from "../../src/errors";

function sequentialIds(prefix: string): () => string {
  let n = 0;
  return () => { n += 1; return `${prefix}-${n}`; };
}
export function foreign<A>(body: () => Promise<A>): Effect.Effect<A, Native.MachineError> {
  return Effect.tryPromise({ try: body, catch: decodeMachineFailure("test.machine") });
}
/** #1312: the explicit tool port for hosts wired without one in tests. */
export function refusingToolPort(): Effect.Effect<never, Native.MachineError> {
  return Effect.fail(new Native.MachineRefusalError({ reason: "host_tool_missing", message: "host_tool_missing: this host was wired without a tool port" }));
}
export interface CodeRunner {
  readonly native?: Native.CodeRunner;
  runCode(request: Machine.CellRequest, call: (call: Machine.ToolCall) => Promise<Machine.ToolCallResult>, signal: AbortSignal): Promise<Machine.CellResult>;
  peekCode(cellId: string): Machine.CellOutput;
  close(): Promise<void>;
}
function nativeRunner(runner: CodeRunner): Native.CodeRunner {
  return runner.native ?? {
    runCode: (request, call, signal) => foreign(() => runner.runCode(request, (request) => run(call(request)), signal)),
    peekCode: runner.peekCode,
    close: () => foreign(() => runner.close()),
  };
}
function machineHandle(native: Native.MachineHandle) {
  return { native,
    fs: {
      read: (...args: Parameters<typeof native.fs.read>) => run(native.fs.read(...args)),
      write: (...args: Parameters<typeof native.fs.write>) => run(native.fs.write(...args)),
      list: (...args: Parameters<typeof native.fs.list>) => run(native.fs.list(...args)),
      stat: (...args: Parameters<typeof native.fs.stat>) => run(native.fs.stat(...args)),
    },
    exec: (...args: Parameters<typeof native.exec>) => run(native.exec(...args)),
    pty: {
      open: (...args: Parameters<typeof native.pty.open>) => run(native.pty.open(...args)),
      write: (...args: Parameters<typeof native.pty.write>) => run(native.pty.write(...args)),
      read: (...args: Parameters<typeof native.pty.read>) => run(native.pty.read(...args)),
      resize: (...args: Parameters<typeof native.pty.resize>) => run(native.pty.resize(...args)),
      close: (...args: Parameters<typeof native.pty.close>) => run(native.pty.close(...args)),
      list: () => run(native.pty.list()),
    },
    screen: (...args: Parameters<typeof native.screen>) => run(native.screen(...args)),
    input: (...args: Parameters<typeof native.input>) => run(native.input(...args)),
    runCode: (...args: Parameters<typeof native.runCode>) => run(native.runCode(...args)),
    peekCode: (...args: Parameters<typeof native.peekCode>) => run(native.peekCode(...args)),
  };
}
export type MachineHandle = ReturnType<typeof machineHandle>;
export async function createMachineHost(options: Omit<Parameters<typeof Native.createMachineHost>[0], "callTool" | "id" | "dispatcherBound"> & { id?: () => string; dispatcherBound?: number; callTool?: (call: Machine.ToolCall) => Promise<Machine.ToolCallResult> }) {
  const callTool = options.callTool;
  const { value: native, close } = await acquire(Native.createMachineHost({ ...options, id: options.id ?? sequentialIds("host-req"), dispatcherBound: options.dispatcherBound ?? 256, callTool: callTool ? (call) => foreign(() => callTool(call)) : refusingToolPort }));
  const handles = new Map<string, MachineHandle>();
  return { native, list: native.list, endpoints: native.endpoints,
    get(id: string) { let handle = handles.get(id); if (!handle) { handle = machineHandle(native.get(id)); handles.set(id, handle); } return handle; },
    close: async () => { await run(native.close()); await close(); },
  };
}
export type MachineHost = Awaited<ReturnType<typeof createMachineHost>>;
type NativeDaemonOptions = Parameters<typeof Native.attachMachineDaemon>[0];
type DaemonConnection =
  | Omit<Extract<NativeDaemonOptions, { socketPath: string }>, "runner" | "id" | "dispatcherBound">
  | Omit<Extract<NativeDaemonOptions, { tcp: { host: string; port: number } }>, "runner" | "id" | "dispatcherBound">;
export async function attachMachineDaemon(options: DaemonConnection & { id?: () => string; dispatcherBound?: number; runner?: CodeRunner }) {
  const { value: native, close } = await acquire(Native.attachMachineDaemon({ ...options, id: options.id ?? sequentialIds("daemon-req"), dispatcherBound: options.dispatcherBound ?? 256, runner: options.runner ? nativeRunner(options.runner) : undefined }));
  return { native, get attachment() { return native.attachment; }, get closed() { return run(native.closed); }, close: async () => { await run(native.close()); await close(); } };
}
export function createFsDriver(...args: Parameters<typeof fsDriver>) {
  const native = sync(fsDriver(...args));
  const driver = (...params: Parameters<typeof native>) => run(native(...params));
  driver.stream = (...params: Parameters<typeof native.stream>) => run(native.stream(...params));
  driver.close = () => sync(native.close());
  return driver;
}
