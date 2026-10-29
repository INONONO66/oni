import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { MachinesFailure } from "@oni/machines";
import { Effect } from "effect";
import { resolveMclientBin } from "../config";
import { foreignFailure } from "./failure";

// Promise band (#1423): Bun's child exit promise and OS signals own this
// process lifetime. Effect enters once through acquireRelease; no session
// work or Effect runner executes in a native callback.

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

/** Rust persists its generation, hook socket and metrics beside this private file. */
export function writeMclientSettings(path: string, settings: MclientSettings): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(settings), { mode: 0o600 });
  chmodSync(path, 0o600);
}

async function signalGroup(pid: number, signal: NodeJS.Signals): Promise<void> {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return;
    if (error instanceof Error && "code" in error && error.code === "EPERM") {
      // Darwin reports EPERM for a group containing only reparented zombies.
      // Refuse a live survivor; a successful signal alone cannot prove cleanup.
      const probe = Bun.spawn(["ps", "-axo", "pgid=,stat="], { stdout: "pipe", stderr: "inherit" });
      const processes = await new Response(probe.stdout).text();
      const code = await probe.exited;
      if (code === 0 && !processes.split("\n").some((line) => {
        const [group, state] = line.trim().split(/\s+/);
        return Number(group) === pid && !state?.startsWith("Z");
      })) return;
    }
    throw error;
  }
}

/** A scoped child and its descendants are reaped even if the leader exits first. */
export function spawnMclient(
  configPath: string,
  binary = resolveMclientBin(),
) {
  return Effect.acquireRelease(
    Effect.try({
      try: () => {
        const child = Bun.spawn([binary, "run", "--config", configPath, "--allow-unpinned"], {
          stdin: "ignore", stdout: "inherit", stderr: "inherit", detached: true,
        });
        const exited = child.exited.finally(() => signalGroup(child.pid, "SIGKILL"));
        const closed = Effect.tryPromise({
          try: () => exited,
          catch: foreignFailure((fields) => new MachinesFailure(fields), "mclient.exit"),
        });
        const stop = async () => {
          // An unexpected exit already retired this group. Never signal its
          // old pid again when the app scope closes after that pid is reused.
          if (child.exitCode !== null || child.signalCode !== null) {
            await exited;
            return;
          }
          await signalGroup(child.pid, "SIGTERM");
          const failed = Promise.withResolvers<never>();
          const deadline = setTimeout(() => {
            void signalGroup(child.pid, "SIGKILL").catch(failed.reject);
          }, 1000);
          try {
            await Promise.race([exited, failed.promise]);
          } finally {
            clearTimeout(deadline);
          }
        };
        return { pid: child.pid, closed, exited, stop };
      },
      catch: foreignFailure((fields) => new MachinesFailure(fields), "mclient.spawn"),
    }),
    (child) => Effect.promise(child.stop),
  );
}
