import { expect, test } from "bun:test";
import { type Ipc, Machine } from "@oni/protocol";
import { Effect } from "effect";
import type { MachineInputCapture, RelayEnd } from "@oni/machines";
import { createMachineHost } from "../../../machines/test/helpers/native";
import { eventCollector } from "../../../machines/test/helpers/events";
import { socketPath } from "../../../machines/test/helpers/socket-path";
import { run } from "../../../machines/test/ipc/helpers/effects";
import { connectIpcClient } from "../../../machines/test/ipc/helpers/native";
import { CodemodeError, createCodemode } from "./helpers/native";

const COMPUTER = Machine.WellKnownCapability.computerUse;
type Responder = (params: Ipc.Request["params"]) => Ipc.Response["result"];
const opened = (field: "streamId" | "channelId"): Responder => (params) =>
  ({ status: "opened", [field]: (params as Record<string, string>)[field] ?? "", expiresAt: 5000 });
const accepted: Responder = (params) => ({ status: "accepted", seq: (params as { seq: number }).seq });
const script: Record<string, Responder> = {
  [Machine.WireMethod.ScreenList]: () => ({ status: "ok", displays: [{ display: 1, width: 4, height: 4, scale: 1, primary: true }], windows: [], truncated: false, observedAt: 7 }),
  [Machine.WireMethod.ScreenCapture]: () => ({ status: "ok", captureId: "cap-1", display: 1, format: "png", data: Buffer.from("png").toString("base64"), width: 4, height: 4, downscaled: false, observedAt: 8 }),
  [Machine.WireMethod.InputPointer]: () => ({ status: "ok" }),
  [Machine.WireMethod.InputKey]: () => ({ status: "ok" }),
  [Machine.WireMethod.InputText]: () => ({ status: "ok" }),
  [Machine.WireMethod.ScreenObserve]: () => ({ status: "refused", reason: "window_not_found" }),
  [Machine.WireMethod.InputAction]: () => ({ status: "ok" }),
  [Machine.WireMethod.StreamOpen]: opened("streamId"),
  [Machine.WireMethod.StreamSignal]: accepted,
  [Machine.WireMethod.StreamClose]: (params) => ({ status: "closed", streamId: (params as { streamId: string }).streamId }),
  [Machine.WireMethod.CdpOpen]: opened("channelId"),
  [Machine.WireMethod.CdpChunk]: accepted,
  [Machine.WireMethod.CdpClose]: (params) => ({ status: "closed", channelId: (params as { channelId: string }).channelId }),
};
const streamRequest = {
  source: { kind: "display", display: 1 },
  video: { maxFps: 30, keyframeIntervalMs: 2000, maxBitrateBps: 1_000_000, maxDimension: 1280, maxFrameBytes: 65_536 },
  dataChannel: false, lifetimeMs: 60_000,
} as const;

/** A real host, a scripted client peer offering computer.use, and code mode over the host. */
async function fixture(run: (context: { mode: ReturnType<typeof createCodemode>; received: string[]; captured: MachineInputCapture[] }) => Promise<void>, options: { stripComputer?: boolean } = {}) {
  const events = eventCollector();
  const captured: MachineInputCapture[] = [];
  let ids = 0;
  const host = await createMachineHost({
    events: events.sink, now: () => 100, listen: { unix: socketPath() },
    id: () => { ids += 1; return `relay-${ids}`; },
    enrollment: (machineId) => ({ machineId, name: machineId, allowedCapabilities: [COMPUTER], publicKey: "0".repeat(64), enrolledAt: 0 }),
    captureInput: (request, forward) => { captured.push(request); return forward; },
  });
  const received: string[] = [];
  const client = await connectIpcClient(host.endpoints.unix ?? "", {
    onRequest: (method, params, respond) => { received.push(method); respond(script[method]?.(params) ?? null); },
  });
  const attached = events.next(Machine.Events.Attached.name);
  await client.call(Machine.WireMethod.Attach, {
    machineId: "desk", daemonVersion: "test", platform: "darwin-arm64", offeredAt: 0,
    peer: { kind: "client", contractVersion: 3 }, offeredCapabilities: [COMPUTER],
  });
  await attached;
  const mode = createCodemode({ machines: options.stripComputer
    ? { list: host.list, place: host.place, get: (id) => { const handle = host.get(id); return { ...handle, native: { ...handle.native, computer: undefined } }; } }
    : host });
  try { await run({ mode, received, captured }); }
  finally { await mode.close(); await client.close(); await host.close(); }
}

test("the code-mode handle reaches screen and input under the wire op names, input still captured", async () => {
  await fixture(async ({ mode, received, captured }) => {
    const computer = mode.native.getMachine("desk").computer;
    expect((await run(computer.screen.list())).status).toBe("ok");
    const shot = await run(computer.screen.capture({ target: { kind: "display", display: 1 }, encoding: { format: "png" } }));
    if (shot.status !== "ok") throw new Error(`capture refused: ${shot.reason}`);
    expect(shot.data.toString("utf8")).toBe("png");
    expect(await run(computer.input.pointer({ kind: "move", at: { captureId: "cap-1", x: 1, y: 1 } }))).toEqual({ status: "ok" });
    expect(await run(computer.input.key({ captureId: "cap-1", key: "a", action: "press" }))).toEqual({ status: "ok" });
    expect(await run(computer.input.text({ captureId: "cap-1", text: "hi" }))).toEqual({ status: "ok" });
    expect(await run(computer.screen.observe({ target: { pid: 42, windowId: 7 }, screenshot: false }))).toEqual({ status: "refused", reason: "window_not_found" });
    expect(await run(computer.input.action({ observationId: "o1", target: { pid: 42, windowId: 7, epoch: 0 }, ref: "AXButton[0]", action: "press" }))).toEqual({ status: "ok" });
    const sent = [Machine.WireMethod.InputPointer, Machine.WireMethod.InputKey, Machine.WireMethod.InputText, Machine.WireMethod.ScreenObserve, Machine.WireMethod.InputAction];
    expect(captured.map((entry) => entry.method)).toEqual(sent);
    expect(received).toEqual([Machine.WireMethod.ScreenList, Machine.WireMethod.ScreenCapture, ...sent]);
  });
});

test("stream and debugging-channel handles open, signal or send, and close through code mode", async () => {
  await fixture(async ({ mode, received }) => {
    const computer = mode.native.getMachine("desk").computer;
    const ends: RelayEnd[] = [];
    const stream = await run(computer.stream.open(streamRequest, { onSignal: () => undefined, onClose: (reason) => ends.push(reason) }));
    if ("status" in stream) throw new Error(`stream refused: ${stream.reason}`);
    expect(stream.streamId).toBe("relay-1");
    expect(await run(stream.signal({ type: "answer", sdp: "v=0" }))).toEqual({ status: "accepted", seq: 0 });
    expect(await run(stream.close())).toEqual({ status: "closed", streamId: "relay-1" });
    const channel = await run(computer.cdp.open({ endpoint: { kind: "discover" }, lifetimeMs: 60_000 }, { onChunk: () => undefined, onClose: (reason) => ends.push(reason) }));
    if ("status" in channel) throw new Error(`channel refused: ${channel.reason}`);
    expect(await run(channel.send(Buffer.from("{}")))).toEqual({ status: "accepted", seq: 0 });
    expect(await run(channel.close())).toEqual({ status: "closed", channelId: channel.channelId });
    expect(received.slice(-6)).toEqual([
      Machine.WireMethod.StreamOpen, Machine.WireMethod.StreamSignal, Machine.WireMethod.StreamClose,
      Machine.WireMethod.CdpOpen, Machine.WireMethod.CdpChunk, Machine.WireMethod.CdpClose,
    ]);
  });
});

test("an unknown lease fences a computer call before it reaches the peer", async () => {
  await fixture(async ({ mode, received }) => {
    const fenced = await run(Effect.flip(mode.native.getMachine("desk", "gone").computer.screen.list()));
    expect(fenced).toBeInstanceOf(CodemodeError);
    expect(fenced).toMatchObject({ reason: "lease_expired" });
    expect(received).not.toContain(Machine.WireMethod.ScreenList);
  });
});

test("a machine handle without a computer surface fails typed", async () => {
  await fixture(async ({ mode, received }) => {
    const failure = await run(Effect.flip(mode.native.getMachine("desk").computer.cdp.open({ endpoint: { kind: "discover" }, lifetimeMs: 1 }, { onChunk: () => undefined, onClose: () => undefined })));
    expect(failure).toBeInstanceOf(CodemodeError);
    expect(failure).toMatchObject({ reason: "computer_not_bound", message: "machine desk exposes no computer surface" });
    expect(received).toEqual([]);
  }, { stripComputer: true });
});
