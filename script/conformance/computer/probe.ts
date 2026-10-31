import { createStreamProbe, StreamProbeResponse } from "../../../apps/oni/src/composition/stream-probe.js";
import { runStreamProbe, type ProbeLink } from "../../../apps/oni/src/cli/stream-probe.js";
import { openStreamViewer } from "../../../apps/oni/src/cli/stream-viewer.js";
import type { ComputerHandle } from "../../../packages/machines/src/index.js";
import { run } from "../../../packages/machines/test/ipc/helpers/effects.js";

/** Exercise the same CLI and gateway probe against the attached scripted screen. */
export async function probeStream(computer: ComputerHandle, machineId: string, display: number) {
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
  const socket = { send: emit };
  const probe = createStreamProbe({
    now: Date.now,
    open: async (_machineId, source, listeners) => {
      const opened = await run(computer.stream.open({
        source: { kind: "display", display: source },
        video: { maxFps: 30, keyframeIntervalMs: 500, maxBitrateBps: 2_000_000, maxDimension: 640, maxFrameBytes: 1_000_000 },
        dataChannel: true,
        lifetimeMs: 120_000,
      }, listeners));
      return "status" in opened ? opened : {
        streamId: opened.streamId,
        capturedAt: opened.capturedAt,
        signal: (signal: Parameters<typeof opened.signal>[0]) => run(opened.signal(signal)),
        close: () => run(opened.close()),
      };
    },
  });
  const link: ProbeLink = {
    send: (frame) => { void probe.handle(socket, JSON.stringify(frame), true); },
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
    await probe.close(socket);
  }
}
