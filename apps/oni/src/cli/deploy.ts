import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { Core } from "@oni/agent";
import { Machine } from "@oni/protocol";
import {
  DEFAULT_GRACE_MS,
  type DeployStep,
  type DrainAnswer,
  type DrainRequest,
  type FailureClass,
  type HostStatus,
  MAX_GRACE_MS,
  type SuperviseAnswer,
  type SuperviseRequest,
} from "./supervise-wire";

/**
 * The drain-restart replacement the supervisor performs (#1699): version
 * check, drain, exit wait, a locked snapshot of the catalog and session
 * files, the candidate on the same port, and its verification. Once the old
 * host has exited every path owns recovery: a failed or unstartable
 * candidate is stopped, the snapshot restored under the owner lock (only when
 * the candidate is the sole owner since the snapshot) and the previous
 * release restarted; a cancelled replacement restores but starts nothing, and
 * a recovery step that throws answers `recovery_failed` (no host is running).
 */
export const EXIT_SLACK_MS = 30_000;

interface DeployStorage {
  readonly catalogPath: string;
  readonly sessionsDir: string;
  readonly snapshotDir: string;
}

export interface DeployPorts {
  readonly storage: DeployStorage;
  readonly installedVersion: (artifact: string, signal: AbortSignal) => Promise<string | undefined>;
  readonly status: (signal: AbortSignal) => Promise<HostStatus | undefined>;
  readonly drain: (request: DrainRequest, signal: AbortSignal) => Promise<DrainAnswer | undefined>;
  readonly childExited: (withinMs: number) => Promise<boolean>;
  readonly current: () => string | undefined;
  readonly point: (release: string | undefined) => void;
  /** Spawns the host from `current` and answers its catalog owner name. */
  readonly startChild: () => string;
  readonly stopChild: () => Promise<void>;
  readonly candidateStatus: (previousInstanceId: string, signal: AbortSignal) => Promise<HostStatus | undefined>;
}

export interface DeployTarget {
  readonly artifact: string;
  readonly targetVersion: string;
  readonly graceMs: number;
}

const DEPLOY_OWNER = `oni-deploy:${process.pid}`;
const CATALOG_SUFFIXES = ["", "-wal", "-shm"];
const STAGED = ".restore";

function refused(failure: FailureClass, step: DeployStep): SuperviseAnswer & { readonly ok: false } {
  return { ok: false, class: failure, step };
}

function locked<T>(storage: DeployStorage, body: (lock: Core.OwnerLock) => T): T | "lock_held" {
  let lock: Core.OwnerLock;
  try {
    lock = Core.acquireOwnerLock(storage.catalogPath, DEPLOY_OWNER);
  } catch (cause) {
    if (cause instanceof Core.OwnerLockHeld) return "lock_held";
    throw cause;
  }
  try {
    return body(lock);
  } finally {
    lock.release();
  }
}

function snapshotStorage(storage: DeployStorage): { readonly mark: number } | "lock_held" | "snapshot_failed" {
  try {
    return locked(storage, (lock) => {
      rmSync(storage.snapshotDir, { recursive: true, force: true });
      mkdirSync(storage.snapshotDir, { recursive: true });
      const catalog = join(storage.snapshotDir, basename(storage.catalogPath));
      for (const suffix of CATALOG_SUFFIXES) {
        if (existsSync(`${storage.catalogPath}${suffix}`)) cpSync(`${storage.catalogPath}${suffix}`, `${catalog}${suffix}`);
      }
      if (existsSync(storage.sessionsDir)) cpSync(storage.sessionsDir, join(storage.snapshotDir, "sessions"), { recursive: true });
      return { mark: lock.logEnd };
    });
  } catch {
    return "snapshot_failed";
  }
}

/** Stages every snapshot file beside its live path first, so a failed copy leaves the live files untouched. */
function swapIn(storage: DeployStorage): void {
  const catalog = join(storage.snapshotDir, basename(storage.catalogPath));
  const sessions = join(storage.snapshotDir, "sessions");
  for (const suffix of CATALOG_SUFFIXES) {
    rmSync(`${storage.catalogPath}${suffix}${STAGED}`, { force: true });
    if (existsSync(`${catalog}${suffix}`)) cpSync(`${catalog}${suffix}`, `${storage.catalogPath}${suffix}${STAGED}`);
  }
  rmSync(`${storage.sessionsDir}${STAGED}`, { recursive: true, force: true });
  if (existsSync(sessions)) cpSync(sessions, `${storage.sessionsDir}${STAGED}`, { recursive: true });
  for (const suffix of CATALOG_SUFFIXES) {
    const live = `${storage.catalogPath}${suffix}`;
    if (existsSync(`${live}${STAGED}`)) renameSync(`${live}${STAGED}`, live);
    else rmSync(live, { force: true });
  }
  rmSync(storage.sessionsDir, { recursive: true, force: true });
  if (existsSync(`${storage.sessionsDir}${STAGED}`)) renameSync(`${storage.sessionsDir}${STAGED}`, storage.sessionsDir);
}

/** Under the restore's own lock: only the candidate may have owned the catalog since the snapshot. */
function restoreStorage(storage: DeployStorage, mark: number, candidate: string | undefined): boolean {
  return locked(storage, (lock) => {
    if (Core.ownersSince(storage.catalogPath, mark, lock.logStart).some((owner) => owner !== candidate)) return false;
    swapIn(storage);
    return true;
  }) === true;
}

function verified(status: HostStatus | undefined, target: DeployTarget, previous: HostStatus): FailureClass | undefined {
  if (status === undefined) return "candidate_failed";
  const fresh = status.instanceId !== previous.instanceId && status.state === "open";
  return fresh && status.version === target.targetVersion && status.contractVersion === Machine.contractVersion
    ? undefined
    : "verify_failed";
}

async function settled<T>(work: () => Promise<T>): Promise<T | undefined> {
  try {
    return await work();
  } catch {
    return undefined;
  }
}

async function drainLive(target: DeployTarget, ports: DeployPorts, signal: AbortSignal): Promise<HostStatus | SuperviseAnswer> {
  const live = await settled(() => ports.status(signal));
  if (signal.aborted) return refused("cancelled", "drain");
  if (live === undefined) return refused("drain_refused", "drain");
  const answer = await settled(() => ports.drain({ expectedInstanceId: live.instanceId, targetVersion: target.targetVersion, graceMs: target.graceMs }, signal));
  if (signal.aborted) return refused("cancelled", "drain");
  if (answer === undefined || !("drained" in answer)) return refused("drain_refused", "drain");
  if (!answer.drained) return refused("drain_timeout", "drain");
  if (await ports.childExited(target.graceMs + EXIT_SLACK_MS)) return live;
  try {
    await ports.stopChild();
    if (signal.aborted) return refused("cancelled", "exit");
    ports.startChild();
  } catch {
    return refused("recovery_failed", "exit");
  }
  return refused("exit_timeout", "exit");
}

interface Rollback {
  readonly previous: string | undefined;
  readonly mark: number;
  readonly candidate: string | undefined;
}

async function rollback(ports: DeployPorts, plan: Rollback, answer: SuperviseAnswer & { readonly ok: false }, signal: AbortSignal): Promise<SuperviseAnswer> {
  let restored = false;
  try {
    await ports.stopChild();
    ports.point(plan.previous);
    restored = restoreStorage(ports.storage, plan.mark, plan.candidate);
  } catch {
    return refused("recovery_failed", "restore");
  }
  if (signal.aborted) return refused("cancelled", answer.step);
  try {
    ports.startChild();
  } catch {
    return refused("recovery_failed", "restore");
  }
  return restored ? answer : refused("restore_refused", "restore");
}

function restartUnchanged(ports: DeployPorts, answer: SuperviseAnswer & { readonly ok: false }): SuperviseAnswer {
  try {
    ports.startChild();
  } catch {
    return refused("recovery_failed", answer.step);
  }
  return answer;
}

async function replace(target: DeployTarget, ports: DeployPorts, live: HostStatus, signal: AbortSignal): Promise<SuperviseAnswer> {
  if (signal.aborted) return refused("cancelled", "snapshot");
  const snapshot = snapshotStorage(ports.storage);
  if (typeof snapshot === "string") return restartUnchanged(ports, refused(snapshot, "snapshot"));
  if (signal.aborted) return refused("cancelled", "snapshot");
  let previous: string | undefined;
  try {
    previous = ports.current();
  } catch {
    return restartUnchanged(ports, refused("io_failed", "snapshot"));
  }
  if (signal.aborted) return refused("cancelled", "snapshot");
  let candidate: string | undefined;
  try {
    ports.point(target.artifact);
    candidate = ports.startChild();
  } catch {
    return rollback(ports, { previous, mark: snapshot.mark, candidate }, refused("io_failed", "start"), signal);
  }
  const status = await settled(() => ports.candidateStatus(live.instanceId, signal));
  const plan = { previous, mark: snapshot.mark, candidate };
  if (signal.aborted) return rollback(ports, plan, refused("cancelled", "verify"), signal);
  const failure = verified(status, target, live);
  if (failure === undefined && status !== undefined) return { ok: true, instanceId: status.instanceId };
  return rollback(ports, plan, refused(failure ?? "verify_failed", failure === "candidate_failed" ? "start" : "verify"), signal);
}

export async function runDeploy(target: DeployTarget, ports: DeployPorts, signal: AbortSignal = new AbortController().signal): Promise<SuperviseAnswer> {
  const installed = await settled(() => ports.installedVersion(target.artifact, signal));
  if (signal.aborted) return refused("cancelled", "version");
  if (installed !== target.targetVersion) return refused("version_mismatch", "version");
  const live = await drainLive(target, ports, signal);
  if ("ok" in live) return live;
  return replace(target, ports, live, signal);
}

export interface DeployClient {
  readonly supervisorReachable: () => boolean;
  readonly stage: (tgz: string) => Promise<{ readonly artifact: string; readonly version: string | undefined }>;
  readonly token: () => string | undefined;
  readonly send: (request: SuperviseRequest) => Promise<SuperviseAnswer>;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}

const DEPLOY_USAGE = "usage: oni deploy <artifact.tgz> [--grace-ms <0..300000>] | oni deploy --reload";

function parseDeployArgs(args: readonly string[]): { readonly reload: true } | { readonly tgz: string; readonly graceMs: number } | undefined {
  if (args.length === 1 && args[0] === "--reload") return { reload: true };
  const [tgz, flag, value] = args;
  if (tgz === undefined || tgz.startsWith("--")) return undefined;
  if (args.length === 1) return { tgz, graceMs: DEFAULT_GRACE_MS };
  const graceMs = Number(value);
  const valid = args.length === 3 && flag === "--grace-ms" && Number.isInteger(graceMs) && graceMs >= 0 && graceMs <= MAX_GRACE_MS;
  return valid ? { tgz, graceMs } : undefined;
}

async function deployRequest(parsed: { readonly tgz: string; readonly graceMs: number }, client: DeployClient): Promise<SuperviseRequest | SuperviseAnswer> {
  const token = client.token();
  if (token === undefined) return refused("unauthenticated", "request");
  const staged = await client.stage(parsed.tgz);
  if (staged.version === undefined) return refused("no_staged_artifact", "version");
  return { op: "deploy", artifact: staged.artifact, targetVersion: staged.version, graceMs: parsed.graceMs, token };
}

export async function deployCommand(args: readonly string[], client: DeployClient): Promise<number> {
  const parsed = parseDeployArgs(args);
  if (parsed === undefined) {
    client.stderr(DEPLOY_USAGE);
    return 1;
  }
  const request = !client.supervisorReachable()
    ? refused("supervisor_unavailable", "request")
    : "reload" in parsed ? { op: "reload" as const } : await deployRequest(parsed, client);
  const answer = "op" in request ? await client.send(request) : request;
  (answer.ok ? client.stdout : client.stderr)(JSON.stringify(answer));
  return answer.ok ? 0 : 1;
}
