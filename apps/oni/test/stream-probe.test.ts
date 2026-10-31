import { expect, test } from "bun:test";
import { createStreamProbe, StreamProbeResponse } from "../src/composition/stream-probe";
import { parseStreamProbeArgs, runStreamProbe, type ProbeLink } from "../src/cli/stream-probe";
import type { StreamViewer } from "../src/cli/stream-viewer";
import type { StreamListeners } from "@oni/machines";

test("stage probe folds mapped receipt and decoded times after a stream reopen", async () => {
  const frames: StreamProbeResponse[] = [];
  let clock = 100;
  let sequence = 0;
  const opened: StreamListeners[] = [];
  const probe = createStreamProbe({
    now: () => clock,
    open: async (_machineId, _display, listeners) => {
      opened.push(listeners);
      return {
        streamId: `stream-${opened.length}`,
        capturedAt: (us: number) => us,
        signal: async () => ({ status: "accepted" as const, seq: sequence++ }),
        close: async () => ({ status: "closed" as const, streamId: `stream-${opened.length}` }),
      };
    },
  });
  const ws = { send: (line: string) => frames.push(StreamProbeResponse.parse(JSON.parse(line))) };
  const send = async (frame: object) => probe.handle(ws, JSON.stringify(frame), true);
  const requestId = "probe";

  await send({ type: "stream_probe_open", requestId, machineId: "macbook", display: 1 });
  expect(frames.at(-1)).toMatchObject({ type: "stream_probe_opened", streamId: "stream-1" });
  await send({ type: "stream_probe_frame", requestId, seq: 1, capturedAtUs: 10, receivedAt: 20, decodedAt: 25 });
  await send({ type: "stream_probe_frame", requestId, seq: 3, capturedAtUs: 30, receivedAt: 40, decodedAt: 45 });
  await send({ type: "stream_probe_close", requestId, reconnect: true });
  clock = 100;
  await send({ type: "stream_probe_open", requestId, machineId: "macbook", display: 1, reconnect: true });
  await send({ type: "stream_probe_frame", requestId, seq: 0, capturedAtUs: 110, receivedAt: 120, decodedAt: 125 });
  await send({ type: "stream_probe_report", requestId });
  expect(frames.at(-1)).toMatchObject({
    type: "stream_probe_report",
    stages: {
      captureToReceipt: { frames: 3, p50: 10, p95: 10, p99: 10, dropped: 1, reconnectFirstFreshFrameMs: 20 },
      captureToDecoded: { frames: 3, p50: 15, p95: 15, p99: 15, dropped: 1, reconnectFirstFreshFrameMs: 25 },
      captureToDisplay: null,
      displayedBy: "none",
    },
    reconnect: "measured",
    reconnectFirstFreshFrameMs: 20,
  });
  expect(opened).toHaveLength(2);
  await probe.close(ws);
});

test("probe refuses unauthenticated access and reports a failed reopen without inventing latency", async () => {
  const frames: StreamProbeResponse[] = [];
  const probe = createStreamProbe({
    now: () => 7,
    open: async (_machineId, _display, _listeners) => ({ status: "refused" as const, reason: "machine_not_attached" as const, message: "gone" }),
  });
  const ws = { send: (line: string) => frames.push(StreamProbeResponse.parse(JSON.parse(line))) };
  const request = JSON.stringify({ type: "stream_probe_open", requestId: "p", machineId: "macbook", display: 1 });
  expect(await probe.handle(ws, request, false)).toBe(true);
  expect(frames.at(-1)).toMatchObject({ type: "stream_probe_refused", reason: "unauthenticated" });
  await probe.handle(ws, request, true);
  expect(frames.at(-1)).toMatchObject({ type: "stream_probe_refused", reason: "machine_not_attached" });
  expect(await probe.handle(ws, '{"type":"machine_list","requestId":"p"}', true)).toBe(false);
});

test("failed reopen preserves first-stream measurements and marks reconnection unavailable", async () => {
  const frames: StreamProbeResponse[] = [];
  let opens = 0;
  const probe = createStreamProbe({
    now: () => 100,
    open: async () => {
      opens += 1;
      if (opens === 2) return { status: "refused" as const, reason: "machine_not_attached" as const, message: "gone" };
      return {
        streamId: "first",
        capturedAt: (us: number) => us,
        signal: async () => ({ status: "accepted" as const, seq: 0 }),
        close: async () => ({ status: "closed" as const, streamId: "first" }),
      };
    },
  });
  const ws = { send: (line: string) => frames.push(StreamProbeResponse.parse(JSON.parse(line))) };
  const send = async (frame: object) => probe.handle(ws, JSON.stringify(frame), true);
  await send({ type: "stream_probe_open", requestId: "p", machineId: "macbook", display: 1 });
  await send({ type: "stream_probe_frame", requestId: "p", seq: 0, capturedAtUs: 10, receivedAt: 20, decodedAt: 25 });
  await send({ type: "stream_probe_close", requestId: "p", reconnect: true });
  await send({ type: "stream_probe_open", requestId: "p", machineId: "macbook", display: 1, reconnect: true });
  expect(frames.at(-1)).toMatchObject({ type: "stream_probe_refused", reason: "machine_not_attached" });
  await send({ type: "stream_probe_report", requestId: "p" });
  expect(frames.at(-1)).toMatchObject({
    reconnect: "unavailable",
    reconnectFirstFreshFrameMs: null,
    stages: { captureToReceipt: { frames: 1, p99: 10 }, captureToDecoded: { frames: 1, p99: 15 } },
  });
  await probe.close(ws);
});

test("a refused close cannot be reported as a successful reconnect", async () => {
  const frames: StreamProbeResponse[] = [];
  const probe = createStreamProbe({
    now: () => 100,
    open: async () => ({
      streamId: "first",
      capturedAt: (us: number) => us,
      signal: async () => ({ status: "accepted" as const, seq: 0 }),
      close: async () => ({ status: "refused" as const, reason: "machine_not_attached" as const, message: "gone" }),
    }),
  });
  const ws = { send: (line: string) => frames.push(StreamProbeResponse.parse(JSON.parse(line))) };
  await probe.handle(ws, JSON.stringify({ type: "stream_probe_open", requestId: "p", machineId: "macbook", display: 1 }), true);
  await probe.handle(ws, JSON.stringify({ type: "stream_probe_close", requestId: "p", reconnect: true }), true);
  expect(frames.at(-1)).toMatchObject({ type: "stream_probe_refused", reason: "machine_not_attached" });
  await probe.handle(ws, JSON.stringify({ type: "stream_probe_report", requestId: "p" }), true);
  expect(frames.at(-1)).toMatchObject({ reconnect: "unavailable", reconnectFirstFreshFrameMs: null });
});

test("CLI probe negotiates and forwards decoded frames through the injected stream source", async () => {
  const queue: StreamProbeResponse[] = [];
  const listeners: Array<{ readonly match: (frame: StreamProbeResponse) => boolean; readonly resolve: (frame: StreamProbeResponse) => void }> = [];
  let closed = false;
  const emit = (frame: StreamProbeResponse) => {
    const index = listeners.findIndex((waiter) => waiter.match(frame));
    if (index === -1) queue.push(frame);
    else listeners.splice(index, 1)[0]?.resolve(frame);
  };
  let stream = 0;
  const link: ProbeLink = {
    send: (frame) => {
      const { requestId, type } = frame;
      if (type === "stream_probe_open") {
        stream += 1;
        emit({ type: "stream_probe_signal", requestId, signal: { type: "offer", sdp: "offer" } });
        emit({ type: "stream_probe_signal", requestId, signal: { type: "end_of_candidates" } });
        emit({ type: "stream_probe_opened", requestId, streamId: `stream-${stream}` });
      } else if (type === "stream_probe_close") emit({ type: "stream_probe_closed", requestId });
      else if (type === "stream_probe_report") emit(StreamProbeResponse.parse({
        type: "stream_probe_report", requestId, reconnect: "measured", reconnectFirstFreshFrameMs: 5,
        stages: {
          captureToReceipt: { frames: 20, p50: 1, p95: 2, p99: 3, dropped: 0, reconnectFirstFreshFrameMs: 5 },
          captureToDecoded: { frames: 20, p50: 2, p95: 3, p99: 4, dropped: 0, reconnectFirstFreshFrameMs: 6 },
          captureToDisplay: null, displayedBy: "none",
        },
      }));
      else emit({ type: "stream_probe_accepted", requestId });
    },
    next: (match) => {
      const index = queue.findIndex(match);
      if (index >= 0) {
        const [frame] = queue.splice(index, 1);
        if (frame !== undefined) return Promise.resolve(frame);
      }
      return new Promise((resolve) => listeners.push({ match, resolve }));
    },
    close: () => { closed = true; },
  };
  let viewersClosed = 0;
  const viewer: StreamViewer = {
    answer: async () => ({ sdp: "answer", candidates: [] }),
    candidate: async () => undefined,
    until: async (count) => Array.from({ length: count }, (_, seq) =>
      ({ seq, capturedAtUs: seq, receivedAt: seq + 1, decodedAt: seq + 2 })),
    close: () => { viewersClosed += 1; },
  };
  const report = await runStreamProbe({ machineId: "macbook", display: 1, reconnect: { afterMs: 10 } }, {
    id: () => "test",
    connect: async () => link,
    viewer: async () => viewer,
    wait: async (ms) => expect(ms).toBe(10),
  });
  expect(report.stages.captureToReceipt.frames).toBe(20);
  expect(stream).toBe(2);
  expect(viewersClosed).toBe(2);
  expect(closed).toBe(true);
  expect(parseStreamProbeArgs(["macbook", "1", "--reconnect-after-ms", "10"])).toEqual({
    machineId: "macbook", display: 1, reconnect: { afterMs: 10 },
  });
  expect(() => parseStreamProbeArgs(["macbook", "9007199254740992"])).toThrow();
});
