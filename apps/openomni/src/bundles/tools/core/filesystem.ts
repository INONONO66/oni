import { join } from "node:path";
import { Core } from "@openomni/agent";
const ToolRefused = Core.ToolRefused;
import { MachineRefusalError } from "@openomni/machines";
import type { Machine } from "@openomni/protocol";
import { parseLocus, type Locus } from "../locus/index";

type FsValue<Op extends Machine.FsValue["op"]> = Extract<Machine.FsValue, { op: Op }>;
interface ToolMachine {
  readonly fs: {
    read(path: string, window?: { offset?: number; limit?: number }): Promise<Omit<FsValue<"read">, "data"> & { readonly data: Uint8Array }>;
    write(path: string, data: Uint8Array): Promise<FsValue<"write">>;
    list(path: string): Promise<FsValue<"list">>;
    stat(path: string): Promise<FsValue<"stat">>;
  };
  exec(cmd: string, cwd: string): Promise<Exclude<Machine.ExecResult, { status: "completed" }> | (Omit<Extract<Machine.ExecResult, { status: "completed" }>, "stdout" | "stderr"> & { readonly stdout: Uint8Array; readonly stderr: Uint8Array })>;
  /** Persistent terminals (#1273): the subset bash{session} drives. */
  readonly pty: {
    open(name: string, cwd: string): Promise<Machine.PtyOpenResult>;
    write(name: string, data: Uint8Array): Promise<Machine.PtyWriteResult>;
    read(name: string, options?: { cursor?: string; waitMs?: number }): Promise<Exclude<Machine.PtyReadResult, { status: "ok" }> | (Omit<Extract<Machine.PtyReadResult, { status: "ok" }>, "data"> & { readonly data: Uint8Array })>;
  };
}

export interface FilePorts {
  readonly machines?: {
    /** The configured default machine a prefix-less path resolves to (#1271). */
    readonly defaultMachine: string;
    readonly get: (id: string) => ToolMachine;
  };
}

/** The configured prefix-less target; an unconfigured plane still parses and then refuses at lookup. */
export function defaultMachineOf(ports: FilePorts): string {
  return ports.machines?.defaultMachine ?? "self";
}

/** Translate endpoint failures once; authority remains at tool.pre and the daemon. */
export function fileOperation<T>(name: string, operation: () => Promise<T>): Promise<T> {
  return operation().catch((error: Error) => {
    throw fileRefusal(name, error);
  });
}

/** Refusals pass through; daemon refusals become this tool's refusal. */
function fileRefusal(name: string, error: Error): Error {
  if (error instanceof ToolRefused) return error;
  if (error instanceof MachineRefusalError) return new ToolRefused(name, error.message);
  return error;
}

/** Every operation resolves a machine handle (#1271); there is no local filesystem path. */
export function filesystem(path: string, ports: FilePorts) {
  const locus = parseLocus(path, { defaultMachine: defaultMachineOf(ports) });
  const remote = machineHost(locus, ports);
  return {
    locus,
    read: () => remoteRead(remote, locus.path),
    write: async (data: Uint8Array) => (await remote.fs.write(locus.path, data)).bytesWritten,
    list: () => remoteList(remote, locus.path),
    kind: async () => (await remote.fs.stat(locus.path)).kind,
    size: async () => (await remote.fs.stat(locus.path)).size,
  };
}

type Remote = NonNullable<ReturnType<NonNullable<FilePorts["machines"]>["get"]>>;

/** The attached machine every locus names (#1271). */
function machineHost(locus: Locus, ports: FilePorts): Remote {
  const remote = ports.machines?.get(locus.machine);
  if (remote === undefined) throw new ToolRefused("locus", "machine host is not configured");
  return remote;
}

/** The whole file, assembled from the daemon's bounded reads. */
async function remoteRead(remote: Remote, path: string): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  for (;;) {
    const value = await remote.fs.read(path, { offset });
    chunks.push(value.data);
    offset += value.bytesRead;
    if (!value.truncated) return Buffer.concat(chunks);
    if (value.bytesRead === 0) throw new ToolRefused("read", "remote read made no progress");
  }
}

async function remoteList(remote: Remote, path: string) {
  const value = await remote.fs.list(path);
  if (value.truncated) throw new ToolRefused("ls", "directory exceeds daemon entry limit");
  return value.entries.map(({ name, kind }) => ({ name, kind }));
}

type Endpoint = ReturnType<typeof filesystem>;
type EntryKind = "file" | "dir";
/** Called once per visited path; false stops the walk. Readers open the path themselves. */
type Visit = (path: string, kind: EntryKind) => Promise<boolean>;

/**
 * Depth-first walk in name order without following symlinks: regular files
 * and directories are the only entries visited. Bound to the ports once so a
 * tool builds its walker when it is constructed.
 */
export function walker(ports: FilePorts) {
  async function step(path: string, signal: AbortSignal, visit: Visit): Promise<boolean> {
    signal.throwIfAborted();
    const endpoint = filesystem(path, ports);
    const kind = await entryKind(endpoint);
    if (!(await visit(path, kind))) return false;
    return kind === "file" || descend(path, endpoint, signal, visit);
  }
  async function descend(
    parent: string,
    endpoint: Endpoint,
    signal: AbortSignal,
    visit: Visit,
  ): Promise<boolean> {
    const entries = await endpoint.list();
    for (const entry of entries.filter((entry) => entry.kind === "file" || entry.kind === "dir"))
      if (!(await step(childPath(parent, endpoint.locus, entry.name), signal, visit))) return false;
    return true;
  }
  return step;
}

async function entryKind(endpoint: Endpoint): Promise<EntryKind> {
  const kind = await endpoint.kind();
  if (kind === "file" || kind === "dir") return kind;
  throw new ToolRefused("walk", "expected a regular file or directory");
}

/**
 * Children keep the textual prefix of their parent: a prefix-less parent
 * yields prefix-less children (the default machine re-applies on parse), an
 * explicit `machine:` parent yields explicit children.
 */
function childPath(parent: string, locus: Locus, name: string): string {
  const path = join(locus.path, name);
  return parent === locus.path ? path : `${locus.machine}:${path}`;
}

export function text(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ToolRefused("text", "file is not valid UTF-8; use read with base64 encoding");
  }
}
