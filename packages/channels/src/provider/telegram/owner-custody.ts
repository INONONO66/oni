import { chmod, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { TelegramOwnerErrorCode } from "./owner-sdk.js";

const FailureCode = z.object({ code: z.string() });

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

async function recoverDeadLock(lock: string): Promise<void> {
  const entry = await lstat(lock);
  if (!entry.isDirectory() || entry.isSymbolicLink() || (process.getuid !== undefined && entry.uid !== process.getuid()))
    throw refused("session_in_use");
  let pid: number;
  try {
    pid = Number(await readFile(join(lock, "pid"), "utf8"));
  } catch {
    throw refused("session_in_use");
  }
  if (!Number.isSafeInteger(pid) || pid <= 0) throw refused("session_in_use");
  const dead = await Promise.resolve().then(() => process.kill(pid, 0))
    .then(() => false, (failure: Error) => FailureCode.safeParse(failure).data?.code === "ESRCH");
  if (!dead) throw refused("session_in_use");
  if ((await lstat(lock)).ino !== entry.ino) throw refused("session_in_use");
  await rm(lock, { recursive: true });
  await mkdir(lock, { mode: 0o700 }).catch(() => { throw refused("session_in_use"); });
}

/** The login and mounted adapter share one exclusive host-process and cross-process session lock. */
export async function ownerSession(
  dataDir: string,
  writePid: (path: string, pid: string) => Promise<void> =
    (path, pid) => writeFile(path, pid, { flag: "wx", mode: 0o600 }),
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
  await mkdir(lock, { mode: 0o700 }).catch(async (error: Error) => {
    if (FailureCode.safeParse(error).data?.code !== "EEXIST") throw error;
    await recoverDeadLock(lock);
  });
  await writePid(join(lock, "pid"), String(process.pid)).catch(async (error: Error) => {
    await rm(lock, { recursive: true });
    throw error;
  });
  let released = false;
  return {
    databaseDir,
    filesDir,
    release: async () => {
      if (released) return;
      released = true;
      await rm(lock, { recursive: true });
    },
  };
}
