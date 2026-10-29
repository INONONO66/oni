/**
 * Client conformance (#1626 D7): the prebuilt `mclient` debug binary against
 * the TypeScript machine host over a temporary Unix socket.
 *
 * The host runs with in-memory enrollment and generation stores. `mclient
 * join --unix` writes the client configuration under a temporary HOME and
 * prints the enrollment receipt the host admits; `mclient run --config`
 * attaches with one temporary export root. The run proves, in order:
 * machine_list (`peer.kind` client, generation 1), fs_op read/write/list/stat
 * plus the exclusive-create refusal, fs_stream write/read with digests,
 * exec echo and deadline, the PTY lifecycle (or the explicit
 * `pty_not_available` refusal when tmux is absent), a killed client
 * reconnecting with generation 1 and being re-admitted, a client presenting
 * a generation the host never minted being refused `stale_generation`, and a
 * fresh attach whose PATH holds no tmux being refused `pty_not_available`,
 * then the computer-use phase of `conformance/computer` (#1662) over the
 * same host. Waits are exact bus events or process exits under a bounded
 * timeout. Nothing is built here: the binary must already exist.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Effect, Result } from "effect";
import { type BusEvent, Machine } from "../packages/protocol/src/index.js";
import {
  createMachineHost,
  createMemoryGenerationStore,
  MachineRefusalError,
  type MachineHandle,
  type MachineHost,
  type MachineInfo,
} from "../packages/machines/src/index.js";
import { acquire, run } from "../packages/machines/test/ipc/helpers/effects.js";
import { agentConformance } from "./conformance/agent/sessions.js";
import {
  captureInput,
  type ComputerHarness,
  exerciseComputer,
  type InputRecorder,
  inputRecorder,
} from "./conformance/computer/index.js";

export const MCLIENT = resolve(import.meta.dir, "../clients/target/debug/mclient");
const MACHINE = "conformance";
const EXPORT = "work";
const PTY_NAME = "conformance";
const PTY_MARKER = "pty-conformance-ok";
const STEP_TIMEOUT_MS = 60_000;
const PTY_READ_ATTEMPTS = 10;
const STALE_EXIT_CODE = 3;

export type ClientProcess = Bun.Subprocess<"ignore", "pipe", "pipe">;

export interface Fixture {
  readonly binary: string;
  readonly home: string;
  readonly root: string;
  readonly socket: string;
  readonly config: string;
  readonly env: Record<string, string | undefined>;
}

const receipts: string[] = [];
const spawned = new Set<ClientProcess>();

export function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`conformance failed: ${message}`);
}

export function record(line: string): void {
  receipts.push(line);
  console.log(`ok ${receipts.length} - ${line}`);
}

export function within<A>(promise: Promise<A>, label: string): Promise<A> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`conformance failed: timed out waiting for ${label}`)),
      STEP_TIMEOUT_MS,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function eventLog() {
  const counts = new Map<string, number>();
  const waiters: Array<{
    readonly name: string;
    readonly target: number;
    readonly resolve: () => void;
  }> = [];
  const sink: BusEvent.Sink = {
    publish(event) {
      const count = (counts.get(event.name) ?? 0) + 1;
      counts.set(event.name, count);
      for (const waiter of waiters.filter(
        (entry) => entry.name === event.name && entry.target <= count,
      )) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    },
  };
  function next(event: { readonly name: string }): Promise<void> {
    const target = (counts.get(event.name) ?? 0) + 1;
    return new Promise((resolve) => waiters.push({ name: event.name, target, resolve }));
  }
  return { sink, next };
}

/**
 * `/tmp`, not `os.tmpdir()`: the client binds `~/.oni/machine-client/hook.sock`
 * and tmux its socket under the fixture, and the macOS per-user temporary
 * directory pushes those paths past the 104-byte `sun_path` limit.
 */
const FIXTURE_ROOT = "/tmp";

function fixture(binary: string): Fixture {
  const base = realpathSync(mkdtempSync(join(FIXTURE_ROOT, "oni-conf-")));
  const home = join(base, "home");
  const root = join(base, "export");
  mkdirSync(home);
  mkdirSync(root);
  return {
    binary,
    home,
    root,
    socket: join(base, "host.sock"),
    config: join(home, ".oni", "machine-client", "client.json"),
    env: { ...process.env, HOME: home },
  };
}

export async function finished(
  child: ClientProcess,
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

export async function enroll(setup: Fixture): Promise<Machine.Enrollment> {
  const joined = await within(
    finished(
      Bun.spawn(
        [
          setup.binary,
          "join",
          "--no-service",
          "--unix",
          setup.socket,
          "--name",
          MACHINE,
          "--export",
          `${EXPORT}=${setup.root}`,
          "local",
        ],
        { env: setup.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
      ),
    ),
    "mclient join",
  );
  check(joined.code === 0, `mclient join exited ${joined.code}: ${joined.stderr}`);
  const receiptLine = joined.stdout.split("\n")[0];
  check(receiptLine !== undefined, "mclient join omitted the enrollment receipt");
  const receipt = Machine.Enrollment.omit({ enrolledAt: true }).parse(JSON.parse(receiptLine));
  record(
    `join wrote ${setup.config} and receipt for ${receipt.machineId} [${receipt.allowedCapabilities.join(", ")}]`,
  );
  return { ...receipt, enrolledAt: Date.now() };
}

export function start(setup: Fixture): ClientProcess {
  const client: ClientProcess = Bun.spawn([setup.binary, "run", "--allow-unpinned", "--config", setup.config], {
    env: setup.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  spawned.add(client);
  return client;
}

export async function attach(setup: Fixture, attached: Promise<void>): Promise<ClientProcess> {
  const client = start(setup);
  const early = client.exited.then(async (code) => {
    throw new Error(
      `conformance failed: mclient run exited ${code} before attaching: ${await new Response(client.stderr).text()}`,
    );
  });
  await within(Promise.race([attached, early]), "client attach");
  return client;
}

export async function stop(client: ClientProcess, detached: Promise<void>): Promise<void> {
  client.kill("SIGKILL");
  await within(Promise.all([client.exited, detached]), "client detach");
}

function attachedInfo(host: MachineHost, label: string): MachineInfo {
  const listed = host.list();
  check(listed.length === 1, `${label}: machine_list holds ${listed.length} machines, expected 1`);
  const [info] = listed;
  check(info?.machineId === MACHINE, `${label}: listed machine is ${info?.machineId}`);
  check(info.peer.kind === "client", `${label}: peer.kind is ${info.peer.kind}`);
  check(
    info.peer.contractVersion === Machine.contractVersion,
    `${label}: contract ${info.peer.contractVersion}`,
  );
  check(info.generation === 1, `${label}: generation is ${info.generation}`);
  record(
    `${label}: machine_list ${info.machineId} peer.kind=client contract=${info.peer.contractVersion} generation=1`,
  );
  return info;
}

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export async function refusal(
  effect: Effect.Effect<object, MachineRefusalError | Error>,
): Promise<string> {
  const result = await run(Effect.result(effect));
  check(Result.isFailure(result), "expected a refusal, got a value");
  check(
    result.failure instanceof MachineRefusalError,
    `expected a typed refusal, got ${String(result.failure)}`,
  );
  return result.failure.reason;
}

async function exerciseFsOp(machine: MachineHandle, root: string): Promise<void> {
  const path = join(root, "note.txt");
  const data = new TextEncoder().encode("conformance\n");
  const written = await run(machine.fs.write(path, data));
  check(written.bytesWritten === data.length, `fs_op write reported ${written.bytesWritten} bytes`);
  const read = await run(machine.fs.read(path));
  check(
    Buffer.from(read.data).equals(data) && read.size === data.length,
    "fs_op read returned different bytes",
  );
  const listed = await run(machine.fs.list(root));
  check(
    listed.entries.some((entry) => entry.name === "note.txt"),
    "fs_op list misses note.txt",
  );
  const stat = await run(machine.fs.stat(path));
  check(
    stat.kind === "file" && stat.size === data.length,
    `fs_op stat reported ${stat.kind}/${stat.size}`,
  );
  const exclusive = await refusal(machine.fs.write(path, data, { create: "exclusive" }));
  check(exclusive === "already_exists", `fs_op exclusive write refused ${exclusive}`);
  record("fs_op write/read/list/stat round-trip and exclusive create refused already_exists");
}

async function exerciseFsStream(machine: MachineHandle, root: string): Promise<void> {
  const path = join(root, "bulk.bin");
  const data = randomBytes(Machine.FS_WRITE_MAX_BYTES * 2 + 4_321);
  const written = await run(machine.fs.write(path, data));
  check(
    written.bytesWritten === data.length,
    `fs_stream write reported ${written.bytesWritten} bytes`,
  );
  check(
    sha256(readFileSync(path)) === sha256(data),
    "fs_stream write landed different bytes on disk",
  );
  const read = await run(machine.fs.read(path, { limit: data.length }));
  check(
    read.bytesRead === data.length && !read.truncated,
    `fs_stream read ${read.bytesRead} bytes, truncated=${read.truncated}`,
  );
  check(sha256(read.data) === sha256(data), "fs_stream read digest differs");
  record(
    `fs_stream write/read ${data.length} bytes across chunks, digest ${sha256(data).slice(0, 16)}`,
  );
}

async function exerciseExec(machine: MachineHandle, root: string): Promise<void> {
  const echo = await run(machine.exec("echo conformance", root));
  check(echo.status === "completed", `exec echo answered ${echo.status}`);
  check(
    echo.exitCode === 0 && Buffer.from(echo.stdout).toString() === "conformance\n",
    "exec echo output differs",
  );
  const startedAt = Date.now();
  const slow = await run(machine.exec(`sleep ${Machine.EXEC_TIMEOUT_MS / 1000 + 30}`, root));
  check(slow.status === "timed_out", `exec past the deadline answered ${slow.status}`);
  record(
    `exec echo exit 0; exec past the ${Machine.EXEC_TIMEOUT_MS} ms deadline timed_out after ${Date.now() - startedAt} ms`,
  );
}

async function readUntil(machine: MachineHandle, cursor: string, marker: string): Promise<string> {
  let seen = "";
  let position = cursor;
  for (let attempt = 0; attempt < PTY_READ_ATTEMPTS && !seen.includes(marker); attempt += 1) {
    const view = await run(machine.pty.read(PTY_NAME, { cursor: position, waitMs: 2_000 }));
    check(view.status === "ok", `pty read answered ${view.status}`);
    seen += Buffer.from(view.data).toString();
    position = view.cursor;
  }
  return seen;
}

async function exercisePty(machine: MachineHandle, root: string, tmux: boolean): Promise<void> {
  const opened = await run(machine.pty.open(PTY_NAME, root));
  if (!tmux) return refusedWithoutTmux(opened);
  check(
    opened.status === "ok",
    `pty open answered ${opened.status === "refused" ? opened.reason : opened.status}`,
  );
  const wrote = await run(
    machine.pty.write(PTY_NAME, new TextEncoder().encode(`echo ${PTY_MARKER}\r`)),
  );
  check(wrote.status === "ok", "pty write refused");
  check(
    (await readUntil(machine, opened.cursor, PTY_MARKER)).includes(PTY_MARKER),
    "pty read never showed the echoed marker",
  );
  const resized = await run(machine.pty.resize(PTY_NAME, 100, 30));
  check(resized.status === "ok", "pty resize refused");
  const live = await run(machine.pty.list());
  check(
    live.status === "ok" &&
      live.sessions.some((entry) => entry.name === PTY_NAME && entry.status === "live"),
    "pty list misses the live session",
  );
  const closed = await run(machine.pty.close(PTY_NAME));
  check(closed.status === "ok", "pty close refused");
  const after = await run(machine.pty.list());
  check(
    after.status === "ok" && after.sessions.every((entry) => entry.name !== PTY_NAME),
    "pty list still holds the closed session",
  );
  record("pty open/write/read/resize/list/close over tmux");
}

function refusedWithoutTmux(opened: { readonly status: string; readonly reason?: string }): void {
  check(
    opened.status === "refused" && opened.reason === "pty_not_available",
    `pty open without tmux answered ${opened.status}/${opened.reason}`,
  );
  record("tmux absent: pty open refused pty_not_available");
}

async function exercise(host: MachineHost, info: MachineInfo, setup: Fixture): Promise<void> {
  const machine = host.get(MACHINE);
  await exerciseFsOp(machine, setup.root);
  await exerciseFsStream(machine, setup.root);
  await exerciseExec(machine, setup.root);
  const tmux = Bun.which("tmux", { PATH: setup.env.PATH ?? "" }) !== null;
  check(
    info.capabilities.includes("pty.session") === tmux,
    `pty.session offered=${!tmux} while tmux present=${tmux}`,
  );
  await exercisePty(machine, setup.root, tmux);
}

async function reconnect(
  host: MachineHost,
  setup: Fixture,
  events: ReturnType<typeof eventLog>,
  first: ClientProcess,
): Promise<ClientProcess> {
  await stop(first, events.next(Machine.Events.Detached));
  check(host.list().length === 0, "machine_list still holds the killed client");
  const client = await attach(setup, events.next(Machine.Events.Attached));
  attachedInfo(host, "restart presenting generation 1 re-admitted");
  const read = await run(host.get(MACHINE).fs.read(join(setup.root, "note.txt")));
  check(
    Buffer.from(read.data).toString() === "conformance\n",
    "fs_op read after reconnect differs",
  );
  record("fs_op read routes to the re-admitted connection");
  return client;
}

async function staleGeneration(
  host: MachineHost,
  setup: Fixture,
  events: ReturnType<typeof eventLog>,
  client: ClientProcess,
): Promise<void> {
  await stop(client, events.next(Machine.Events.Detached));
  writeFileSync(
    join(setup.home, ".oni", "machine-client", "state.json"),
    JSON.stringify({ generation: 2 }),
  );
  const refused = await within(finished(start(setup)), "stale generation refusal");
  check(refused.code === STALE_EXIT_CODE, `stale client exited ${refused.code}: ${refused.stderr}`);
  check(
    refused.stderr.includes(JSON.stringify({ reason: "stale_generation" })),
    `stale client stderr: ${refused.stderr}`,
  );
  check(host.list().length === 0, "machine_list admitted the stale generation");
  record(
    `synthetic generation 2 (host minted 1) refused stale_generation, client exit ${STALE_EXIT_CODE}`,
  );
}

function pathWithoutTmux(path: string): string {
  return path
    .split(":")
    .filter((entry) => Bun.which("tmux", { PATH: entry }) === null)
    .join(":");
}

async function withoutTmux(
  host: MachineHost,
  setup: Fixture,
  events: ReturnType<typeof eventLog>,
): Promise<ClientProcess> {
  rmSync(join(setup.home, ".oni", "machine-client", "state.json"), { force: true });
  const client = await attach(
    { ...setup, env: { ...setup.env, PATH: pathWithoutTmux(setup.env.PATH ?? "") } },
    events.next(Machine.Events.Attached),
  );
  const [info] = host.list();
  check(
    info?.generation === 2 && !info.capabilities.includes("pty.session"),
    `tmux-less attach: generation ${info?.generation}, capabilities ${info?.capabilities.join(",")}`,
  );
  refusedWithoutTmux(await run(host.get(MACHINE).pty.open(PTY_NAME, setup.root)));
  return client;
}

async function computerUse(
  host: MachineHost,
  setup: Fixture,
  events: ReturnType<typeof eventLog>,
  grant: (allowed: boolean) => void,
  recorder: InputRecorder,
  previous: ClientProcess,
): Promise<void> {
  await stop(previous, events.next(Machine.Events.Detached));
  let current: ClientProcess | undefined;
  const harness: ComputerHarness = {
    record,
    within,
    attach: async () => {
      // The client applies its grant before its first beat, so the first
      // machine.reported after attached marks it ready for computer calls.
      const reported = events.next(Machine.Events.Reported);
      current = await attach(setup, events.next(Machine.Events.Attached));
      await within(reported, "first machine.report after attach");
    },
    stop: async () => {
      check(current !== undefined, "no computer-use client is running");
      await stop(current, events.next(Machine.Events.Detached));
      current = undefined;
    },
    grant,
  };
  const directory = dirname(setup.config);
  await exerciseComputer(
    harness,
    host,
    MACHINE,
    {
      directory,
      config: setup.config,
      hostSocket: setup.socket,
      tapSocket: join(dirname(setup.socket), "tap.sock"),
      recorder: join(directory, "input.jsonl"),
    },
    recorder,
  );
}

const NO_TOOL_PORT = new MachineRefusalError({
  reason: "host_tool_missing",
  message: "conformance host has no tool port",
});

async function conformance(setup: Fixture): Promise<void> {
  const enrollment = await enroll(setup);
  let granted = enrollment;
  const grant = (allowed: boolean): void => {
    const others = enrollment.allowedCapabilities.filter(
      (capability) => capability !== Machine.WellKnownCapability.computerUse,
    );
    granted = { ...enrollment, allowedCapabilities: allowed ? enrollment.allowedCapabilities : others };
  };
  const recorder = inputRecorder();
  const events = eventLog();
  const acquired = await acquire(
    createMachineHost({
      listen: { unix: setup.socket },
      id: () => `conformance-${crypto.randomUUID()}`,
      dispatcherBound: 64,
      enrollment: (id) => (id === granted.machineId ? granted : undefined),
      generations: createMemoryGenerationStore(),
      events: events.sink,
      now: Date.now,
      callTool: () => Effect.fail(NO_TOOL_PORT),
      captureInput: captureInput(recorder),
    }),
  );
  const host = acquired.value;
  try {
    const firstReported = events.next(Machine.Events.Reported);
    const first = await attach(setup, events.next(Machine.Events.Attached));
    await within(firstReported, "first client report");
    if (process.platform === "linux") {
      const permission = host.list().find((entry) => entry.machineId === MACHINE)?.live?.screen?.permission;
      check(permission === "unsupported", `Linux client screen permission is ${permission}`);
      record("Linux mclient run reports unsupported screen permission over the unix host");
    }
    await exercise(host, attachedInfo(host, "first attach"), setup);
    const second = await reconnect(host, setup, events, first);
    await staleGeneration(host, setup, events, second);
    const tmuxless = await withoutTmux(host, setup, events);
    await computerUse(host, setup, events, grant, recorder, tmuxless);
  } finally {
    await acquired.close();
  }
}

/**
 * One conformance stage over a fresh fixture: refuses a missing binary,
 * reports every receipt, and kills every spawned client and removes the
 * fixture whatever the outcome. `label` names the stage in the summary.
 */
export async function runStage(
  binary: string,
  label: string,
  body: (setup: Fixture) => Promise<void>,
): Promise<number> {
  const setup = fixture(binary);
  receipts.length = 0;
  try {
    check(
      existsSync(binary),
      `missing ${binary}: build it first (cd clients && cargo build -p oni-machine-client --locked)`,
    );
    await body(setup);
    console.log(`${label}: ${receipts.length} checks passed`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    for (const client of spawned) client.kill("SIGKILL");
    spawned.clear();
    rmSync(resolve(setup.home, ".."), { recursive: true, force: true });
  }
}

/** The P3 transport stage, then the P4 agent-session stage on its own fixture and host. */
export async function runConformance(binary = MCLIENT): Promise<number> {
  const transport = await runStage(binary, "clients conformance", conformance);
  if (transport !== 0) return transport;
  const sessions = agentConformance({ check, record, within, enroll, eventLog, attach, stop, refusal });
  return runStage(binary, "agent session conformance", sessions);
}

if (import.meta.main) process.exit(await runConformance());
