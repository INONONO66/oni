import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
/** The one mode a machine joins and attaches in (#1837); `AttachMode` is schema-local like `Peer`, so it is read off `Info`. */
export type AttachMode = NonNullable<MachineInfo["mode"]>;

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
    const binary = join(CLIENTS, "target", "release", "mclient");
    // Cargo re-links the uplifted binary on every build, even a no-op one,
    // so its first exec pays the code-signature check; pay it here rather
    // than inside a bounded test window.
    const warm = Bun.spawn([binary, "--version"], { stdin: "ignore", stdout: "ignore", stderr: "inherit" });
    if ((await warm.exited) !== 0) throw new Error("mclient did not start after its build");
    return binary;
  })();
  return built;
}

/** Mirrors `ClientConfig` in `clients/machine-client/src/config.rs`. */
interface MclientSettings {
  readonly machineId: string;
  readonly name: string;
  readonly host: string;
  readonly unix: string | null;
  readonly exports: readonly { readonly name: string; readonly path: string }[];
  readonly tags: readonly string[];
  readonly memoryBudgetMb: number;
  readonly mode?: AttachMode;
  readonly tmuxSocket?: string;
  readonly computer?: { readonly layout: string; readonly recorder: string };
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

function unixCarrier(options: {
  readonly host: { readonly endpoints: { readonly unix?: string } };
  readonly unix?: string;
}): Pick<MclientSettings, "host" | "unix"> {
  const unix = options.host.endpoints.unix;
  if (unix === undefined) throw new Error("attachMclient needs a unix-listening host");
  return { host: "localhost", unix: options.unix ?? unix };
}

/** What `mclient join --json` prints as `receipt`: the client's own identity, the host pin it recorded, and the mode it joined in (#1837). */
interface MclientJoinReceipt {
  readonly machineId: string;
  readonly name: string;
  readonly publicKey: Machine.KeyFingerprint;
  readonly hostPin: string | null;
  readonly allowedCapabilities: readonly string[];
  readonly allowedExports: readonly string[];
  readonly mode: AttachMode | null;
  /** The Tailscale readiness steps a tailnet join took; `null` for a domain join. */
  readonly tailscale: { readonly state: string; readonly steps: readonly { readonly step: string; readonly via?: string; readonly ok: boolean }[] } | null;
}

export interface JoinedMclient {
  /** `<home>/.oni/machine-client`: `client.json`, the client identity and `host-pin`, all written by the join. */
  readonly directory: string;
  readonly configPath: string;
  readonly receipt: MclientJoinReceipt;
  /** The `host-pin` file as the join left it. */
  recordedHostPin(): string;
  remove(): void;
}

/**
 * Runs the real `mclient join` against a network host under a private HOME,
 * so every later `run` over `configPath` reads the trust the join recorded
 * rather than anything a test wrote.
 */
export async function joinMclient(options: {
  readonly host: string;
  readonly hostPin: string;
  readonly machineId: string;
  readonly root: string;
  /** The one mode this machine joins in (#1837): a tailnet join brings Tailscale up through the `tailscale` on `PATH`. */
  readonly mode: AttachMode;
  /** Environment overrides for the join process, such as a `PATH` holding the `tailscale` a tailnet join finds. */
  readonly env?: Readonly<Record<string, string>>;
}): Promise<JoinedMclient> {
  const binary = await mclientBinary();
  const home = mkdtempSync(join(tmpdir(), "oni-mclient-join-"));
  const child = Bun.spawn([
    binary, "join", options.host, "--mode", options.mode, "--host-pin", options.hostPin, "--name", options.machineId,
    "--export", `workspace=${options.root}`, "--json", "--no-service", "--no-open",
  ], { env: { ...process.env, ...options.env, HOME: home }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    rmSync(home, { recursive: true, force: true });
    throw new Error(`mclient join exited ${exitCode}: ${stderr}`);
  }
  const directory = join(home, ".oni", "machine-client");
  const { receipt } = JSON.parse(stdout) as { readonly receipt: MclientJoinReceipt };
  return {
    directory,
    configPath: join(directory, "client.json"),
    receipt,
    recordedHostPin: () => readFileSync(join(directory, "host-pin"), "utf8"),
    remove: () => rmSync(home, { recursive: true, force: true }),
  };
}

/** One `mclient run --once` over recorded settings, for an attachment the client itself must refuse. */
export async function mclientRunOnce(configPath: string): Promise<{ readonly exitCode: number; readonly refusal: { readonly reason: string } }> {
  const binary = await mclientBinary();
  const child = Bun.spawn([binary, "run", "--allow-unpinned", "--once", "--config", configPath], {
    stdin: "ignore", stdout: "ignore", stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  return { exitCode, refusal: JSON.parse(stderr) as { readonly reason: string } };
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

interface AttachOptions {
  readonly host: { readonly list: () => readonly MachineInfo[]; readonly endpoints: { readonly unix?: string } };
  readonly events: Reports;
  readonly machineId: string;
  readonly root: string;
  readonly exports?: MclientSettings["exports"];
  readonly tags?: readonly string[];
  readonly tmuxSocket?: string;
  readonly computer?: MclientSettings["computer"];
  /** Optional forwarding endpoint; admission still comes from the real host. */
  readonly unix?: string;
  /** Run over the settings and trust a real `mclient join` recorded; nothing is written or removed here. */
  readonly joined?: Pick<JoinedMclient, "configPath">;
}

/** The settings `run` reads: the join's own, or unix settings written for this attachment and removed with it. */
function settingsFor(options: AttachOptions): { readonly configPath: string; remove(): void } {
  if (options.joined !== undefined) return { configPath: options.joined.configPath, remove: () => undefined };
  const configRoot = mkdtempSync(join(tmpdir(), "oni-mclient-test-"));
  const configPath = join(configRoot, "client.json");
  writeMclientSettings(configPath, {
    machineId: options.machineId, name: options.machineId, ...unixCarrier(options),
    exports: options.exports ?? [{ name: "workspace", path: options.root }],
    tags: options.tags ?? [], memoryBudgetMb: 96,
    ...(options.tmuxSocket === undefined ? {} : { tmuxSocket: options.tmuxSocket }),
    ...(options.computer === undefined ? {} : { computer: options.computer }),
  });
  return { configPath, remove: () => rmSync(configRoot, { recursive: true, force: true }) };
}

/** `events` must be the collector wired as the host's sink; admission is read there, never from stdout. */
export async function attachMclient(options: AttachOptions): Promise<AttachedMclient> {
  const binary = await mclientBinary();
  const settings = settingsFor(options);
  const pending = admission({ list: options.host.list, events: options.events, machineId: options.machineId });
  const child = Bun.spawn([binary, "run", "--allow-unpinned", "--config", settings.configPath], {
    stdin: "ignore", stdout: "inherit", stderr: "inherit", detached: true,
  });
  const exited = child.exited.finally(() => signalGroup(child.pid, "SIGKILL"));
  const info = await Promise.race([
    pending.promise,
    exited.then((code) => { throw new Error(`mclient exited before attachment: ${code}`); }),
  ]).catch((error: Error) => {
    signalGroup(child.pid, "SIGKILL");
    settings.remove();
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
        settings.remove();
      }
    },
  };
}
