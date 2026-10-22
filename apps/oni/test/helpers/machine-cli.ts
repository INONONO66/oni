import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { Machine } from "@oni/protocol";
import { createMemoryGenerationStore, type createMachineHost } from "@oni/machines";
import { daemonFingerprint, hostIdentity } from "../../../../packages/machines/test/ipc/helpers/tls-fixtures";
import { refusingToolPort } from "./tool-port";

/** The committed PEM fixture files the CLI config points at (paths, not contents). */
export const tlsFixturesDir = join(import.meta.dir, "../../../../packages/machines/test/ipc/fixtures");

/** One QA-flavored daemon offer exporting `root` as `data`. */
export function qaOffer(machineId: string, root: string, capabilities: readonly string[]): Omit<Machine.Offer, "peer" | "generation"> {
  return {
    machineId,
    offeredCapabilities: [...capabilities],
    exports: [{ name: "data", path: root }],
    daemonVersion: "qa",
    platform: `${process.platform}-${process.arch}`,
    offeredAt: 2,
  };
}

type HostOptions = Parameters<typeof createMachineHost>[0];
/** A pinned-TLS tcp listener whose enrollments pin the committed daemon key. */
export function pinnedTcpHostOptions(
  id: () => string,
  capabilities: readonly string[],
  events: HostOptions["events"] = { publish() { return; } },
): HostOptions {
  return {
    generations: createMemoryGenerationStore(),
    listen: { tcp: { host: "127.0.0.1", port: 0 } },
    tls: hostIdentity,
    id,
    dispatcherBound: 8,
    callTool: refusingToolPort,
    enrollment: (machineId) => ({
      machineId,
      name: machineId,
      allowedCapabilities: [...capabilities],
      allowedExports: ["data"],
      publicKey: daemonFingerprint,
      enrolledAt: 1,
    }),
    events,
    now: () => 2,
  };
}

/** Spawn `machine attach` on a config; `attachment()` is its first stdout line, typed. */
export function spawnAttachCli(configPath: string) {
  const child = spawn(
    process.execPath,
    [join(import.meta.dir, "../../src/cli/main.ts"), "machine", "attach", configPath],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0 ? resolve() : reject(new Error(`machine CLI exited ${code}/${signal}`)),
    );
  });
  async function attachment(): Promise<Machine.AttachResult> {
    const lines = createInterface({ input: child.stdout });
    let errors = "";
    child.stderr.on("data", (chunk: Buffer) => {
      errors += chunk.toString();
    });
    try {
      const line = await Promise.race([
        once(lines, "line", { signal: AbortSignal.timeout(10_000) }),
        exited.then(() => {
          throw new Error(`machine CLI ended before attachment: ${errors}`);
        }),
      ]);
      return Machine.AttachResult.parse(JSON.parse(String(line[0])));
    } finally {
      lines.close();
    }
  }
  return { child, exited, attachment };
}
