import { Effect } from "effect";
import { acquireEffect, acquireSyncEffect } from "./effect";
import { createCodemode } from "@oni/codemode";
import { attachMachineDaemon, createMachineHost, createMemoryGenerationStore } from "@oni/machines";
import { testIds } from "./test-entropy";
import type { Machine } from "@oni/protocol";
import { refusingToolPort } from "./tool-port";

export function bridgeHost(
  socketPath: string,
  options: { callTool?: (call: Machine.ToolCall) => Promise<Machine.ToolCallResult> } = {},
) {
  const callTool = options.callTool;
  return acquireEffect(createMachineHost({
    generations: createMemoryGenerationStore(),
    dispatcherBound: 8,
    callTool: refusingToolPort,
    listen: { unix: socketPath },
    id: testIds("bridge-host"),
    enrollment: () => ({
      name: "workstation",
      machineId: "m-1",
      allowedCapabilities: ["kernel.py"],
      publicKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      enrolledAt: 1000,
    }),
    events: { publish: () => undefined },
    now: () => 5000,
    ...(callTool === undefined ? {} : {
      callTool: (call: Machine.ToolCall) => Effect.promise(() => callTool(call)),
    }),
  }));
}

export async function bridgeProbe(socketPath: string) {
  let reached = false;
  const host = await bridgeHost(socketPath, {
    callTool: () => {
      reached = true;
      return Promise.resolve({ status: "completed", value: "ran" });
    },
  });
  return { host, reached: () => reached };
}

export function bridgeOffer(): Omit<Machine.Offer, "peer" | "generation"> {
  return {
    machineId: "m-1",
    daemonVersion: "0.1.0",
    platform: "darwin",
    offeredCapabilities: ["kernel.py"],
    offeredAt: 2000,
  };
}

export function bridgeDaemon(socketPath: string) {
  return acquireEffect(attachMachineDaemon({ id: testIds("bridge-daemon"), dispatcherBound: 8, runner: acquireSyncEffect(createCodemode({ id: testIds("bridge-cell") })).runner, socketPath, offer: bridgeOffer() }));
}
