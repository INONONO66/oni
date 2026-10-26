import { spawn } from "node:child_process";
import { join } from "node:path";
import type { Machine, ObservationSink } from "@oni/protocol";
import { createMemoryGenerationStore, type createMachineHost, type MachineHost } from "@oni/machines";
import { daemonFingerprint, hostIdentity } from "../../../../packages/machines/test/ipc/helpers/tls-fixtures";
import { refusingToolPort } from "./tool-port";
import { mclientAttached } from "./mclient";

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

/** Observe admission at the host before spawning the CLI's Rust child. */
export function spawnAttachCli(configPath: string, options: {
  readonly host: MachineHost;
  readonly events: Required<Pick<ObservationSink, "subscribe">>;
  readonly machineId: string;
}) {
  const admitted = mclientAttached(options.host, options.events, options.machineId);
  const child = spawn(
    process.execPath,
    [join(import.meta.dir, "../../src/cli/main.ts"), "machine", "attach", configPath],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stderr.pipe(process.stderr);
  const exited = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === null ? reject(new Error(`machine CLI exited by ${signal}`)) : resolve(code),
    );
  });
  async function attachment(): Promise<Machine.AttachResult> {
    let errors = "";
    child.stderr.on("data", (chunk: Buffer) => {
      errors += chunk.toString();
    });
    try {
      const info = await Promise.race([
        admitted.promise,
        exited.then(() => {
          throw new Error(`machine CLI ended before attachment: ${errors}`);
        }),
      ]);
      return {
        status: "attached", generation: info.generation,
        effectiveCapabilities: [...info.capabilities],
        effectiveExports: options.host.exports(options.machineId).map((entry) => entry.name),
      };
    } finally {
      admitted.dispose();
    }
  }
  return { child, exited, attachment };
}
