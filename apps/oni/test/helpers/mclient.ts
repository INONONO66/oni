import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Machine, type ObservationSink } from "@oni/protocol";
import type { MachineHost, MachineInfo } from "@oni/machines";
import { resolveMclientBin } from "../../src/config";
import { spawnMclient } from "../../src/composition/mclient";
import { acquireEffect } from "./effect";

let built: Promise<string> | undefined;

/** Reuse an explicitly supplied/prebuilt client; a clean checkout builds only once. */
export function mclientBinary(): Promise<string> {
  built ??= (async () => {
    const binary = resolveMclientBin();
    if (existsSync(binary)) return binary;
    if (process.env.ONI_MCLIENT_BIN) throw new Error(`ONI_MCLIENT_BIN does not exist: ${binary}`);
    const build = Bun.spawn(["cargo", "build", "--release", "-p", "oni-machine-client"], {
      cwd: join(import.meta.dir, "../../../../clients"),
      env: { ...process.env, PATH: `${join(homedir(), ".cargo", "bin")}:${process.env.PATH ?? ""}` },
      stdout: "inherit", stderr: "inherit",
    });
    const code = await build.exited;
    if (code !== 0) throw new Error(`mclient build exited ${code}`);
    return binary;
  })();
  return built;
}

/** Install before starting a child; admission is observed on the host, never stdout. */
export function mclientAttached(
  host: MachineHost,
  events: Required<Pick<ObservationSink, "subscribe">>,
  machineId: string,
) {
  const admitted = Promise.withResolvers<MachineInfo>();
  const previous = host.list().find((entry) => entry.machineId === machineId)?.generation ?? 0;
  const timer = setTimeout(() => admitted.reject(new Error(`attach deadline: ${machineId}`)), 10_000);
  const unsubscribe = events.subscribe(Machine.Events.Reported, (event) => {
    const info = host.list().find((entry) => entry.machineId === event.machineId);
    if (event.machineId === machineId && info !== undefined && info.generation > previous)
      admitted.resolve(info);
  });
  const dispose = () => { clearTimeout(timer); unsubscribe(); };
  return { promise: admitted.promise.finally(dispose), dispose };
}

/** Scoped real client for other machine tests; callers close acquired Effects. */
export async function spawnAttachedMclient(options: {
  readonly configPath: string;
  readonly host: MachineHost;
  readonly events: Required<Pick<ObservationSink, "subscribe">>;
  readonly machineId: string;
}) {
  const binary = await mclientBinary();
  const pending = mclientAttached(options.host, options.events, options.machineId);
  try {
    const child = await acquireEffect(spawnMclient(options.configPath, binary));
    const attachment = await Promise.race([
      pending.promise,
      child.exited.then((code) => { throw new Error(`mclient exited before attachment: ${code}`); }),
    ]);
    return { ...child, attachment };
  } finally {
    pending.dispose();
  }
}
