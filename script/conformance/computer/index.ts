/**
 * Computer-use conformance (#1662 P5): the built client re-attached with
 * the headless fixture backends its `client.json` `computer` block selects
 * (the scripted layout in `clients/machine-client/tests/fixtures/computer/layout.json`
 * and a JSONL input recorder file), a `cdp.json` naming a local fake
 * DevTools endpoint, and its Unix socket routed through a byte-transparent
 * report tap. Every wait is a subscribed event: host bus events, relay
 * listener callbacks, tapped `machine.report` frames, viewer frame events
 * and process exits, each bounded by the harness timeout.
 */
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Effect, Result } from "effect";
import { z } from "zod";
import type {
  ComputerChannel,
  ComputerHandle,
  ComputerStream,
  MachineError,
  MachineHost,
  MachineInputCapture,
  RelayEnd,
} from "../../../packages/machines/src/index.js";
import { run } from "../../../packages/machines/test/ipc/helpers/effects.js";
import { Machine } from "../../../packages/protocol/src/index.js";
import { type FakeDevtools, startFakeDevtools } from "./devtools.js";
import { type ReportTap, startReportTap } from "./tap.js";
import { openViewer } from "./viewer.js";

const LAYOUT = resolve(
  import.meta.dir,
  "../../../clients/machine-client/tests/fixtures/computer/layout.json",
);
const STREAM_FRAMES = 30;
const STREAM_KEYFRAMES = 2;
const ANNEX_B = [0, 0, 0, 1];

const DisplayRow = z
  .object({
    id: z.number().int(),
    x: z.number().int(),
    y: z.number().int(),
    width: z.number().int(),
    height: z.number().int(),
    scale: z.number(),
    primary: z.boolean(),
  })
  .strict();
const WindowRow = z
  .object({
    id: z.number().int(),
    display: z.number().int(),
    title: z.string(),
    owner: z.string(),
    x: z.number().int(),
    y: z.number().int(),
    width: z.number().int(),
    height: z.number().int(),
  })
  .strict();
const Layout = z.object({ displays: z.array(DisplayRow), windows: z.array(WindowRow) }).strict();
type Layout = z.infer<typeof Layout>;

const RecordedEvent = z.discriminatedUnion("event", [
  z.object({ event: z.literal("move"), x: z.number().int(), y: z.number().int() }).strict(),
  z
    .object({
      event: z.literal("button"),
      button: z.enum(["left", "right", "middle"]),
      down: z.boolean(),
    })
    .strict(),
  z
    .object({ event: z.literal("scroll"), horizontal: z.boolean(), delta: z.number().int() })
    .strict(),
  z.object({ event: z.literal("key"), key: z.string(), down: z.boolean() }).strict(),
  z.object({ event: z.literal("text"), text: z.string() }).strict(),
]);
type RecordedEvent = z.infer<typeof RecordedEvent>;

const MetricsLine = z.object({
  at: z.number().int(),
  retainedStreamBytes: z.number().int(),
  retainedFrameBytes: z.number().int(),
  streamFps: z.number(),
  streamBytesPerSecond: z.number().int(),
  streamDroppedFrames: z.number().int(),
});

export interface ComputerHarness {
  readonly record: (line: string) => void;
  within<A>(promise: Promise<A>, label: string): Promise<A>;
  attach(): Promise<void>;
  stop(): Promise<void>;
  grant(allowed: boolean): void;
}

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`conformance failed: ${message}`);
}

export interface InputRecorder {
  readonly captured: MachineInputCapture[];
  allow: boolean;
}

export function inputRecorder(): InputRecorder {
  return { captured: [], allow: true };
}

export function captureInput(recorder: InputRecorder) {
  return (
    request: MachineInputCapture,
    forward: Effect.Effect<Machine.InputWriteResult, MachineError>,
  ): Effect.Effect<Machine.InputWriteResult, MachineError> =>
    Effect.suspend(() => {
      recorder.captured.push(request);
      if (recorder.allow) return forward;
      return Effect.succeed<Machine.InputWriteResult>({
        status: "refused",
        reason: "permission_denied",
        message: "tool.pre refused the captured input",
      });
    });
}

export interface ComputerSetup {
  readonly directory: string;
  readonly config: string;
  readonly hostSocket: string;
  readonly tapSocket: string;
  readonly recorder: string;
}

export function prepareComputer(setup: ComputerSetup): {
  readonly layout: Layout;
  readonly tap: ReportTap;
  readonly devtools: FakeDevtools;
} {
  const layout = Layout.parse(JSON.parse(readFileSync(LAYOUT, "utf8")));
  const devtools = startFakeDevtools();
  const tap = startReportTap(setup.tapSocket, setup.hostSocket);
  writeFileSync(join(setup.directory, "cdp.json"), JSON.stringify({ ports: [devtools.port] }));
  const config = z
    .record(z.string(), z.json())
    .parse(JSON.parse(readFileSync(setup.config, "utf8")));
  writeFileSync(
    setup.config,
    JSON.stringify({
      ...config,
      unix: tap.socket,
      computer: { layout: LAYOUT, recorder: setup.recorder },
    }),
  );
  return { layout, tap, devtools };
}

function recorded(path: string): RecordedEvent[] {
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => RecordedEvent.parse(JSON.parse(line)));
}

function pngSize(data: Buffer): { readonly width: number; readonly height: number } | undefined {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!data.subarray(0, 8).equals(signature)) return undefined;
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

function ending(): {
  readonly onClose: (reason: RelayEnd) => void;
  readonly ended: Promise<RelayEnd>;
} {
  let resolveEnd: (reason: RelayEnd) => void = () => undefined;
  const ended = new Promise<RelayEnd>((resolve) => {
    resolveEnd = resolve;
  });
  return { onClose: (reason) => resolveEnd(reason), ended };
}

interface Context {
  readonly harness: ComputerHarness;
  readonly host: MachineHost;
  readonly machineId: string;
  readonly layout: Layout;
  readonly tap: ReportTap;
  readonly devtools: FakeDevtools;
  readonly recorder: InputRecorder;
  readonly setup: ComputerSetup;
}

function computerOf(context: Context): ComputerHandle {
  const computer = context.host.get(context.machineId).computer;
  check(computer !== undefined, "host handle has no computer surface");
  return computer;
}

async function exerciseScreen(context: Context): Promise<string> {
  const { harness, layout } = context;
  const computer = computerOf(context);
  const listed = await run(computer.list({ windows: true }));
  check(listed.status === "ok", `screen list answered ${JSON.stringify(listed)}`);
  const displays = listed.displays.map(
    (entry) =>
      `${entry.display}:${entry.width}x${entry.height}@${entry.scale}${entry.primary ? "*" : ""}`,
  );
  const expected = layout.displays.map(
    (entry) =>
      `${entry.id}:${entry.width}x${entry.height}@${entry.scale}${entry.primary ? "*" : ""}`,
  );
  check(displays.join(",") === expected.join(","), `screen list displays ${displays.join(",")}`);
  const [window] = layout.windows;
  check(window !== undefined, "fixture layout has no window");
  const listedWindow = listed.windows.find((entry) => entry.title === window.title);
  check(
    listedWindow !== undefined &&
      listedWindow.owner === window.owner &&
      listedWindow.bounds.width === window.width &&
      listedWindow.bounds.height === window.height,
    `screen list windows ${JSON.stringify(listed.windows)}`,
  );
  harness.record(
    `screen list over the fixture backend: displays [${displays.join(", ")}], window "${window.title}" ${window.width}x${window.height}`,
  );
  const [primary] = layout.displays;
  check(primary !== undefined, "fixture layout has no display");
  const capture = await run(
    computer.capture({
      target: { kind: "display", display: primary.id },
      encoding: { format: "png" },
    }),
  );
  check(
    capture.status === "ok",
    `display capture answered ${capture.status === "refused" ? capture.reason : capture.status}`,
  );
  const size = pngSize(capture.data);
  const pixels = { width: primary.width * primary.scale, height: primary.height * primary.scale };
  check(
    size !== undefined &&
      size.width === capture.width &&
      size.height === capture.height &&
      capture.width === pixels.width &&
      capture.height === pixels.height,
    `display capture ${capture.width}x${capture.height}, png ${JSON.stringify(size)}`,
  );
  const windowCapture = await run(
    computer.capture({
      target: { kind: "window", windowId: listedWindow.windowId },
      encoding: { format: "jpeg", quality: 80 },
    }),
  );
  check(
    windowCapture.status === "ok" &&
      windowCapture.data[0] === 0xff &&
      windowCapture.data[1] === 0xd8 &&
      windowCapture.width === window.width &&
      windowCapture.height === window.height,
    `window capture answered ${windowCapture.status}`,
  );
  const missing = await run(
    computer.capture({
      target: { kind: "display", display: Machine.SCREEN_LIST_MAX_DISPLAYS },
      encoding: { format: "png" },
    }),
  );
  check(
    missing.status === "refused" && missing.reason === "display_not_found",
    `missing display answered ${JSON.stringify(missing.status === "refused" ? missing.reason : missing.status)}`,
  );
  const anchor = await run(
    computer.capture({
      target: { kind: "display", display: primary.id },
      encoding: { format: "png" },
      maxDimension: 320,
    }),
  );
  check(
    anchor.status === "ok" && anchor.downscaled && Math.max(anchor.width, anchor.height) === 320,
    "downscaled capture differs",
  );
  harness.record(
    `screen capture: display png ${capture.width}x${capture.height} (${capture.data.length} B sha256 ${createHash("sha256").update(capture.data).digest("hex").slice(0, 16)}, IHDR matches), window jpeg ${windowCapture.width}x${windowCapture.height}, downscaled ${anchor.width}x${anchor.height}, display ${Machine.SCREEN_LIST_MAX_DISPLAYS} refused display_not_found`,
  );
  return anchor.captureId;
}

async function exerciseInput(context: Context, captureId: string): Promise<void> {
  const { harness, recorder, setup, layout } = context;
  const computer = computerOf(context);
  const [primary] = layout.displays;
  check(primary !== undefined, "fixture layout has no display");
  const before = recorded(setup.recorder).length;
  const click = await run(
    computer.pointer({ kind: "click", captureId, x: 40, y: 30, button: "left", count: 1 }),
  );
  check(click.status === "ok", `pointer click answered ${JSON.stringify(click)}`);
  const key = await run(
    computer.key({ captureId, key: "Enter", action: "press", modifiers: { shift: true } }),
  );
  check(key.status === "ok", `key press answered ${JSON.stringify(key)}`);
  const text = await run(computer.text({ captureId, text: "conformance ok" }));
  check(text.status === "ok", `text answered ${JSON.stringify(text)}`);
  const events = recorded(setup.recorder).slice(before);
  const expected: RecordedEvent[] = [
    { event: "move", x: primary.x + 40, y: primary.y + 30 },
    { event: "button", button: "left", down: true },
    { event: "button", button: "left", down: false },
    { event: "key", key: "Shift", down: true },
    { event: "key", key: "Enter", down: true },
    { event: "key", key: "Enter", down: false },
    { event: "key", key: "Shift", down: false },
    { event: "text", text: "conformance ok" },
  ];
  check(
    JSON.stringify(events) === JSON.stringify(expected),
    `input recorder ${JSON.stringify(events)}`,
  );
  const methods = recorder.captured.map((entry) => entry.method);
  check(
    methods.join(",") ===
      [
        Machine.WireMethod.InputPointer,
        Machine.WireMethod.InputKey,
        Machine.WireMethod.InputText,
      ].join(","),
    `captured tool.pre calls ${methods.join(",")}`,
  );
  harness.record(
    `input pointer/key/text captured as tool.pre [${methods.join(", ")}] and recorded ${events.length} events by the built client into its recorder file`,
  );
  recorder.allow = false;
  const denied = await run(computer.pointer({ kind: "move", captureId, x: 1, y: 1 }));
  recorder.allow = true;
  check(
    denied.status === "refused" && denied.reason === "permission_denied",
    `tool.pre denial answered ${JSON.stringify(denied)}`,
  );
  check(recorder.captured.length === 4, `captured ${recorder.captured.length} calls`);
  check(
    recorded(setup.recorder).length === before + events.length,
    "denied input reached the recorder",
  );
  harness.grant(false);
  const revoked = await run(computer.pointer({ kind: "move", captureId, x: 1, y: 1 }));
  const revokedList = await run(computer.list());
  const revokedStream = await run(
    computer.stream.open(streamRequest(primary.id), {
      onSignal: () => undefined,
      onClose: () => undefined,
    }),
  );
  const revokedCdp = await run(
    computer.cdp.open(
      { endpoint: { kind: "discover" }, lifetimeMs: 60_000 },
      { onChunk: () => undefined, onClose: () => undefined },
    ),
  );
  harness.grant(true);
  check(
    revoked.status === "refused" && revoked.reason === "permission_denied",
    `revoked pointer answered ${JSON.stringify(revoked)}`,
  );
  check(
    revokedList.status === "refused" && revokedList.reason === "permission_denied",
    "revoked list was not refused",
  );
  check(
    !("streamId" in revokedStream) && revokedStream.reason === "permission_denied",
    "revoked stream was not refused",
  );
  check(
    !("channelId" in revokedCdp) && revokedCdp.reason === "cdp_not_available",
    "revoked cdp was not refused",
  );
  const capturedAfterRevoke: readonly MachineInputCapture[] = recorder.captured;
  check(
    capturedAfterRevoke.length === 5 && capturedAfterRevoke[4]?.method === Machine.WireMethod.InputPointer,
    "revoked input was not captured as tool.pre",
  );
  const fresh = await run(
    computer.capture({
      target: { kind: "display", display: primary.id },
      encoding: { format: "png" },
      maxDimension: 64,
    }),
  );
  check(fresh.status === "ok", "re-granted capture refused");
  const stale = await run(computer.pointer({ kind: "move", captureId, x: 1, y: 1 }));
  check(
    stale.status === "refused" && stale.reason === "stale_capture",
    `stale anchor answered ${JSON.stringify(stale)}`,
  );
  check(
    recorded(setup.recorder).length === before + events.length,
    "refused input reached the recorder",
  );
  harness.record(
    "input refusals: tool.pre denial permission_denied, revoked grant refuses input/list/stream/cdp before the port, stale anchor stale_capture; recorder unchanged",
  );
}

function streamRequest(display: number): Omit<Machine.StreamOpenRequest, "streamId"> {
  return {
    source: { kind: "display", display },
    video: {
      maxFps: 30,
      keyframeIntervalMs: 500,
      maxBitrateBps: 2_000_000,
      maxDimension: 640,
      maxFrameBytes: 1_000_000,
    },
    dataChannel: false,
    lifetimeMs: 120_000,
  };
}

function signalQueue() {
  const seen: Machine.StreamSignalRequest["signal"][] = [];
  const waiters: Array<{ readonly type: string; readonly resolve: () => void }> = [];
  return {
    seen,
    onSignal(signal: Machine.StreamSignalRequest): void {
      seen.push(signal.signal);
      for (const waiter of waiters.filter((entry) => entry.type === signal.signal.type)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    },
    until(type: Machine.StreamSignalRequest["signal"]["type"]): Promise<void> {
      if (seen.some((signal) => signal.type === type)) return Promise.resolve();
      return new Promise((resolve) => waiters.push({ type, resolve }));
    },
  };
}

async function accepted(
  stream: ComputerStream,
  signal: Machine.StreamSignalRequest["signal"],
): Promise<void> {
  const result = await run(stream.signal(signal));
  check(
    result.status === "accepted",
    `stream ${signal.type} signal answered ${JSON.stringify(result)}`,
  );
}

async function exerciseStream(context: Context): Promise<void> {
  const { harness, layout, tap, setup } = context;
  const computer = computerOf(context);
  const [primary] = layout.displays;
  check(primary !== undefined, "fixture layout has no display");
  const viewer = await openViewer();
  try {
    const signals = signalQueue();
    const end = ending();
    const offered = signals.until("end_of_candidates");
    const opened = await run(
      computer.stream.open(streamRequest(primary.id), {
        onSignal: signals.onSignal,
        onClose: end.onClose,
      }),
    );
    check("streamId" in opened, `stream open answered ${JSON.stringify(opened)}`);
    await harness.within(offered, "stream offer and candidates");
    const offer = signals.seen.find((signal) => signal.type === "offer");
    check(offer?.type === "offer", "no offer signal");
    const local = signals.seen.flatMap((signal) =>
      signal.type === "candidate" ? [signal.candidate] : [],
    );
    for (const line of local) await viewer.candidate(line);
    const answer = await harness.within(viewer.answer(offer.sdp), "viewer answer");
    await accepted(opened, { type: "answer", sdp: answer.sdp });
    // The viewer's candidates are relayed unchanged: an mDNS `.local` one is
    // skipped by the client, which learns the viewer from its checks.
    const mdns = answer.candidates.filter((candidate) => / [^ ]+\.local /.test(candidate.candidate)).length;
    for (const candidate of answer.candidates) {
      await accepted(opened, {
        type: "candidate",
        candidate: candidate.candidate,
        ...(candidate.sdpMid === undefined ? {} : { sdpMid: candidate.sdpMid }),
      });
    }
    await accepted(opened, { type: "end_of_candidates" });
    harness.record(
      `stream ${opened.streamId} negotiated: offer ${offer.sdp.length} chars with H264=${/H264/i.test(offer.sdp)}, ${local.length} client and ${answer.candidates.length} viewer ICE candidates relayed unchanged (${mdns} mDNS), answer accepted`,
    );
    const report = tap.next(
      (entry) =>
        entry.streams?.some((stream) => stream.streamId === opened.streamId && stream.fps > 0) ===
        true,
    );
    const frames = await harness.within(
      viewer.until(STREAM_FRAMES, STREAM_KEYFRAMES),
      "encoded stream frames",
    );
    check(
      ANNEX_B.every((byte, index) => frames.head[index] === byte),
      `first keyframe head ${frames.head.join(",")}`,
    );
    harness.record(
      `stream media: viewer received ${frames.count} encoded H.264 frames (${frames.keys} keyframes, ${frames.bytes} B, connection ${frames.connection}), first keyframe starts ${frames.head.map((byte) => byte.toString(16).padStart(2, "0")).join(" ")}`,
    );
    const observed = await harness.within(report, "machine.report carrying the stream");
    const stream = observed.streams?.find((entry) => entry.streamId === opened.streamId);
    check(stream !== undefined, "report lost the stream");
    const metrics = readFileSync(join(setup.directory, "metrics.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => MetricsLine.parse(JSON.parse(line)))
      .find((line) => line.at === observed.reportedAt);
    check(metrics !== undefined, `metrics.jsonl has no line at ${observed.reportedAt}`);
    check(
      metrics.retainedStreamBytes > 0 &&
        metrics.streamFps === stream.fps &&
        metrics.streamDroppedFrames === stream.droppedFrames,
      `metrics.jsonl ${JSON.stringify(metrics)} vs report ${JSON.stringify(stream)}`,
    );
    harness.record(
      `machine.report stream fps=${stream.fps} bytesPerSecond=${stream.bytesPerSecond} encodeMs=${stream.encodeMs} dropped=${stream.droppedFrames} retainedBytes=${stream.retainedBytes}; metrics.jsonl retainedStreamBytes=${metrics.retainedStreamBytes} streamFps=${metrics.streamFps}`,
    );
    const closed = await run(opened.close());
    check(closed.status === "closed", `stream close answered ${closed.status}`);
    const reason = await harness.within(end.ended, "stream close");
    check(reason === "requested", `stream ended ${reason}`);
  } finally {
    viewer.close();
  }
}

function chunkQueue() {
  const received: Buffer[] = [];
  let waiter: { readonly bytes: number; readonly resolve: () => void } | undefined;
  const total = () => received.reduce((sum, chunk) => sum + chunk.length, 0);
  return {
    onChunk(data: Uint8Array): void {
      received.push(Buffer.from(data));
      if (waiter !== undefined && total() >= waiter.bytes) waiter.resolve();
    },
    until(bytes: number): Promise<Buffer> {
      const done = new Promise<void>((resolve) => {
        waiter = { bytes, resolve };
        if (total() >= bytes) resolve();
      });
      return done.then(() => Buffer.concat(received));
    },
  };
}

async function exerciseCdp(context: Context): Promise<void> {
  const { harness, devtools } = context;
  const computer = computerOf(context);
  const chunks = chunkQueue();
  const end = ending();
  const opened = await run(
    computer.cdp.open(
      { endpoint: { kind: "discover" }, lifetimeMs: 60_000 },
      { onChunk: chunks.onChunk, onClose: end.onClose },
    ),
  );
  check("channelId" in opened, `cdp open answered ${JSON.stringify(opened)}`);
  const payload = Buffer.concat([randomBytes(Machine.CDP_CHUNK_MAX_BYTES), randomBytes(1_000)]);
  const echoed = chunks.until(payload.length);
  for (const part of [
    payload.subarray(0, Machine.CDP_CHUNK_MAX_BYTES),
    payload.subarray(Machine.CDP_CHUNK_MAX_BYTES),
  ]) {
    const sent = await run(opened.send(part));
    check(sent.status === "accepted", `cdp chunk answered ${JSON.stringify(sent)}`);
  }
  const back = await harness.within(echoed, "cdp echo");
  check(back.equals(payload), "cdp echo differs from the bytes sent");
  const oversized = await run(
    Effect.result(opened.send(randomBytes(Machine.CDP_CHUNK_MAX_BYTES + 1))),
  );
  check(Result.isFailure(oversized), "an oversize cdp chunk was sent");
  const oversize = oversized.failure._tag;
  const unknown = await run(
    computer.cdp.open(
      { endpoint: { kind: "launch", manifest: "absent" }, lifetimeMs: 60_000 },
      { onChunk: () => undefined, onClose: () => undefined },
    ),
  );
  check(
    !("channelId" in unknown) && unknown.reason === "manifest_not_found",
    `unknown launch answered ${JSON.stringify(unknown)}`,
  );
  const closed = await run(opened.close());
  check(closed.status === "closed", `cdp close answered ${closed.status}`);
  check(
    (await harness.within(end.ended, "cdp close")) === "requested",
    "cdp channel did not end requested",
  );
  check(
    devtools.requests[0]?.startsWith("GET /json/version ") === true &&
      devtools.requests[1]?.startsWith("GET /devtools/browser/conformance ") === true,
    `fake devtools saw ${JSON.stringify(devtools.requests)}`,
  );
  harness.record(
    `cdp discover via /json/version then upgrade; ${payload.length} opaque bytes echoed in 2 bounded chunks; oversize chunk refused ${oversize}; unknown launch manifest_not_found; closed requested`,
  );
}

async function exerciseOverflowAndRelease(context: Context): Promise<void> {
  const { harness, layout } = context;
  const computer = computerOf(context);
  const [primary] = layout.displays;
  check(primary !== undefined, "fixture layout has no display");
  const ends: Promise<RelayEnd>[] = [];
  const streams: ComputerStream[] = [];
  for (let index = 0; index < Machine.STREAM_MAX_CONCURRENT; index += 1) {
    const end = ending();
    ends.push(end.ended);
    const opened = await run(
      computer.stream.open(streamRequest(primary.id), {
        onSignal: () => undefined,
        onClose: end.onClose,
      }),
    );
    check("streamId" in opened, `stream ${index} answered ${JSON.stringify(opened)}`);
    streams.push(opened);
  }
  const overflow = await run(
    computer.stream.open(streamRequest(primary.id), {
      onSignal: () => undefined,
      onClose: () => undefined,
    }),
  );
  check(
    !("streamId" in overflow) && overflow.reason === "stream_limit",
    `fifth stream answered ${JSON.stringify(overflow)}`,
  );
  const channels: ComputerChannel[] = [];
  for (let index = 0; index < 4; index += 1) {
    const end = ending();
    ends.push(end.ended);
    const opened = await run(
      computer.cdp.open(
        { endpoint: { kind: "discover" }, lifetimeMs: 60_000 },
        { onChunk: () => undefined, onClose: end.onClose },
      ),
    );
    check("channelId" in opened, `channel ${index} answered ${JSON.stringify(opened)}`);
    channels.push(opened);
  }
  const channelOverflow = await run(
    computer.cdp.open(
      { endpoint: { kind: "discover" }, lifetimeMs: 60_000 },
      { onChunk: () => undefined, onClose: () => undefined },
    ),
  );
  check(
    !("channelId" in channelOverflow) && channelOverflow.reason === "channel_limit",
    `fifth channel answered ${JSON.stringify(channelOverflow)}`,
  );
  harness.record(
    `overflow: ${Machine.STREAM_MAX_CONCURRENT} streams open, fifth refused stream_limit; 4 cdp channels open, fifth refused channel_limit`,
  );
  await harness.stop();
  const reasons = await harness.within(Promise.all(ends), "relay release on detach");
  check(
    reasons.every((reason) => reason === "detached"),
    `relays ended ${reasons.join(",")}`,
  );
  const [first] = streams;
  const [channel] = channels;
  check(first !== undefined && channel !== undefined, "no relay opened");
  const late = await run(first.signal({ type: "end_of_candidates" }));
  check(
    late.status === "refused" && late.reason === "machine_not_attached",
    `signal after detach answered ${JSON.stringify(late)}`,
  );
  const lateChunk = await run(channel.send(Buffer.from("late")));
  check(
    lateChunk.status === "refused" && lateChunk.reason === "machine_not_attached",
    `chunk after detach answered ${JSON.stringify(lateChunk)}`,
  );
  await harness.attach();
  const again = computerOf(context);
  const reopened = await run(
    again.stream.open(streamRequest(primary.id), {
      onSignal: () => undefined,
      onClose: () => undefined,
    }),
  );
  check("streamId" in reopened, `stream after reconnect answered ${JSON.stringify(reopened)}`);
  const rechannel = await run(
    again.cdp.open(
      { endpoint: { kind: "discover" }, lifetimeMs: 60_000 },
      { onChunk: () => undefined, onClose: () => undefined },
    ),
  );
  check("channelId" in rechannel, `channel after reconnect answered ${JSON.stringify(rechannel)}`);
  check((await run(reopened.close())).status === "closed", "reopened stream close refused");
  check((await run(rechannel.close())).status === "closed", "reopened channel close refused");
  harness.record(
    `detach released ${reasons.length} relays (all "detached"); late signal/chunk refused machine_not_attached; reconnect opened a fresh stream and channel`,
  );
}

export async function exerciseComputer(
  harness: ComputerHarness,
  host: MachineHost,
  machineId: string,
  setup: ComputerSetup,
  recorder: InputRecorder,
): Promise<void> {
  const { layout, tap, devtools } = prepareComputer(setup);
  try {
    await harness.attach();
    const [info] = host.list();
    const offered = ["screen.read", Machine.WellKnownCapability.computerUse, "input.write"];
    check(
      offered.every((capability) => info?.capabilities.includes(capability) === true),
      `fixture attach capabilities ${info?.capabilities.join(",")}`,
    );
    harness.record(`fixture client.json computer block: attach offered ${offered.join(", ")}`);
    const context: Context = { harness, host, machineId, layout, tap, devtools, recorder, setup };
    const anchor = await exerciseScreen(context);
    await exerciseInput(context, anchor);
    await exerciseStream(context);
    await exerciseCdp(context);
    await exerciseOverflowAndRelease(context);
  } finally {
    tap.stop();
    devtools.stop();
  }
}
