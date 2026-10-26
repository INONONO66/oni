import { Effect } from "effect";
import type { Machine } from "@oni/protocol";
import { createCodemode as create } from "../../../src";
import { decodeCodeFailure } from "../../../src/failure";
import type { CodeError } from "../../../src/errors";
import type { MachineHost } from "../../../../machines/test/helpers/native";
import { acquireSync, run } from "../../../../machines/test/ipc/helpers/effects";
export * from "../../../src/errors";

type Caller = (call: Machine.ToolCall) => Promise<Machine.ToolCallResult>;
type Boundary = (call: Machine.ToolCall, body: () => Promise<Machine.ToolCallResult>) => Promise<Machine.ToolCallResult>;
function code<A>(body: () => Promise<A>): Effect.Effect<A, CodeError> {
  return Effect.tryPromise({ try: body, catch: decodeCodeFailure("test.code") });
}
/** Deterministic injected cell-id entropy (#1245) for tests. */
function sequentialCellIds(): () => string {
  let n = 0;
  return () => { n += 1; return `cell-${n}`; };
}

export function createCodemode(options: {
  id?: () => string;
  machines?: Pick<MachineHost, "list" | "get" | "place">;
  completion?: (request: Machine.CompletionRequest) => Promise<string>;
  toolOutput?: (tenant: string, outputId: string) => Promise<{ text: string; bytes: number; mediaType?: string } | undefined>;
  tools?: (tenant: string) => Caller;
  boundary?: (tenant: string) => Boundary;
  self?: string;
} = {}) {
  const completion = options.completion;
  const toolOutput = options.toolOutput;
  const tools = options.tools;
  const boundary = options.boundary;
  const machines = options.machines;
  const { value: native, close } = acquireSync(create({
    id: options.id ?? sequentialCellIds(),
    machines: machines ? { list: machines.list, place: machines.place, get: (id) => machines.get(id).native } : undefined,
    completion: completion ? (request) => code(() => completion(request)) : undefined,
    toolOutput: toolOutput ? (tenant, outputId) => code(() => toolOutput(tenant, outputId)) : undefined,
    tools: tools ? (tenant) => { const call = tools(tenant); return (request) => code(() => call(request)); } : undefined,
    boundary: boundary ? (tenant) => { const decide = boundary(tenant); return (call, body) => code(() => decide(call, () => run(body()))); } : undefined,
    self: options.self,
  }));
  const shutdown = async () => { await run(native.close()); await close(); };
  type Handle = ReturnType<typeof native.getMachine>;
  function wrapHandle(handle: Handle) {
    return { id: handle.id, read: (...args: Parameters<Handle["read"]>) => run(handle.read(...args)),
      write: (...args: Parameters<Handle["write"]>) => run(handle.write(...args)),
      ls: (...args: Parameters<Handle["ls"]>) => run(handle.ls(...args)),
      bash: (...args: Parameters<Handle["bash"]>) => run(handle.bash(...args)),
      eval: (...args: Parameters<Handle["eval"]>) => run(handle.eval(...args)),
      screen: (...args: Parameters<Handle["screen"]>) => run(handle.screen(...args)),
      input: (...args: Parameters<Handle["input"]>) => run(handle.input(...args)),
    };
  }
  const handles = new Map<Handle, ReturnType<typeof wrapHandle>>();
  function handle(value: Handle) {
    let found = handles.get(value);
    if (!found) { found = wrapHandle(value); handles.set(value, found); }
    return found;
  }
  return { native, close: shutdown, listMachines: native.listMachines,
    getMachine: (id: string) => handle(native.getMachine(id)),
    findMachine: (query: Parameters<typeof native.findMachine>[0]) => handle(native.findMachine(query)),
    callTool: (...args: Parameters<typeof native.callTool>) => run(native.callTool(...args)),
    cell: {
      run: (...args: Parameters<typeof native.cell.run>) => run(native.cell.run(...args)),
      peek: (...args: Parameters<typeof native.cell.peek>) => run(native.cell.peek(...args)),
      stop: (...args: Parameters<typeof native.cell.stop>) => run(native.cell.stop(...args)),
    },
  };
}
