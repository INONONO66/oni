import { WebSocketHandler, type WsConnection } from "../../../packages/channels/src/index.js";
import { Effect } from "effect";
import { StreamProbeResponse } from "../../../apps/oni/src/composition/stream-probe.js";
import { runStreamProbe, type ProbeLink } from "../../../apps/oni/src/cli/stream-probe.js";
import { openStreamViewer } from "../../../apps/oni/src/cli/stream-viewer.js";
import { gatewayRuntime, webSocketCallbacks } from "../../../apps/oni/src/gateway.js";
import { composedHolder } from "../../../apps/oni/test/helpers/bundle-fixture.js";
import { Bus } from "../../../apps/oni/test/helpers/bus.js";
import { testIds } from "../../../apps/oni/test/helpers/test-entropy.js";
import type { MachineHost } from "../../../packages/machines/src/index.js";

/** Exercise the same CLI and gateway probe against the attached scripted screen. */
export async function probeStream(host: MachineHost, machineId: string, display: number) {
  const pending: StreamProbeResponse[] = [];
  const waiters: Array<{
    readonly match: (frame: StreamProbeResponse) => boolean;
    readonly resolve: (frame: StreamProbeResponse) => void;
  }> = [];
  const emit = (line: string) => {
    const frame = StreamProbeResponse.parse(JSON.parse(line));
    const index = waiters.findIndex((waiter) => waiter.match(frame));
    if (index < 0) pending.push(frame);
    else waiters.splice(index, 1)[0]?.resolve(frame);
  };
  const socket: WsConnection = {
    data: { surfaceKey: "ws::dm:probe", authenticated: true, externalId: "conformance-probe" },
    send: emit,
  };
  const runtime = gatewayRuntime({ composed: composedHolder(), observations: Bus });
  const handler = new WebSocketHandler(() => Effect.void, Bus.publish, { now: Date.now, id: testIds("stream-probe") });
  const gateway = webSocketCallbacks(runtime, handler, Bus, undefined, undefined, undefined, host,
    undefined, undefined, undefined, Date.now);
  const link: ProbeLink = {
    send: (frame) => { void gateway.callbacks.message(socket, JSON.stringify(frame)); },
    next: (match) => {
      const index = pending.findIndex(match);
      if (index >= 0) {
        const [frame] = pending.splice(index, 1);
        if (frame !== undefined) return Promise.resolve(frame);
      }
      return new Promise((resolve) => waiters.push({ match, resolve }));
    },
    close: () => undefined,
  };
  try {
    return await runStreamProbe({ machineId, display }, {
      id: () => "conformance-probe",
      connect: async () => link,
      viewer: openStreamViewer,
      wait: async () => undefined,
    });
  } finally {
    gateway.callbacks.close(socket);
    await gateway.settled();
    await runtime.dispose();
  }
}
