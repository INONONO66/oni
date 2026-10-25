import { dlopen, FFIType } from "bun:ffi";
import { closeSync, constants, fchmodSync, fstatSync, openSync } from "node:fs";
import { chmod, lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { TelegramOwnerErrorCode } from "./owner-sdk.js";

const { symbols: native } = dlopen(
  process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6",
  { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } },
);
const LOCK_EX_NB = 2 | 4;

class TelegramSessionError extends Error {
  constructor(readonly code: Extract<TelegramOwnerErrorCode, "session_in_use" | "session_lost">) {
    super(code);
    this.name = "TelegramSessionError";
  }
}

function refused(code: "session_in_use" | "session_lost"): TelegramSessionError {
  return new TelegramSessionError(code);
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink() || (process.getuid !== undefined && entry.uid !== process.getuid()))
    throw refused("session_lost");
  await chmod(path, 0o700);
}

/** The login and mounted adapter share one exclusive host-process and cross-process session lock. */
export async function ownerSession(
  dataDir: string,
): Promise<{
  readonly databaseDir: string;
  readonly filesDir: string;
  readonly release: () => Promise<void>;
}> {
  await privateDirectory(dataDir);
  const databaseDir = join(dataDir, "db");
  const filesDir = join(dataDir, "files");
  await privateDirectory(databaseDir);
  await privateDirectory(filesDir);
  const lock = join(dataDir, "session.lock");
  let fd: number;
  try {
    fd = openSync(lock, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  } catch {
    throw refused("session_in_use");
  }
  try {
    const entry = fstatSync(fd);
    if (!entry.isFile() || entry.nlink !== 1 ||
      (process.getuid !== undefined && entry.uid !== process.getuid()) ||
      native.flock(fd, LOCK_EX_NB) !== 0) throw refused("session_in_use");
    fchmodSync(fd, 0o600);
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  let released = false;
  return {
    databaseDir,
    filesDir,
    release: async () => {
      if (released) return;
      // Never unlink: all contenders must lock the same inode. The OS also releases on process exit.
      closeSync(fd);
      released = true;
    },
  };
}
