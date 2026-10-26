import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Machine, type ObservationSink } from "@oni/protocol";
import type { Effect } from "effect";
import type { MachineHost, MachineInfo } from "@oni/machines";
import { mclientBinary } from "../../../../packages/machines/test/helpers/mclient";
import { spawnMclient } from "../../src/composition/mclient";
import { writeMclientSettings } from "../../src/composition/mclient";
import { acquireEffect } from "./effect";
import { Bus } from "./bus";

export { mclientBinary };

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

/** App-owned listeners publish the attachment through the same observation bus as production. */
export async function attachAppMclient(options: {
  readonly socketPath: string;
  readonly machineId: string;
  readonly root: string;
  readonly exports?: readonly { readonly name: string; readonly path: string }[];
  readonly tags?: readonly string[];
  readonly tmuxSocket?: string;
}) {
  const directory = mkdtempSync(join(tmpdir(), "oni-app-client-"));
  const configPath = join(directory, "client.json");
  writeMclientSettings(configPath, {
    machineId: options.machineId, name: options.machineId, host: "localhost",
    unix: options.socketPath, exports: options.exports ?? [{ name: "workspace", path: options.root }],
    tags: options.tags ?? [], memoryBudgetMb: 96,
    ...(options.tmuxSocket === undefined ? {} : { tmuxSocket: options.tmuxSocket }),
  });
  const admitted = Promise.withResolvers<void>();
  const unsubscribe = Bus.subscribe(Machine.Events.Attached, (event) => {
    if (event.machineId === options.machineId) admitted.resolve();
  });
  const timeout = setTimeout(() => admitted.reject(new Error(`attach deadline: ${options.machineId}`)), 10_000);
  let child: Effect.Success<ReturnType<typeof spawnMclient>> | undefined;
  try {
    child = await acquireEffect(spawnMclient(configPath, await mclientBinary()));
    await Promise.race([
      admitted.promise,
      child.exited.then((code) => { throw new Error(`mclient exited before attachment: ${code}`); }),
    ]);
  } catch (error) {
    await child?.stop();
    rmSync(directory, { recursive: true, force: true });
    throw error;
  } finally {
    clearTimeout(timeout);
    unsubscribe();
  }
  if (child === undefined) throw new Error("mclient spawn did not produce a child");
  return {
    ...child,
    async stop() {
      try { await child.stop(); }
      finally { rmSync(directory, { recursive: true, force: true }); }
    },
  };
}
