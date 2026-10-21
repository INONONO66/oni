import type { attachMachineDaemon } from "@oni/machines";
import { testIds } from "./test-entropy";

export function cellDaemonOptions(
  socketPath: string,
  machineId: string,
): Extract<Parameters<typeof attachMachineDaemon>[0], { socketPath: string }> {
  return {
    socketPath,
    id: testIds(`cell-daemon-${machineId}`),
    dispatcherBound: 8,
    offer: {
      machineId,
      offeredCapabilities: ["kernel.py"],
      daemonVersion: "test",
      platform: "test",
      offeredAt: 0,
    },
  };
}
