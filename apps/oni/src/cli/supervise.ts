import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Subprocess } from "bun";
import type { z } from "zod";
import { type OniConfig, resolveClusterStorage } from "../config";
import { type DeployClient, type DeployPorts, EXIT_SLACK_MS, runDeploy } from "./deploy";
import {
  DEFAULT_GRACE_MS,
  DrainAnswer,
  HostStatus,
  type SuperviseAnswer,
  SuperviseAnswer as SuperviseAnswerSchema,
  SuperviseRequest,
} from "./supervise-wire";

/**
 * `oni supervise` (#1699): the process the service unit runs. It owns the
 * `current` release link, spawns the host child from it, forwards SIGTERM,
 * and answers one JSON line per connection on `supervise.sock` (0600, its
 * token in `supervise.token`); the host child never replaces itself.
 */
interface SupervisorPaths {
  readonly sockPath: string;
  readonly tokenPath: string;
  readonly currentLink: string;
  readonly releasesDir: string;
  readonly snapshotDir: string;
}

function supervisorPaths(home: string): SupervisorPaths {
  const root = join(home, ".oni");
  return {
    sockPath: join(root, "supervise.sock"),
    tokenPath: join(root, "supervise.token"),
    currentLink: join(root, "current"),
    releasesDir: join(root, "releases"),
    snapshotDir: join(root, "deploy-snapshot"),
  };
}

const CANDIDATE_DEADLINE_MS = 60_000;
const STATUS_POLL_MS = 250;
const STATUS_TIMEOUT_MS = 10_000;
const VERSION_PROBE_MS = 30_000;
const RELEASE_ENTRY = join("dist", "app", "main.js");

function sameToken(given: string, expected: string): boolean {
  const left = Buffer.from(given);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function parseLine(line: string): SuperviseRequest | undefined {
  try {
    const parsed = SuperviseRequest.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export interface SupervisorServer {
  readonly stop: () => void;
}

export function serveSupervisor(options: {
  readonly sockPath: string;
  readonly token: string;
  readonly handle: (request: SuperviseRequest) => Promise<SuperviseAnswer>;
}): SupervisorServer {
  let busy = false;
  async function answer(line: string): Promise<SuperviseAnswer> {
    const request = parseLine(line);
    if (request === undefined) return { ok: false, class: "invalid_request", step: "request" };
    if (request.op === "deploy" && !sameToken(request.token, options.token)) return { ok: false, class: "unauthenticated", step: "request" };
    if (busy) return { ok: false, class: "deploy_in_progress", step: "request" };
    busy = true;
    try {
      return await options.handle(request);
    } catch {
      return { ok: false, class: "recovery_failed", step: "request" };
    } finally {
      busy = false;
    }
  }
  rmSync(options.sockPath, { force: true });
  const buffers = new WeakMap<object, string>();
  const listener = Bun.listen({
    unix: options.sockPath,
    socket: {
      data(socket, data) {
        const text = (buffers.get(socket) ?? "") + data.toString("utf8");
        const end = text.indexOf("\n");
        buffers.set(socket, end < 0 ? text : "");
        if (end < 0) return;
        void answer(text.slice(0, end)).then((reply) => {
          socket.end(`${JSON.stringify(reply)}\n`);
        });
      },
    },
  });
  chmodSync(options.sockPath, 0o600);
  // Open connections keep their pending answer: a request still in flight at shutdown is answered, never dropped.
  return { stop: () => listener.stop(false) };
}

export function requestSupervisor(sockPath: string, request: SuperviseRequest): Promise<SuperviseAnswer> {
  const unavailable: SuperviseAnswer = { ok: false, class: "supervisor_unavailable", step: "request" };
  const { promise, resolve } = Promise.withResolvers<SuperviseAnswer>();
  let received = "";
  Bun.connect({
    unix: sockPath,
    socket: {
      open(socket) {
        socket.write(`${JSON.stringify(request)}\n`);
      },
      data(_socket, data) {
        received += data.toString("utf8");
      },
      close() {
        try {
          const answer = SuperviseAnswerSchema.safeParse(JSON.parse(received));
          resolve(answer.success ? answer.data : unavailable);
        } catch {
          resolve(unavailable);
        }
      },
      connectError() {
        resolve(unavailable);
      },
    },
  }).catch(() => resolve(unavailable));
  return promise;
}

/** Runs `<release> --version`, killed once `signal` aborts or VERSION_PROBE_MS passes. */
export async function releaseVersion(bunPath: string, release: string, signal?: AbortSignal): Promise<string | undefined> {
  const child = Bun.spawn([bunPath, join(release, RELEASE_ENTRY), "--version"], {
    stdout: "pipe", stderr: "ignore", stdin: "ignore", timeout: VERSION_PROBE_MS, ...(signal === undefined ? {} : { signal }),
  });
  const [code, out] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  return code === 0 ? out.trim() : undefined;
}

export interface SupervisorProcess {
  readonly home: string;
  readonly bunPath: string;
  /** The CLI entry the supervisor itself runs: the host entry while no release is linked. */
  readonly selfEntry: string;
  readonly config: Pick<OniConfig, "host" | "wsPort" | "wsToken" | "catalogPath" | "sessionsDir" | "entityIdleMs">;
}

/** The loopback-reachable control URL of the host bound at `host`: wildcards map to their loopback, IPv6 literals are bracketed. */
export function hostEndpoint(host: string, port: number): string {
  const reachable = host === "0.0.0.0" || host === "" ? "127.0.0.1" : host === "::" ? "::1" : host;
  return `http://${reachable.includes(":") ? `[${reachable}]` : reachable}:${port}`;
}

/** The host's `/status` and `/drain` reads; `signal` bounds the headers and the body alike. */
export function hostClient(base: string, token: string | undefined) {
  const headers = { authorization: `Bearer ${token ?? ""}`, "content-type": "application/json" };
  async function read<T>(path: string, init: RequestInit, schema: z.ZodType<T>, signal: AbortSignal): Promise<T | undefined> {
    try {
      const response = await fetch(`${base}${path}`, { ...init, headers, signal });
      const parsed = schema.safeParse(await response.json());
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }
  return {
    status: (signal: AbortSignal) => read("/status", {}, HostStatus, signal),
    drain: (body: object, signal: AbortSignal) => read("/drain", { method: "POST", body: JSON.stringify(body) }, DrainAnswer, signal),
  };
}

function linkedRelease(link: string): string | undefined {
  return existsSync(link) && lstatSync(link).isSymbolicLink() ? readlinkSync(link) : undefined;
}

function pointRelease(link: string, release: string | undefined): void {
  if (release === undefined) {
    rmSync(link, { force: true });
    return;
  }
  const staged = `${link}.next`;
  rmSync(staged, { force: true });
  symlinkSync(release, staged);
  renameSync(staged, link);
}

function newestRelease(releasesDir: string): string | undefined {
  if (!existsSync(releasesDir)) return undefined;
  return readdirSync(releasesDir)
    .map((name) => join(releasesDir, name))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0];
}

function withinMs(promise: Promise<number>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  return Promise.race([promise.then(() => true), expired]).finally(() => clearTimeout(timer));
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

export interface Supervisor {
  /** Settles with the exit code the service manager should see. */
  readonly done: Promise<number>;
  /** Stops accepting requests, cancels and joins an active replacement, then stops its last child. */
  readonly stop: () => void;
}

export function startSupervisor(process_: SupervisorProcess): Supervisor {
  const paths = supervisorPaths(process_.home);
  const host = hostClient(hostEndpoint(process_.config.host, process_.config.wsPort), process_.config.wsToken);
  const done = Promise.withResolvers<number>();
  const cancel = new AbortController();
  let child: Subprocess<"ignore", "inherit", "inherit"> | undefined;
  let childExit: number | undefined;
  let replacement: Promise<SuperviseAnswer> | undefined;
  function spawnHost(): string {
    const release = linkedRelease(paths.currentLink);
    const spawned = Bun.spawn([process_.bunPath, release === undefined ? process_.selfEntry : join(release, RELEASE_ENTRY), "start"], {
      stdio: ["ignore", "inherit", "inherit"],
    });
    child = spawned;
    childExit = undefined;
    void spawned.exited.then((code) => {
      if (child !== spawned) return;
      childExit = code;
      if (replacement === undefined && !cancel.signal.aborted) done.resolve(code);
    });
    return `oni:${spawned.pid}`;
  }
  async function stopChild(): Promise<void> {
    const running = child;
    if (running === undefined) return;
    running.kill("SIGTERM");
    if (!(await withinMs(running.exited, EXIT_SLACK_MS))) running.kill("SIGKILL");
    await running.exited;
  }
  async function candidateStatus(previousInstanceId: string, signal: AbortSignal) {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(CANDIDATE_DEADLINE_MS)]);
    while (!deadline.aborted && childExit === undefined) {
      const status = await host.status(deadline);
      if (status !== undefined && status.instanceId !== previousInstanceId) return status;
      await pause(STATUS_POLL_MS, deadline);
    }
    return undefined;
  }
  const ports: DeployPorts = {
    storage: { ...resolveClusterStorage(process_.config, process_.home), snapshotDir: paths.snapshotDir },
    installedVersion: (artifact, signal) => releaseVersion(process_.bunPath, artifact, signal),
    status: (signal) => host.status(AbortSignal.any([signal, AbortSignal.timeout(STATUS_TIMEOUT_MS)])),
    drain: (request, signal) => host.drain(request, AbortSignal.any([signal, AbortSignal.timeout(request.graceMs + EXIT_SLACK_MS)])),
    childExited: (ms) => (child === undefined ? Promise.resolve(true) : withinMs(child.exited, ms)),
    current: () => linkedRelease(paths.currentLink),
    point: (release) => pointRelease(paths.currentLink, release),
    startChild: spawnHost,
    stopChild,
    candidateStatus,
  };
  function reconcile(answer: SuperviseAnswer): void {
    if (cancel.signal.aborted) return;
    if (!answer.ok && answer.class === "recovery_failed") done.resolve(1);
    else if (childExit !== undefined) done.resolve(childExit);
  }
  async function handle(request: SuperviseRequest): Promise<SuperviseAnswer> {
    if (cancel.signal.aborted) return { ok: false, class: "supervisor_unavailable", step: "request" };
    const artifact = request.op === "deploy" ? request.artifact : newestRelease(paths.releasesDir);
    if (artifact === undefined) return { ok: false, class: "no_staged_artifact", step: "request" };
    const targetVersion = request.op === "deploy" ? request.targetVersion : await releaseVersion(process_.bunPath, artifact, cancel.signal);
    if (targetVersion === undefined) return { ok: false, class: "no_staged_artifact", step: "version" };
    const graceMs = request.op === "deploy" ? request.graceMs : DEFAULT_GRACE_MS;
    const running = runDeploy({ artifact, targetVersion, graceMs }, ports, cancel.signal)
      .catch((): SuperviseAnswer => ({ ok: false, class: "recovery_failed", step: "request" }));
    replacement = running;
    const answer = await running;
    replacement = undefined;
    reconcile(answer);
    return answer;
  }
  const token = randomBytes(32).toString("hex");
  mkdirSync(paths.releasesDir, { recursive: true });
  writeFileSync(paths.tokenPath, token, { mode: 0o600 });
  const server = serveSupervisor({ sockPath: paths.sockPath, token, handle });
  spawnHost();
  const stop = (): void => {
    if (cancel.signal.aborted) return;
    cancel.abort();
    server.stop();
    void (replacement ?? Promise.resolve())
      .then(stopChild)
      .then(() => done.resolve(0), () => done.resolve(1));
  };
  return {
    done: done.promise.finally(() => {
      server.stop();
      rmSync(paths.sockPath, { force: true });
    }),
    stop,
  };
}

export function supervise(process_: SupervisorProcess): Promise<number> {
  const supervisor = startSupervisor(process_);
  process.once("SIGTERM", supervisor.stop);
  process.once("SIGINT", supervisor.stop);
  return supervisor.done;
}

async function stageArtifact(bunPath: string, releasesDir: string, tgz: string) {
  const artifact = join(releasesDir, `${basename(tgz).replace(/\.tgz$/, "")}-${Date.now()}`);
  mkdirSync(artifact, { recursive: true });
  const unpack = await Bun.spawn(["tar", "-xzf", tgz, "-C", artifact, "--strip-components=1"], { stdio: ["ignore", "inherit", "inherit"] }).exited;
  const install = unpack === 0 ? await Bun.spawn([bunPath, "install", "--production"], { cwd: artifact, stdio: ["ignore", "inherit", "inherit"] }).exited : 1;
  return { artifact, version: install === 0 ? await releaseVersion(bunPath, artifact) : undefined };
}

export function deployClient(home: string, bunPath: string, io: Pick<DeployClient, "stdout" | "stderr">): DeployClient {
  const paths = supervisorPaths(home);
  return {
    ...io,
    supervisorReachable: () => existsSync(paths.sockPath),
    stage: (tgz) => stageArtifact(bunPath, paths.releasesDir, tgz),
    token: () => (existsSync(paths.tokenPath) ? readFileSync(paths.tokenPath, "utf8").trim() : undefined),
    send: (request) => requestSupervisor(paths.sockPath, request),
  };
}
