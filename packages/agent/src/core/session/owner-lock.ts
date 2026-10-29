import { dlopen, FFIType } from "bun:ffi";
import { appendFileSync, closeSync, constants, existsSync, fstatSync, ftruncateSync, mkdirSync, openSync, readFileSync, statSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { Data } from "effect";
import { z } from "zod";

/**
 * One writer per file catalog: an exclusive `flock` on `<catalog>.owner`, held by the descriptor for the holder's lifetime,
 * so the kernel releases it when the holder (and every child that inherited the descriptor) exits — no pid probe, no takeover,
 * no deletion. Under the lock the holder writes `{ owner, pid }` into the file and appends one line to `<catalog>.owners`; the
 * lock's `logStart`/`logEnd` are that line's byte offsets, so `ownersSince(path, from, until)` names exactly the owners between two acquisitions.
 */
export class OwnerLockHeld extends Data.TaggedError("OwnerLockHeld")<{
  readonly path: string;
  readonly holder: string;
  readonly message: string;
}> {}

const Holder = z.object({ owner: z.string(), pid: z.number().int() });

export interface OwnerLock {
  /** The locked descriptor; a process child that inherits it shares the lock (`inheritOwnerLock`). */
  readonly fd: number;
  /** Byte offset of this acquisition's line in `<catalog>.owners` (its size before the append). */
  readonly logStart: number;
  /** The owners-log size after the append: the mark later acquisitions are read from. */
  readonly logEnd: number;
  readonly release: () => void;
}

const { symbols: native } = dlopen(
  process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6",
  { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } },
);
const LOCK_EX_NB = 2 | 4;

const lockPath = (catalogPath: string) => `${catalogPath}.owner`;
const logPath = (catalogPath: string) => `${catalogPath}.owners`;

function holderOf(path: string): string {
  const parsed = Holder.safeParse(JSON.parse(readFileSync(path, "utf8") || "null"));
  return parsed.success ? parsed.data.owner : "unrecorded";
}

function logSize(catalogPath: string): number {
  return existsSync(logPath(catalogPath)) ? statSync(logPath(catalogPath)).size : 0;
}

function closing(fd: number): () => void {
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    closeSync(fd);
  };
}

export function acquireOwnerLock(catalogPath: string, owner: string): OwnerLock {
  const path = lockPath(catalogPath);
  mkdirSync(dirname(catalogPath), { recursive: true });
  const fd = openSync(path, constants.O_RDWR | constants.O_CREAT, 0o600);
  if (native.flock(fd, LOCK_EX_NB) !== 0) {
    closeSync(fd);
    const holder = holderOf(path);
    throw new OwnerLockHeld({ path, holder, message: `catalog owned by ${holder}: ${path}` });
  }
  const release = closing(fd);
  try {
    const holder = JSON.stringify({ owner, pid: process.pid });
    ftruncateSync(fd, 0);
    writeSync(fd, holder, 0);
    const logStart = logSize(catalogPath);
    appendFileSync(logPath(catalogPath), `${holder}\n`, { mode: 0o600 });
    return { fd, logStart, logEnd: logSize(catalogPath), release };
  } catch (cause) {
    release();
    throw cause;
  }
}

/**
 * Adopts the lock a parent passed down as descriptor `fd`: it must be the open `<catalog>.owner`
 * file and must hold the exclusive lock (a descriptor opened independently while the parent holds
 * it cannot). The child appends nothing — its writes belong to the parent's acquisition — and
 * `release` leaves the descriptor to its owner: process exit drops the child's share.
 */
export function inheritOwnerLock(catalogPath: string, fd: number): OwnerLock {
  const path = lockPath(catalogPath);
  const refuse = (): never => {
    throw new OwnerLockHeld({ path, holder: existsSync(path) ? holderOf(path) : "unrecorded", message: `descriptor ${fd} does not hold ${path}` });
  };
  let same = false;
  try {
    const held = fstatSync(fd);
    const named = statSync(path);
    same = held.ino === named.ino && held.dev === named.dev;
  } catch {
    refuse();
  }
  if (!same || native.flock(fd, LOCK_EX_NB) !== 0) refuse();
  const at = logSize(catalogPath);
  return { fd, logStart: at, logEnd: at, release: () => undefined };
}

/** The owners that acquired the lock between byte offsets `from` and `until` (end of log when absent). */
export function ownersSince(catalogPath: string, from: number, until?: number): readonly string[] {
  if (!existsSync(logPath(catalogPath))) return [];
  return readFileSync(logPath(catalogPath)).subarray(from, until).toString("utf8").split("\n")
    .filter((line) => line.length > 0)
    .map((line) => Holder.parse(JSON.parse(line)).owner);
}
