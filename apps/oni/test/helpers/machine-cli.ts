import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Machine, ObservationSink } from "@oni/protocol";
import { createMemoryGenerationStore, type createMachineHost, type MachineHost } from "@oni/machines";
import { daemonFingerprint, daemonIdentity, hostIdentity, hostPin } from "../../../../packages/machines/test/ipc/helpers/tls-fixtures";
import { writeMclientSettings } from "../../src/composition/mclient";
import { refusingToolPort } from "./tool-port";
import { mclientAttached, mclientBinary } from "./mclient";

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

/**
 * One client directory as `mclient join` leaves it: client.json beside the
 * host pin and the client's TLS identity (the committed daemon fixture, which
 * `pinnedTcpHostOptions` enrolls). A unix endpoint needs no pin or identity.
 */
export function writeClientDirectory(directory: string, options: {
  readonly machineId: string;
  readonly root: string;
  readonly endpoint: { readonly unix: string } | { readonly tcp: { readonly host: string; readonly port: number } };
}): string {
  const path = join(directory, "client.json");
  const unix = "unix" in options.endpoint ? options.endpoint.unix : null;
  writeMclientSettings(path, {
    machineId: options.machineId, name: options.machineId,
    host: "tcp" in options.endpoint ? `${options.endpoint.tcp.host}:${options.endpoint.tcp.port}` : "localhost",
    unix,
    exports: [{ name: "data", path: options.root }], tags: [], memoryBudgetMb: 96,
  });
  if (unix !== null) return path;
  for (const [name, value] of [
    ["host-pin", hostPin],
    ["client-cert.pem", daemonIdentity.certificate],
    ["client-key.pem", daemonIdentity.privateKey],
  ] as const) writeFileSync(join(directory, name), value, { mode: 0o600 });
  return path;
}

/** Observe admission at the host before spawning the Rust client on its settings. */
export async function spawnClient(configPath: string, options: {
  readonly host: MachineHost;
  readonly events: Required<Pick<ObservationSink, "subscribe">>;
  readonly machineId: string;
}) {
  const admitted = mclientAttached(options.host, options.events, options.machineId);
  const child = spawn(
    await mclientBinary(),
    ["run", "--allow-unpinned", "--config", configPath],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stderr.pipe(process.stderr);
  const exited = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === null ? reject(new Error(`machine client exited by ${signal}`)) : resolve(code),
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
          throw new Error(`machine client ended before attachment: ${errors}`);
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
