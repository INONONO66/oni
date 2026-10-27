import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Machine } from "@oni/protocol";
import type { MachineInfo } from "../../src";
import type { eventCollector } from "./events";

// The real Rust client (`clients/machine-client`) is the only machine peer a
// test may attach: there is no TypeScript daemon to fake one with.

const CLIENTS = join(import.meta.dir, "../../../../clients");
const ATTACH_DEADLINE_MS = 10_000;
type Reports = Pick<ReturnType<typeof eventCollector>, "next">;

/** Every capability `handlers::SUPPORTED` can offer; the host enrollment bounds it. */
const MCLIENT_CAPABILITIES: readonly Machine.CapabilityId[] = [
  "fs.read", "fs.write", "shell.exec", "pty.session", "agent.session",
  "screen.read", "computer.use", "input.write", "kernel.py",
];

let built: Promise<string> | undefined;

export function mclientBinary(): Promise<string> {
  built ??= (async () => {
    const pinned = process.env.ONI_MCLIENT_BIN;
    if (pinned !== undefined) {
      if (!(await Bun.file(pinned).exists())) throw new Error(`ONI_MCLIENT_BIN does not exist: ${pinned}`);
      return pinned;
    }
    const build = Bun.spawn(["cargo", "build", "--release", "-p", "oni-machine-client"], {
      cwd: CLIENTS,
      env: { ...process.env, PATH: `${join(homedir(), ".cargo", "bin")}:${process.env.PATH ?? ""}` },
      stdout: "inherit", stderr: "inherit",
    });
    const code = await build.exited;
    if (code !== 0) throw new Error(`mclient build exited ${code}`);
    return join(CLIENTS, "target", "release", "mclient");
  })();
  return built;
}

/** Mirrors `ClientConfig` in `clients/machine-client/src/config.rs`. */
export interface MclientSettings {
  readonly machineId: string;
  readonly name: string;
  readonly host: string;
  readonly unix: string | null;
  readonly exports: readonly { readonly name: string; readonly path: string }[];
  readonly tags: readonly string[];
  readonly memoryBudgetMb: number;
  readonly tmuxSocket?: string;
}

function writeMclientSettings(path: string, settings: MclientSettings): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(settings), { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** Unix peers present no key, so the pinned value is never compared. */
export function mclientEnrollment(
  machineId: string,
  overrides: Partial<Machine.Enrollment> = {},
): Machine.Enrollment {
  return Machine.Enrollment.parse({
    machineId, name: machineId, allowedCapabilities: [...MCLIENT_CAPABILITIES],
    allowedExports: ["workspace"], publicKey: "0".repeat(64), enrolledAt: 1, ...overrides,
  });
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error instanceof Error && "code" in error && (error.code === "ESRCH" || error.code === "EPERM")) return;
    throw error;
  }
}

function admission(options: {
  readonly list: () => readonly MachineInfo[];
  readonly events: Reports;
  readonly machineId: string;
}) {
  const previous = options.list().find((entry) => entry.machineId === options.machineId)?.generation ?? 0;
  const settled = Promise.withResolvers<MachineInfo>();
  const timer = setTimeout(() => settled.reject(new Error(`attach deadline: ${options.machineId}`)), ATTACH_DEADLINE_MS);
  let open = true;
  void (async () => {
    while (open) {
      const event = await options.events.next(Machine.Events.Reported.name);
      if (!("machineId" in event.payload) || event.payload.machineId !== options.machineId) continue;
      const info = options.list().find((entry) => entry.machineId === options.machineId);
      if (info !== undefined && info.generation > previous) settled.resolve(info);
    }
  })();
  return {
    promise: settled.promise.finally(() => { open = false; clearTimeout(timer); }),
  };
}

export interface AttachedMclient {
  readonly pid: number;
  readonly info: MachineInfo;
  readonly exited: Promise<number>;
  /** SIGTERM the group, SIGKILL after one second; resolves once the leader is gone. */
  stop(): Promise<void>;
}

/** `events` must be the collector wired as the host's sink; admission is read there, never from stdout. */
export async function attachMclient(options: {
  readonly host: { readonly list: () => readonly MachineInfo[]; readonly endpoints: { readonly unix?: string } };
  readonly events: Reports;
  readonly machineId: string;
  readonly root: string;
  readonly exports?: MclientSettings["exports"];
  readonly tags?: readonly string[];
  readonly tmuxSocket?: string;
  /** Optional forwarding endpoint; admission still comes from the real host. */
  readonly unix?: string;
}): Promise<AttachedMclient> {
  const binary = await mclientBinary();
  const unix = options.host.endpoints.unix;
  if (unix === undefined) throw new Error("attachMclient needs a unix-listening host");
  const configRoot = mkdtempSync(join(tmpdir(), "oni-mclient-test-"));
  const configPath = join(configRoot, "client.json");
  writeMclientSettings(configPath, {
    machineId: options.machineId, name: options.machineId, host: "localhost", unix: options.unix ?? unix,
    exports: options.exports ?? [{ name: "workspace", path: options.root }],
    tags: options.tags ?? [], memoryBudgetMb: 96,
    ...(options.tmuxSocket === undefined ? {} : { tmuxSocket: options.tmuxSocket }),
  });
  const pending = admission({ list: options.host.list, events: options.events, machineId: options.machineId });
  const child = Bun.spawn([binary, "run", "--config", configPath], {
    stdin: "ignore", stdout: "inherit", stderr: "inherit", detached: true,
  });
  const exited = child.exited.finally(() => signalGroup(child.pid, "SIGKILL"));
  const info = await Promise.race([
    pending.promise,
    exited.then((code) => { throw new Error(`mclient exited before attachment: ${code}`); }),
  ]).catch((error: Error) => {
    signalGroup(child.pid, "SIGKILL");
    rmSync(configRoot, { recursive: true, force: true });
    throw error;
  });
  return {
    pid: child.pid, info, exited,
    async stop() {
      try {
        if (child.exitCode !== null || child.signalCode !== null) { await exited; return; }
        signalGroup(child.pid, "SIGTERM");
        const deadline = setTimeout(() => signalGroup(child.pid, "SIGKILL"), 1000);
        try { await exited; } finally { clearTimeout(deadline); }
      } finally {
        rmSync(configRoot, { recursive: true, force: true });
      }
    },
  };
}
