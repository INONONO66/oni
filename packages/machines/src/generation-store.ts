import { mkdirSync, readFileSync, renameSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseJson } from "@oni/protocol";
import { Effect } from "effect";
import { z } from "zod";
import { MachinesFailure } from "./errors";

export interface AttachGenerationStore {
  current(machineId: string): Effect.Effect<number | undefined, MachinesFailure>;
  compareAndSet(machineId: string, expected: number | undefined, next: number): Effect.Effect<boolean, MachinesFailure>;
}

export function createMemoryGenerationStore(): AttachGenerationStore {
  const generations = new Map<string, number>();
  return {
    current: (machineId) => Effect.sync(() => generations.get(machineId)),
    compareAndSet: (machineId, expected, next) => Effect.sync(() => {
      if (generations.get(machineId) !== expected) return false;
      generations.set(machineId, next);
      return true;
    }),
  };
}

const Generations = z.record(z.string(), z.number().int().min(1));

export function createFileGenerationStore({ path }: { readonly path: string }): AttachGenerationStore {
  const lock = `${path}.lock`;
  function ownerGone(): boolean {
    const pid = Number(readFileSync(`${lock}/pid`, "utf8"));
    if (!Number.isSafeInteger(pid) || pid < 1) return false;
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return error instanceof Error && "code" in error && error.code === "ESRCH";
    }
  }
  function acquireLock(): boolean {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        mkdirSync(lock);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
        // Unknown ownership fails closed; only ESRCH proves a recorded holder died.
        if (!ownerGone()) return false;
        rmSync(lock, { recursive: true });
        continue;
      }
      try {
        writeFileSync(`${lock}/pid`, String(process.pid), { mode: 0o600 });
      } catch (error) {
        rmSync(lock, { recursive: true });
        throw error;
      }
      return true;
    }
    return false;
  }
  function releaseLock(): void {
    rmSync(`${lock}/pid`, { force: true });
    rmdirSync(lock);
  }
  function read(): Map<string, number> {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return new Map();
      throw error;
    }
    const generations = parseJson(Generations, text);
    if (generations === undefined) throw new MachinesFailure({ operation: "generation.read", cause: `invalid attach generations: ${path}` });
    return new Map(Object.entries(generations));
  }
  function publish(machineId: string, expected: number | undefined, next: number, committed: () => void): boolean {
    const generations = read();
    if (generations.get(machineId) !== expected) return false;
    generations.set(machineId, next);
    writeFileSync(`${path}.tmp`, JSON.stringify(Object.fromEntries(generations)), { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
    committed();
    return true;
  }
  function lockedCompareAndSet(machineId: string, expected: number | undefined, next: number): boolean {
    mkdirSync(dirname(path), { recursive: true });
    if (!acquireLock()) return false;
    let published = false;
    let result = false;
    let failure: Error | undefined;
    const cleanup = (action: () => void) => {
      try {
        action();
      } catch (error) {
        if (!published && failure === undefined) failure = error instanceof Error ? error : new Error(String(error));
      }
    };
    try {
      result = publish(machineId, expected, next, () => { published = true; });
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    }
    cleanup(() => rmSync(`${path}.tmp`, { force: true }));
    // Retry a transient cleanup failure after commit: it must not turn a
    // published generation into a failed CAS or strand this live holder.
    try {
      releaseLock();
    } catch (error) {
      cleanup(releaseLock);
      if (!published && failure === undefined) failure = error instanceof Error ? error : new Error(String(error));
    }
    if (failure !== undefined) throw failure;
    return result;
  }
  return {
    current: (machineId) => Effect.try({
      try: () => read().get(machineId),
      catch: (error) => new MachinesFailure({ operation: "generation.read", cause: String(error) }),
    }),
    compareAndSet: (machineId, expected, next) => Effect.try({
      try: () => lockedCompareAndSet(machineId, expected, next),
      catch: (error) => new MachinesFailure({ operation: "generation.compareAndSet", cause: String(error) }),
    }),
  };
}
