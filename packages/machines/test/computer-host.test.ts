import { expect, test } from "bun:test";
import { type Ipc, Machine } from "@oni/protocol";
import { Effect, Fiber } from "effect";
import { createMemoryGenerationStore, type AttachGenerationStore, type ChannelListeners, type ComputerHandle, type MachineError, type MachineInputCapture, type RelayEnd, type StreamListeners } from "../src";
import { createMachineHost } from "./helpers/native";
import { eventCollector } from "./helpers/events";
import { socketPath } from "./helpers/socket-path";
import { run } from "./ipc/helpers/effects";
import { connectIpcClient } from "./ipc/helpers/native";

const COMPUTER = Machine.WellKnownCapability.computerUse;
type Responder = (params: Ipc.Request["params"]) => Ipc.Response["result"] | undefined;
type Capture = NonNullable<Parameters<typeof createMachineHost>[0]["captureInput"]>;

const offerOf = (capabilities: readonly string[], generation?: number, contractVersion = 3) => ({
  machineId: "desk", daemonVersion: "test", platform: "darwin-arm64", offeredAt: 0,
  peer: { kind: "client", contractVersion }, offeredCapabilities: [...capabilities],
  ...(generation === undefined ? {} : { generation }),
});
const pointer: Parameters<ComputerHandle["pointer"]>[0] = { delivery: "foreground", kind: "click", at: { captureId: "cap-1", x: 10, y: 20 }, button: "left", count: 1 };
const streamRequest = {
  source: { kind: "display", display: 1 },
  video: { maxFps: 30, keyframeIntervalMs: 2000, maxBitrateBps: 1_000_000, maxDimension: 1280, maxFrameBytes: 65_536 },
  dataChannel: true, lifetimeMs: 60_000,
} as const;
const channelRequest = { endpoint: { kind: "discover" }, lifetimeMs: 60_000 } as const;

async function fixture(options: { grants?: string[]; captureInput?: Capture | "absent"; generations?: AttachGenerationStore } = {}) {
  const events = eventCollector();
  const grants = { allowed: options.grants ?? [COMPUTER] };
  let clock = 100;
  let ids = 0;
  const host = await createMachineHost({
    events: events.sink, now: () => clock, listen: { unix: socketPath() },
    ...(options.generations === undefined ? {} : { generations: options.generations }),
    id: () => { ids += 1; return `relay-${ids}`; },
    enrollment: (machineId) => ({ machineId, name: machineId, allowedCapabilities: grants.allowed, publicKey: "0".repeat(64), enrolledAt: 0 }),
    ...(options.captureInput === "absent" ? {} : { captureInput: options.captureInput ?? ((_request, forward) => forward) }),
  });
  const peers: Array<Awaited<ReturnType<typeof connectIpcClient>>> = [];
  async function peer(capabilities: readonly string[], script: Partial<Record<string, Responder>> = {}, generation?: number, contractVersion?: number) {
    const received: Array<{ method: string; params: Ipc.Request["params"] }> = [];
    const closed = Promise.withResolvers<void>();
    const client = await connectIpcClient(host.endpoints.unix ?? "", {
      onDisconnect: () => closed.resolve(),
      onRequest: (method, params, respond) => {
        received.push({ method, params });
        const answer = script[method]?.(params);
        if (answer !== undefined) respond(answer);
      },
    });
    peers.push(client);
    const attached = events.next(Machine.Events.Attached.name);
    const result = Machine.AttachResult.parse(await client.call(Machine.WireMethod.Attach, offerOf(capabilities, generation, contractVersion)));
    if (result.status !== "attached") throw new Error(`attach refused: ${result.reason}`);
    await attached;
    return { client, received, closed: closed.promise, generation: result.generation };
  }
  return {
    host, events, grants, peer,
    machine: () => {
      const computer = host.native.get("desk").computer;
      if (computer === undefined) throw new Error("host handle carries no computer surface");
      return computer;
    },
    setClock(at: number) { clock = at; },
    async close() { for (const client of peers) await client.close(); await host.close(); },
  };
}

function streamListeners() {
  const signals: Machine.StreamSignalRequest[] = [];
  const ends: RelayEnd[] = [];
  const ended = Promise.withResolvers<RelayEnd>();
  const listeners: StreamListeners = { onSignal: (signal) => signals.push(signal), onClose: (reason) => { ends.push(reason); ended.resolve(reason); } };
  return { listeners, signals, ends, ended: ended.promise };
}
function channelListeners() {
  const chunks: string[] = [];
  const ends: RelayEnd[] = [];
  const ended = Promise.withResolvers<RelayEnd>();
  const listeners: ChannelListeners = { onChunk: (data) => chunks.push(Buffer.from(data).toString("utf8")), onClose: (reason) => { ends.push(reason); ended.resolve(reason); } };
  return { listeners, chunks, ends, ended: ended.promise };
}
const opened = (field: "streamId" | "channelId"): Responder => (params) =>
  ({ status: "opened", [field]: (params as Record<string, string>)[field] ?? "", expiresAt: 5000 });
const accepted: Responder = (params) => ({ status: "accepted", seq: (params as { seq: number }).seq });
const observeRequest: Machine.ScreenObserveRequest = { target: { pid: 42, windowId: 7 }, screenshot: false };
const actionRequest: Omit<Machine.InputActionRequest, "requestId"> = { observationId: "o1", target: { pid: 42, windowId: 7, epoch: 0 }, ref: "AXButton[0]", action: "press" };
const observed: Machine.ScreenObserveResult = {
  status: "ok", observationId: "o1", lineage: "w42-7-0", target: { pid: 42, windowId: 7, epoch: 0 },
  window: { pid: 42, windowId: 7, epoch: 0, title: "Notes", app: { bundleId: null, path: "/Applications/Notes.app" } }, complete: true, private: false, elements: [],
};
const observationScript = {
  [Machine.WireMethod.ScreenObserve]: () => observed,
  [Machine.WireMethod.InputAction]: () => ({ status: "refused", reason: "epoch_changed" }),
};
const observations = <E extends { readonly method: string }>(received: readonly E[]) => received.filter((entry) => entry.method === Machine.WireMethod.ScreenObserve || entry.method === Machine.WireMethod.InputAction);
const inputs = <E extends { readonly method: string }>(received: readonly E[]) => received.filter((entry) => entry.method.startsWith("machine.input."));

test("clipboard requests cross the captured gate with typed content-free write receipts", async () => {
  const calls: MachineInputCapture[] = [];
  const f = await fixture({ captureInput: (request, forward) => {
    calls.push(request);
    return forward;
  } });
  try {
    const desk = await f.peer([COMPUTER], {
      [Machine.WireMethod.ClipboardRead]: () => ({ status: "ok", text: "copied", changeCount: 4 }),
      [Machine.WireMethod.ClipboardWrite]: () => ({
        status: "ok", changeCount: 5,
        previous: { changeCount: 4, formats: ["public.utf8-plain-text"], bytes: 6 },
      }),
    });
    expect(await run(f.machine().clipboard.read({ formats: ["text"] }))).toEqual({ status: "ok", text: "copied", changeCount: 4 });
    expect(await run(f.machine().clipboard.write({ text: "agent" }))).toEqual({
      status: "ok", changeCount: 5,
      previous: { changeCount: 4, formats: ["public.utf8-plain-text"], bytes: 6 },
    });
    expect(calls.map((request) => request.method)).toEqual([Machine.WireMethod.ClipboardRead, Machine.WireMethod.ClipboardWrite]);
    expect(desk.received.map((request) => request.method)).toContain(Machine.WireMethod.ClipboardWrite);
  } finally { await f.close(); }
});

test("computer close cancels an in-flight action without detaching unrelated machine work", async () => {
  const entered = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<Machine.ComputerCloseRequest>();
  const f = await fixture();
  try {
    const desk = await f.peer([COMPUTER], {
      [Machine.WireMethod.InputAction]: () => { entered.resolve(); return undefined; },
      [Machine.WireMethod.ComputerClose]: (params) => {
        closed.resolve(Machine.ComputerCloseRequest.parse(params));
        return { status: "closed" };
      },
    });
    const running = run(f.machine().action(actionRequest));
    await entered.promise;
    f.host.native.computer.close("desk");
    expect(await running).toEqual({ status: "unverifiable", reason: "cancelled", dispatched: "unknown", hint: "re_observe" });
    expect(await closed.promise).toEqual({ generation: 1, through: 2 });
    expect(f.host.list()).toHaveLength(1);
    expect(await desk.client.call(Machine.WireMethod.Report, {
      machineId: "desk", reportedAt: 100, load: { loadAvg1: 0, memoryAvailableBytes: 1024, inFlight: 0 },
    })).toEqual({ status: "accepted" });
    f.host.native.computer.close("missing");
  } finally { await f.close(); }
}, 5000);

test("a refused computer cancellation disconnects the peer to fence native input", async () => {
  const f = await fixture();
  try {
    const desk = await f.peer([COMPUTER], {
      [Machine.WireMethod.ComputerClose]: () => ({ status: "refused", reason: "unsupported" }),
    });
    f.host.native.computer.close("desk");
    await desk.closed;
    expect(f.host.list()).toEqual([]);
  } finally { await f.close(); }
}, 5000);

test("screen listing and observation bind the next capture port call to the owning app", async () => {
  const captured: MachineInputCapture[] = [];
  const f = await fixture({ captureInput: (request, forward) => { captured.push(request); return forward; } });
  try {
    const desk = await f.peer([COMPUTER], {
      [Machine.WireMethod.ScreenList]: () => ({
        status: "ok", displays: [{ display: 1, width: 800, height: 600, scale: 1, primary: true }],
        windows: [{ windowId: "7", pid: 42, app: { bundleId: null, path: "/Applications/Notes.app" },
          display: 1, title: "Notes", owner: "Notes", bounds: { x: 0, y: 0, width: 400, height: 300 } }],
        observedAt: 100, truncated: false,
      }),
      ...observationScript,
    });
    await run(f.machine().list({ windows: true }));
    await run(f.machine().observe(observeRequest));
    await run(f.machine().action(actionRequest));
    expect(captured.map((call) => call.binding)).toEqual([
      { pid: 42, windowId: 7, app: { bundleId: null, path: "/Applications/Notes.app" } },
      { pid: 42, windowId: 7, epoch: 0, app: { bundleId: null, path: "/Applications/Notes.app" } },
    ]);
    await desk.client.call(Machine.WireMethod.Report, {
      machineId: "desk", reportedAt: 100, load: { loadAvg1: 0, memoryAvailableBytes: 1024, inFlight: 0 },
    });
    expect(f.host.list()[0]?.live?.windows).toEqual({
      "42:7": { pid: 42, windowId: 7, epoch: 0, app: { bundleId: null, path: "/Applications/Notes.app" } },
    });
  } finally { await f.close(); }
});

test("an offer alone never grants computer use: the enrollment must grant it too", async () => {
  const f = await fixture({ grants: [Machine.WellKnownCapability.fsRead] });
  try {
    const desk = await f.peer([COMPUTER]);
    const computer = f.machine();
    expect(await run(computer.list())).toEqual({ status: "refused", reason: "permission_denied" });
    expect(await run(computer.capture({ target: { kind: "display", display: 1 }, encoding: { format: "png" } }))).toEqual({ status: "refused", reason: "permission_denied" });
    expect(await run(computer.pointer(pointer))).toEqual({ status: "refused", reason: "permission_denied" });
    expect(await run(computer.stream.open(streamRequest, streamListeners().listeners))).toEqual({ status: "refused", reason: "permission_denied" });
    expect(await run(computer.cdp.open(channelRequest, channelListeners().listeners))).toEqual({ status: "refused", reason: "cdp_not_available", message: "computer.use is not granted" });
    expect(desk.received).toEqual([]);
  } finally { await f.close(); }
});

test("private focus edges publish only from the attached machine identity", async () => {
  const f = await fixture();
  const desk = await f.peer([COMPUTER]);
  try {
    const edge = f.events.next(Machine.Events.Private.name);
    expect(await desk.client.call(Machine.WireMethod.EventPrivate, {
      machineId: "desk", target: { pid: 42, windowId: 7, epoch: 0 }, state: "entered",
    })).toEqual({ status: "accepted" });
    expect(await edge).toEqual({
      name: Machine.Events.Private.name,
      payload: { machineId: "desk", time: 100, target: { pid: 42, windowId: 7, epoch: 0 }, state: "entered" },
    });
    expect(await desk.client.call(Machine.WireMethod.EventPrivate, {
      machineId: "other", target: { pid: 42, windowId: 7, epoch: 0 }, state: "left",
    })).toEqual({ status: "refused", reason: "machine_mismatch" });
  } finally {
    await f.close();
  }
});

test("a version 2 peer cannot report an active stream without a private fact", async () => {
  const f = await fixture();
  const client = await connectIpcClient(f.host.endpoints.unix ?? "");
  try {
    expect(await client.call(Machine.WireMethod.Attach, offerOf([COMPUTER], undefined, 2)))
      .toEqual({ status: "refused", reason: "unsupported_contract" });
    const report = {
      machineId: "desk", reportedAt: 100,
      load: { loadAvg1: 0, memoryAvailableBytes: 1024, inFlight: 0 },
      streams: [{ streamId: "legacy", fps: 1, bytesPerSecond: 64, encodeMs: 1,
        droppedFrames: 0, retainedBytes: 256 }],
    };
    expect(Machine.Report.safeParse(report).success).toBe(false);
    expect(await client.call(Machine.WireMethod.Report, report))
      .toEqual({ status: "refused", reason: "machine_not_attached" });
    expect(f.host.native.list()).toEqual([]);
  } finally {
    await client.close();
    await f.close();
  }
});

test("an enrolled grant without an available display refuses every surface as not available", async () => {
  const f = await fixture();
  try {
    const desk = await f.peer([]);
    const computer = f.machine();
    expect(await run(computer.list({ windows: true }))).toEqual({ status: "refused", reason: "screen_not_available" });
    expect(await run(computer.capture({ target: { kind: "window", windowId: "w1" }, encoding: { format: "png" } }))).toEqual({ status: "refused", reason: "screen_not_available" });
    expect(await run(computer.key({ captureId: "cap-1", key: "a", action: "press" }))).toEqual({ status: "refused", reason: "input_not_available" });
    expect(await run(computer.stream.open(streamRequest, streamListeners().listeners))).toEqual({ status: "refused", reason: "stream_not_available" });
    expect(await run(computer.cdp.open(channelRequest, channelListeners().listeners))).toEqual({ status: "refused", reason: "cdp_not_available" });
    expect(desk.received).toEqual([]);
  } finally { await f.close(); }
});

test("screen list and capture relay parsed answers, refusals pass through typed", async () => {
  const f = await fixture();
  try {
    const display = { display: 1, width: 1440, height: 900, scale: 2, primary: true };
    const desk = await f.peer([COMPUTER], {
      [Machine.WireMethod.ScreenList]: () => ({ status: "ok", displays: [display], windows: [], truncated: false, observedAt: 7 }),
      [Machine.WireMethod.ScreenCapture]: (params) => (params as { target: { kind: string } }).target.kind === "window"
        ? { status: "refused", reason: "window_not_found" }
        : { status: "ok", captureId: "cap-9", display: 1, format: "png", data: Buffer.from("png-bytes").toString("base64"), width: 2, height: 1, downscaled: false, observedAt: 8 },
    });
    const computer = f.machine();
    const listed = await run(computer.list());
    expect(listed.status).toBe("ok");
    const shot = await run(computer.capture({ target: { kind: "display", display: 1 }, encoding: { format: "png" } }));
    if (shot.status !== "ok") throw new Error(`capture refused: ${shot.reason}`);
    expect(shot.data.toString("utf8")).toBe("png-bytes");
    expect(shot.captureId).toBe("cap-9");
    expect(await run(computer.capture({ target: { kind: "window", windowId: "gone" }, encoding: { format: "png" } }))).toEqual({ status: "refused", reason: "window_not_found" });
    expect(desk.received.map((entry) => entry.method)).toEqual([Machine.WireMethod.ScreenList, Machine.WireMethod.ScreenCapture, Machine.WireMethod.ScreenCapture]);
  } finally { await f.close(); }
});

test("a capture whose decoded bytes pass the ceiling is refused typed, the ceiling itself relays", async () => {
  const f = await fixture();
  try {
    const sizes = [Machine.SCREEN_PNG_MAX_BYTES + 2, Machine.SCREEN_PNG_MAX_BYTES];
    await f.peer([COMPUTER], {
      [Machine.WireMethod.ScreenCapture]: () => ({ status: "ok", captureId: "cap-1", display: 1, format: "png", data: Buffer.alloc(sizes.shift() ?? 0).toString("base64"), width: 2, height: 1, downscaled: false, observedAt: 8 }),
    });
    const computer = f.machine();
    const request = { target: { kind: "display", display: 1 }, encoding: { format: "png" } } as const;
    expect(await run(computer.capture(request))).toEqual({ status: "refused", reason: "capture_failed", message: `capture exceeds ${Machine.SCREEN_PNG_MAX_BYTES} bytes` });
    const shot = await run(computer.capture(request));
    if (shot.status !== "ok") throw new Error(`capture refused: ${shot.reason}`);
    expect(shot.data.length).toBe(Machine.SCREEN_PNG_MAX_BYTES);
  } finally { await f.close(); }
});

test("typed input forwards only through the capture port and passes refusals through", async () => {
  const captured: MachineInputCapture[] = [];
  const f = await fixture({ captureInput: (request, forward) => { captured.push(request); return forward; } });
  try {
    const desk = await f.peer([COMPUTER], {
      [Machine.WireMethod.InputPointer]: () => ({ status: "ok" }),
      [Machine.WireMethod.InputKey]: () => ({ status: "refused", reason: "stale_capture" }),
      [Machine.WireMethod.InputText]: () => ({ status: "ok" }),
    });
    const computer = f.machine();
    expect(await run(computer.pointer(pointer))).toEqual({ status: "ok" });
    expect(await run(computer.key({ captureId: "old", key: "Return", action: "press", modifiers: { meta: true } }))).toEqual({ status: "refused", reason: "stale_capture" });
    expect(await run(computer.text({ captureId: "cap-1", text: "hello" }))).toEqual({ status: "ok" });
    expect(captured).toEqual([
      { machineId: "desk", generation: 1, method: Machine.WireMethod.InputPointer, params: { ...pointer, requestId: "1-1" } },
      { machineId: "desk", generation: 1, method: Machine.WireMethod.InputKey, params: { requestId: "1-2", delivery: "background", captureId: "old", key: "Return", action: "press", modifiers: { meta: true } } },
      { machineId: "desk", generation: 1, method: Machine.WireMethod.InputText, params: { requestId: "1-3", delivery: "background", captureId: "cap-1", text: "hello" } },
    ]);
    expect(inputs(desk.received).map((entry) => entry.method)).toEqual([Machine.WireMethod.InputPointer, Machine.WireMethod.InputKey, Machine.WireMethod.InputText]);
  } finally { await f.close(); }
});

test("without a capture port no input is sent", async () => {
  const f = await fixture({ captureInput: "absent" });
  try {
    const desk = await f.peer([COMPUTER], { [Machine.WireMethod.InputPointer]: () => ({ status: "ok" }) });
    expect(await run(f.machine().pointer(pointer))).toEqual({ status: "refused", reason: "permission_denied", message: "input requires a captured tool.pre effect" });
    expect(inputs(desk.received)).toEqual([]);
  } finally { await f.close(); }
});

test("a tool.pre rejection sends nothing and surfaces the port's answer", async () => {
  const f = await fixture({ captureInput: () => Effect.succeed({ status: "refused", reason: "permission_denied", message: "tool.pre blocked" }) });
  try {
    const desk = await f.peer([COMPUTER], { [Machine.WireMethod.InputText]: () => ({ status: "ok" }) });
    expect(await run(f.machine().text({ captureId: "cap-1", text: "rm -rf" }))).toEqual({ status: "refused", reason: "permission_denied", message: "tool.pre blocked" });
    expect(inputs(desk.received)).toEqual([]);
  } finally { await f.close(); }
});

test("a grant revoked during capture refuses at forward time and nothing is sent", async () => {
  let revoke = (): void => undefined;
  const f = await fixture({ captureInput: (_request, forward) => Effect.sync(() => revoke()).pipe(Effect.andThen(forward)) });
  try {
    const desk = await f.peer([COMPUTER], { [Machine.WireMethod.InputPointer]: () => ({ status: "ok" }) });
    revoke = () => { f.grants.allowed = []; };
    expect(await run(f.machine().pointer(pointer))).toEqual({ status: "refused", reason: "permission_denied" });
    expect(inputs(desk.received)).toEqual([]);
  } finally { await f.close(); }
});

test("a supersede during capture fails stale_generation and neither attachment receives the input", async () => {
  let reattach = (): Promise<void> => Promise.resolve();
  const f = await fixture({ captureInput: (_request, forward) => Effect.promise(() => reattach()).pipe(Effect.andThen(forward)) });
  try {
    const first = await f.peer([COMPUTER], { [Machine.WireMethod.InputPointer]: () => ({ status: "ok" }) });
    let second: Awaited<ReturnType<typeof f.peer>> | undefined;
    reattach = async () => {
      const detached = f.events.next(Machine.Events.Detached.name);
      second = await f.peer([COMPUTER], { [Machine.WireMethod.InputPointer]: () => ({ status: "ok" }) }, 1);
      expect((await detached).payload).toMatchObject({ machineId: "desk", reason: "superseded" });
    };
    expect(await run(Effect.flip(f.machine().pointer(pointer)))).toMatchObject({ _tag: "MachineRefusalError", reason: "stale_generation" });
    expect(inputs(first.received)).toEqual([]);
    expect(inputs(second?.received ?? [])).toEqual([]);
  } finally { await f.close(); }
});

test("a lost input reply is unverifiable and reconnect queries status without replay", async () => {
  const f = await fixture();
  try {
    const dispatched = Promise.withResolvers<string>();
    const first = await f.peer([COMPUTER], {
      [Machine.WireMethod.InputText]: (params) => {
        const request = Machine.InputTextRequest.parse(params);
        dispatched.resolve(request.requestId);
        return undefined;
      },
    });
    const pending = run(f.machine().text({ captureId: "cap-1", text: "once", delivery: "foreground" }));
    const requestId = await dispatched.promise;
    const detached = f.events.next(Machine.Events.Detached.name);
    await first.client.close();
    await detached;
    expect(await pending).toEqual({ status: "unverifiable", reason: "transport_lost", dispatched: "unknown", hint: "re_observe" });
    const queried = Promise.withResolvers<void>();
    const second = await f.peer([COMPUTER], {
      [Machine.WireMethod.InputStatus]: (params) => {
        expect(params).toEqual({ requestId });
        queried.resolve();
        return { status: "ok", requestId, dispatched: true, state: "completed" };
      },
      [Machine.WireMethod.InputText]: () => ({ status: "ok" }),
    }, 1);
    const reported = f.events.next(Machine.Events.Reported.name);
    expect(await second.client.call(Machine.WireMethod.Report, { machineId: "desk", reportedAt: 1, load: { loadAvg1: 0, memoryAvailableBytes: 0, inFlight: 0 } })).toEqual({ status: "accepted" });
    await reported;
    await queried.promise;
    expect(await run(f.machine().status({ requestId }))).toEqual({ status: "ok", requestId, dispatched: true, state: "completed" });
    expect(second.received.filter((entry) => entry.method === Machine.WireMethod.InputText)).toEqual([]);
    expect(await run(f.machine().text({ captureId: "cap-1", text: "next", delivery: "foreground" }))).toEqual({ status: "ok" });
    expect(first.received.filter((entry) => entry.method === Machine.WireMethod.InputText)).toHaveLength(1);
  } finally { await f.close(); }
});

test("a restarted host advances the saved generation before restarting input sequence", async () => {
  const generations = createMemoryGenerationStore();
  let f = await fixture({ generations });
  try {
    const script = { [Machine.WireMethod.InputPointer]: () => ({ status: "ok" }) };
    const first = await f.peer([COMPUTER], script);
    const g = first.generation;
    expect(await run(f.machine().pointer(pointer))).toEqual({ status: "ok" });
    expect(inputs(first.received)[0]?.params).toMatchObject({ requestId: `${g}-1` });
    await f.close();

    f = await fixture({ generations });
    const reconnected = await f.peer([COMPUTER], script, g);
    expect(reconnected.generation).toBe(g + 1);
    expect(await run(generations.current("desk"))).toBe(g + 1);
    expect(await run(f.machine().pointer(pointer))).toEqual({ status: "ok" });
    expect(inputs(reconnected.received)[0]?.params).toMatchObject({ requestId: `${g + 1}-1` });

    const sameHost = await f.peer([COMPUTER], script, reconnected.generation);
    expect(sameHost.generation).toBe(g + 1);
    expect(await run(f.machine().pointer(pointer))).toEqual({ status: "ok" });
    expect(inputs(sameHost.received)[0]?.params).toMatchObject({ requestId: `${g + 1}-2` });
  } finally { await f.close(); }
});

test("one pending window refuses overlap but does not reserve another window", async () => {
  const captured: MachineInputCapture[] = [];
  const f = await fixture({ captureInput: (request, forward) => { captured.push(request); return forward; } });
  try {
    const sent = Promise.withResolvers<void>();
    const peer = await f.peer([COMPUTER], {
      [Machine.WireMethod.InputKey]: (params) => {
        const request = Machine.InputKeyRequest.parse(params);
        if (request.target?.windowId === 7) { sent.resolve(); return undefined; }
        return { status: "ok" };
      },
    });
    const key = (windowId: number) => ({
      captureId: "cap-1", delivery: "foreground" as const,
      target: { pid: 42, windowId, epoch: 0 }, key: "Enter", action: "press" as const,
    });
    const pending = run(f.machine().key(key(7)));
    await sent.promise;
    expect(await run(f.machine().key(key(7)))).toEqual({ status: "refused", reason: "window_busy" });
    expect(await run(f.machine().key(key(8)))).toEqual({ status: "ok" });
    const detached = f.events.next(Machine.Events.Detached.name);
    await peer.client.close();
    await detached;
    expect(await pending).toEqual({ status: "unverifiable", reason: "transport_lost", dispatched: "unknown", hint: "re_observe" });
    expect(peer.received.filter((entry) => entry.method === Machine.WireMethod.InputKey)).toHaveLength(2);
    expect(captured.map((entry) => "requestId" in entry.params ? entry.params.requestId : null)).toEqual(["1-1", "1-2", "1-3"]);
  } finally { await f.close(); }
});

test("an unknown recovery status cannot release an outstanding input", async () => {
  const f = await fixture();
  try {
    const sent = Promise.withResolvers<string>();
    const first = await f.peer([COMPUTER], {
      [Machine.WireMethod.InputText]: (params) => { sent.resolve(Machine.InputTextRequest.parse(params).requestId); return undefined; },
    });
    const pending = run(f.machine().text({ captureId: "cap-1", text: "once", delivery: "foreground" }));
    const requestId = await sent.promise;
    const detached = f.events.next(Machine.Events.Detached.name);
    await first.client.close();
    await detached;
    expect((await pending).status).toBe("unverifiable");
    const queried = Promise.withResolvers<void>();
    const second = await f.peer([COMPUTER], {
      [Machine.WireMethod.InputStatus]: () => { queried.resolve(); return { status: "refused", reason: "request_unknown" }; },
      [Machine.WireMethod.InputText]: () => ({ status: "ok" }),
    }, 1);
    const reported = f.events.next(Machine.Events.Reported.name);
    await second.client.call(Machine.WireMethod.Report, { machineId: "desk", reportedAt: 1, load: { loadAvg1: 0, memoryAvailableBytes: 0, inFlight: 0 } });
    await reported;
    await queried.promise;
    expect(await run(f.machine().text({ captureId: "cap-1", text: "again", delivery: "foreground" })))
      .toEqual({ status: "refused", reason: "window_busy" });
    expect(inputs(second.received).filter((entry) => entry.method === Machine.WireMethod.InputText)).toEqual([]);
    expect(requestId).toBe("1-1");
  } finally { await f.close(); }
});

test("a malformed input reply retains its reservation after forwarding", async () => {
  const f = await fixture();
  try {
    const desk = await f.peer([COMPUTER], {
      [Machine.WireMethod.InputText]: () => ({ status: "ok", extra: true }),
    });
    const computer = f.machine();
    expect(await run(Effect.flip(computer.text({ captureId: "cap-1", text: "once", delivery: "foreground" }))))
      .toMatchObject({ _tag: "MachinesFailure", operation: "machine.input.text.response" });
    expect(await run(computer.text({ captureId: "cap-1", text: "again", delivery: "foreground" })))
      .toEqual({ status: "refused", reason: "window_busy" });
    expect(inputs(desk.received).filter((entry) => entry.method === Machine.WireMethod.InputText)).toHaveLength(1);
  } finally { await f.close(); }
});

test("interrupting the waiter after peer receipt retains the input reservation", async () => {
  const f = await fixture();
  try {
    const received = Promise.withResolvers<void>();
    const desk = await f.peer([COMPUTER], {
      [Machine.WireMethod.InputText]: () => { received.resolve(); return undefined; },
    });
    await run(Effect.scoped(Effect.gen(function* () {
      const waiter = yield* Effect.forkScoped(f.machine().text({ captureId: "cap-1", text: "once", delivery: "foreground" }));
      yield* Effect.promise(() => received.promise);
      yield* Fiber.interrupt(waiter);
    })));
    expect(await run(f.machine().text({ captureId: "cap-1", text: "again", delivery: "foreground" })))
      .toEqual({ status: "refused", reason: "window_busy" });
    expect(inputs(desk.received).filter((entry) => entry.method === Machine.WireMethod.InputText)).toHaveLength(1);
  } finally { await f.close(); }
});

test("a v3 peer also leaves a lost input uncertain without replay", async () => {
  const f = await fixture();
  try {
    const sent = Promise.withResolvers<Ipc.Request["params"]>();
    const peer = await f.peer([COMPUTER], {
      [Machine.WireMethod.InputText]: (params) => { sent.resolve(params); return undefined; },
    }, undefined, 3);
    const pending = run(f.machine().text({ captureId: "cap-1", text: "once", delivery: "foreground" }));
    expect(await sent.promise).toEqual({ requestId: "1-1", captureId: "cap-1", text: "once", delivery: "foreground" });
    const detached = f.events.next(Machine.Events.Detached.name);
    await peer.client.close();
    await detached;
    expect(await pending).toEqual({ status: "unverifiable", reason: "transport_lost", dispatched: "unknown", hint: "re_observe" });
    expect(peer.received.filter((entry) => entry.method === Machine.WireMethod.InputText)).toHaveLength(1);
  } finally { await f.close(); }
});

test("a disconnect ends open relays and later calls refuse disconnected", async () => {
  const f = await fixture();
  try {
    const desk = await f.peer([COMPUTER], {
      [Machine.WireMethod.StreamOpen]: opened("streamId"),
      [Machine.WireMethod.CdpOpen]: opened("channelId"),
    });
    const computer = f.machine();
    const watch = streamListeners();
    const tap = channelListeners();
    const stream = await run(computer.stream.open(streamRequest, watch.listeners));
    const channel = await run(computer.cdp.open(channelRequest, tap.listeners));
    if (!("signal" in stream) || !("send" in channel)) throw new Error("relays did not open");
    const detached = f.events.next(Machine.Events.Detached.name);
    await desk.client.close();
    expect((await detached).payload).toMatchObject({ machineId: "desk", reason: "connection_closed" });
    expect(await watch.ended).toBe("detached");
    expect(await tap.ended).toBe("detached");
    expect(await run(Effect.flip(computer.pointer(pointer)))).toMatchObject({ reason: "disconnected" });
    expect(await run(Effect.flip(computer.list()))).toMatchObject({ reason: "disconnected" });
    expect(await run(stream.signal({ type: "end_of_candidates" }))).toEqual({ status: "refused", reason: "machine_not_attached" });
    expect(await run(stream.close())).toEqual({ status: "refused", reason: "machine_not_attached" });
    expect(await run(channel.send(Buffer.from("{}")))).toEqual({ status: "refused", reason: "machine_not_attached" });
    expect(await run(channel.close())).toEqual({ status: "refused", reason: "machine_not_attached" });
  } finally { await f.close(); }
});

test("streams relay host-minted ids, bounded signals and peer records both ways", async () => {
  const f = await fixture();
  try {
    const desk = await f.peer([COMPUTER], {
      [Machine.WireMethod.StreamOpen]: opened("streamId"),
      [Machine.WireMethod.StreamSignal]: accepted,
      [Machine.WireMethod.StreamClose]: (params) => ({ status: "closed", streamId: (params as { streamId: string }).streamId }),
    });
    const computer = f.machine();
    const watch = streamListeners();
    const stream = await run(computer.stream.open(streamRequest, watch.listeners));
    if (!("signal" in stream)) throw new Error("stream did not open");
    expect(stream.capturedAt(2_000_000)).toBeUndefined();
    expect(stream).toMatchObject({ streamId: "relay-1", expiresAt: 5000 });
    expect(await run(stream.signal({ type: "offer", sdp: "v=0" }))).toEqual({ status: "accepted", seq: 0 });
    expect(await run(stream.signal({ type: "candidate", candidate: "candidate:1" }))).toEqual({ status: "accepted", seq: 1 });
    const answer = { streamId: "relay-1", seq: 0, signal: { type: "answer", sdp: "v=0" } } as const;
    expect(await desk.client.call(Machine.WireMethod.StreamSignal, answer)).toEqual({ status: "accepted", seq: 0 });
    expect(await desk.client.call(Machine.WireMethod.StreamSignal, answer)).toEqual({ status: "accepted", seq: 0 });
    expect(await desk.client.call(Machine.WireMethod.StreamSignal, { ...answer, seq: 2 })).toEqual({ status: "refused", reason: "invalid_sequence" });
    expect(await desk.client.call(Machine.WireMethod.StreamSignal, { ...answer, streamId: "unknown" })).toEqual({ status: "refused", reason: "stream_not_found" });
    expect(watch.signals).toEqual([answer]);
    expect(await run(stream.close())).toEqual({ status: "closed", streamId: "relay-1" });
    expect(await watch.ended).toBe("requested");
    expect(await run(stream.close())).toEqual({ status: "refused", reason: "stream_not_found" });
    expect(await run(stream.signal({ type: "end_of_candidates" }))).toEqual({ status: "refused", reason: "stream_not_found" });
    expect(desk.received.map((entry) => entry.params)).toEqual([
      { streamId: "relay-1", ...streamRequest },
      { streamId: "relay-1", seq: 0, signal: { type: "offer", sdp: "v=0" } },
      { streamId: "relay-1", seq: 1, signal: { type: "candidate", candidate: "candidate:1" } },
      { streamId: "relay-1", reason: "requested" },
    ]);
  } finally { await f.close(); }
});

test("stream bounds: concurrency, signal count, expiry, peer close and a mismatched open", async () => {
  const f = await fixture();
  try {
    let echo: string | undefined;
    const desk = await f.peer([COMPUTER], {
      [Machine.WireMethod.StreamOpen]: (params) => ({ status: "opened", streamId: echo ?? (params as { streamId: string }).streamId, expiresAt: 5000 }),
      [Machine.WireMethod.StreamSignal]: accepted,
    });
    const computer = f.machine();
    const streams: Effect.Success<ReturnType<typeof computer.stream.open>>[] = [];
    for (let i = 0; i < Machine.STREAM_MAX_CONCURRENT; i += 1) streams.push(await run(computer.stream.open(streamRequest, streamListeners().listeners)));
    expect(await run(computer.stream.open(streamRequest, streamListeners().listeners))).toEqual({ status: "refused", reason: "stream_limit" });
    const first = streams[0];
    if (first === undefined || !("signal" in first)) throw new Error("stream did not open");
    for (let seq = 0; seq < Machine.STREAM_MAX_SIGNALS; seq += 1) await run(first.signal({ type: "end_of_candidates" }));
    expect(await run(first.signal({ type: "end_of_candidates" }))).toEqual({ status: "refused", reason: "signal_limit" });
    const second = streams[1];
    if (second === undefined || !("signal" in second)) throw new Error("stream did not open");
    const third = streams[2];
    if (third === undefined || !("signal" in third)) throw new Error("stream did not open");
    f.setClock(5000);
    expect(await run(second.signal({ type: "end_of_candidates" }))).toEqual({ status: "refused", reason: "stream_expired" });
    expect(await desk.client.call(Machine.WireMethod.StreamClose, { streamId: third.streamId, reason: "expired" })).toEqual({ status: "closed", streamId: third.streamId });
    expect(await desk.client.call(Machine.WireMethod.StreamClose, { streamId: third.streamId, reason: "expired" })).toEqual({ status: "refused", reason: "stream_not_found" });
    echo = "forged";
    expect(await run(Effect.flip(computer.stream.open(streamRequest, streamListeners().listeners)))).toMatchObject({ _tag: "MachineRefusalError", reason: "invalid_response" });
    echo = undefined;
    const relayed = await run(computer.stream.open(streamRequest, streamListeners().listeners));
    if (!("signal" in relayed)) throw new Error(`relayed open refused: ${JSON.stringify(relayed)}`);
    expect(relayed.streamId).toMatch(/^relay-/);
    expect(relayed.expiresAt).toBe(5000);
  } finally { await f.close(); }
});

test("a refused or failed open releases its reserved slot", async () => {
  const f = await fixture();
  try {
    const reached = Promise.withResolvers<void>();
    let mode: "refuse" | "hang" = "refuse";
    const desk = await f.peer([COMPUTER], {
      [Machine.WireMethod.StreamOpen]: () => {
        if (mode === "refuse") return { status: "refused", reason: "encoder_failed" };
        reached.resolve();
        return undefined;
      },
    });
    const computer = f.machine();
    for (let i = 0; i <= Machine.STREAM_MAX_CONCURRENT; i += 1) {
      expect(await run(computer.stream.open(streamRequest, streamListeners().listeners))).toEqual({ status: "refused", reason: "encoder_failed" });
    }
    mode = "hang";
    const pending = run(Effect.flip(computer.stream.open(streamRequest, streamListeners().listeners)));
    await reached.promise;
    const detached = f.events.next(Machine.Events.Detached.name);
    await desk.client.close();
    await detached;
    expect(await pending).toMatchObject({ reason: "disconnected" });
  } finally { await f.close(); }
});

test("debugging channels relay opaque bytes in order and close from either side", async () => {
  const f = await fixture();
  try {
    const desk = await f.peer([COMPUTER], {
      [Machine.WireMethod.CdpOpen]: opened("channelId"),
      [Machine.WireMethod.CdpChunk]: (params) => (params as { seq: number }).seq === 1 ? { status: "refused", reason: "channel_closed" } : accepted(params),
      [Machine.WireMethod.CdpClose]: (params) => ({ status: "closed", channelId: (params as { channelId: string }).channelId }),
    });
    const computer = f.machine();
    const tap = channelListeners();
    const channel = await run(computer.cdp.open(channelRequest, tap.listeners));
    if (!("send" in channel)) throw new Error("channel did not open");
    expect(await run(channel.send(Buffer.from("{\"id\":1}")))).toEqual({ status: "accepted", seq: 0 });
    expect(await run(channel.send(Buffer.from("{\"id\":2}")))).toEqual({ status: "refused", reason: "channel_closed" });
    expect(await run(channel.send(Buffer.from("{\"id\":3}")))).toEqual({ status: "refused", reason: "channel_closed" });
    const chunk = { channelId: channel.channelId, seq: 0, data: Buffer.from("{\"result\":{}}").toString("base64") };
    expect(await desk.client.call(Machine.WireMethod.CdpChunk, chunk)).toEqual({ status: "accepted", seq: 0 });
    expect(await desk.client.call(Machine.WireMethod.CdpChunk, chunk)).toEqual({ status: "accepted", seq: 0 });
    expect(await desk.client.call(Machine.WireMethod.CdpChunk, { ...chunk, seq: 3 })).toEqual({ status: "refused", reason: "invalid_sequence" });
    expect(await desk.client.call(Machine.WireMethod.CdpChunk, { ...chunk, channelId: "unknown" })).toEqual({ status: "refused", reason: "channel_not_found" });
    expect(tap.chunks).toEqual(["{\"result\":{}}"]);
    expect(await run(channel.close())).toEqual({ status: "closed", channelId: channel.channelId });
    expect(await tap.ended).toBe("requested");
    expect(await run(channel.close())).toEqual({ status: "refused", reason: "channel_not_found" });
    expect(await run(channel.send(Buffer.from("{}")))).toEqual({ status: "refused", reason: "channel_not_found" });
    const peerSide = channelListeners();
    const second = await run(computer.cdp.open(channelRequest, peerSide.listeners));
    if (!("send" in second)) throw new Error("channel did not open");
    expect(await desk.client.call(Machine.WireMethod.CdpClose, { channelId: second.channelId, reason: "endpoint_closed" })).toEqual({ status: "closed", channelId: second.channelId });
    expect(await peerSide.ended).toBe("endpoint_closed");
    expect(await desk.client.call(Machine.WireMethod.CdpClose, { channelId: second.channelId, reason: "endpoint_closed" })).toEqual({ status: "refused", reason: "channel_not_found" });
    expect(await desk.client.call(Machine.WireMethod.CdpChunk, { ...chunk, channelId: second.channelId })).toEqual({ status: "refused", reason: "channel_not_found" });
  } finally { await f.close(); }
});

test("relay records from an unattached connection refuse machine_not_attached; malformed ones fail", async () => {
  const f = await fixture();
  try {
    const stranger = await connectIpcClient(f.host.endpoints.unix ?? "");
    try {
      expect(await stranger.call(Machine.WireMethod.StreamSignal, { streamId: "s", seq: 0, signal: { type: "end_of_candidates" } })).toEqual({ status: "refused", reason: "machine_not_attached" });
      expect(await stranger.call(Machine.WireMethod.StreamClose, { streamId: "s", reason: "failed" })).toEqual({ status: "refused", reason: "machine_not_attached" });
      expect(await stranger.call(Machine.WireMethod.CdpChunk, { channelId: "c", seq: 0, data: "e30=" })).toEqual({ status: "refused", reason: "machine_not_attached" });
      expect(await stranger.call(Machine.WireMethod.CdpClose, { channelId: "c", reason: "failed" })).toEqual({ status: "refused", reason: "machine_not_attached" });
      expect(await stranger.call(Machine.WireMethod.StreamSignal, { streamId: "s" }).then(() => "answered", (error: Error) => error.name)).toBe("IpcRemoteError");
    } finally { await stranger.close(); }
  } finally { await f.close(); }
});

test("refused and disconnected input is still captured as tool.pre before it is answered", async () => {
  const captured: MachineInputCapture[] = [];
  const f = await fixture({ captureInput: (request, forward) => { captured.push(request); return forward; } });
  try {
    const desk = await f.peer([COMPUTER], { [Machine.WireMethod.InputText]: () => ({ status: "ok" }) });
    const computer = f.machine();
    f.grants.allowed = [];
    expect(await run(computer.text({ captureId: "cap-1", text: "hi" }))).toEqual({ status: "refused", reason: "permission_denied" });
    f.grants.allowed = [COMPUTER];
    const detached = f.events.next(Machine.Events.Detached.name);
    await desk.client.close();
    await detached;
    expect(await run(Effect.flip(computer.text({ captureId: "cap-1", text: "hi" })))).toMatchObject({ _tag: "MachineRefusalError", reason: "disconnected" });
    expect(captured).toEqual([
      { machineId: "desk", generation: 1, method: Machine.WireMethod.InputText, params: { requestId: "1-1", delivery: "background", captureId: "cap-1", text: "hi" } },
      { machineId: "desk", generation: null, method: Machine.WireMethod.InputText, params: { requestId: "1-2", delivery: "background", captureId: "cap-1", text: "hi" } },
    ]);
    expect(inputs(desk.received)).toEqual([]);
  } finally { await f.close(); }
});

test("a grant withdrawn after open retires existing streams and channels in both directions", async () => {
  const f = await fixture();
  try {
    const streamClosed = Promise.withResolvers<Ipc.Request["params"]>();
    const channelClosed = Promise.withResolvers<Ipc.Request["params"]>();
    const desk = await f.peer([COMPUTER], {
      [Machine.WireMethod.StreamOpen]: opened("streamId"),
      [Machine.WireMethod.CdpOpen]: opened("channelId"),
      [Machine.WireMethod.StreamSignal]: accepted,
      [Machine.WireMethod.CdpChunk]: accepted,
      [Machine.WireMethod.StreamClose]: (params) => { streamClosed.resolve(params); return { status: "closed", streamId: (params as { streamId: string }).streamId }; },
      [Machine.WireMethod.CdpClose]: (params) => { channelClosed.resolve(params); return { status: "closed", channelId: (params as { channelId: string }).channelId }; },
    });
    const computer = f.machine();
    const inbound = streamListeners();
    const outbound = streamListeners();
    const tapIn = channelListeners();
    const tapOut = channelListeners();
    const streamIn = await run(computer.stream.open(streamRequest, inbound.listeners));
    const streamOut = await run(computer.stream.open(streamRequest, outbound.listeners));
    const channelIn = await run(computer.cdp.open(channelRequest, tapIn.listeners));
    const channelOut = await run(computer.cdp.open(channelRequest, tapOut.listeners));
    if (!("signal" in streamIn) || !("signal" in streamOut) || !("send" in channelIn) || !("send" in channelOut)) throw new Error("relays did not open");
    f.grants.allowed = [];
    const revokedStream = { status: "refused", reason: "stream_not_found", message: "computer.use is no longer granted" } as const;
    expect(await desk.client.call(Machine.WireMethod.StreamSignal, { streamId: streamIn.streamId, seq: 0, signal: { type: "end_of_candidates" } })).toEqual(revokedStream);
    expect(await inbound.ended).toBe("revoked");
    expect(await streamClosed.promise).toEqual({ streamId: streamIn.streamId, reason: "requested" });
    expect(await desk.client.call(Machine.WireMethod.CdpChunk, { channelId: channelIn.channelId, seq: 0, data: "e30=" })).toEqual({ status: "refused", reason: "channel_closed" });
    expect(await tapIn.ended).toBe("revoked");
    expect(await channelClosed.promise).toEqual({ channelId: channelIn.channelId, reason: "requested" });
    expect(await run(streamOut.signal({ type: "end_of_candidates" }))).toEqual(revokedStream);
    expect(await outbound.ended).toBe("revoked");
    expect(await run(channelOut.send(Buffer.from("{}")))).toEqual({ status: "refused", reason: "channel_closed" });
    expect(await tapOut.ended).toBe("revoked");
    expect(inbound.signals).toEqual([]);
    expect(tapIn.chunks).toEqual([]);
    expect(desk.received.filter((entry) => entry.method === Machine.WireMethod.StreamSignal || entry.method === Machine.WireMethod.CdpChunk)).toEqual([]);
    expect(desk.received.filter((entry) => entry.method === Machine.WireMethod.StreamClose || entry.method === Machine.WireMethod.CdpClose).map((entry) => entry.params)).toEqual([
      { streamId: streamIn.streamId, reason: "requested" },
      { channelId: channelIn.channelId, reason: "requested" },
      { streamId: streamOut.streamId, reason: "requested" },
      { channelId: channelOut.channelId, reason: "requested" },
    ]);
  } finally { await f.close(); }
});

test("observe and action are captured like input and relay the peer's typed answers", async () => {
  const captured: MachineInputCapture[] = [];
  const f = await fixture({ captureInput: (request, forward) => { captured.push(request); return forward; } });
  try {
    const desk = await f.peer([COMPUTER], observationScript);
    const computer = f.machine();
    expect(await run(computer.observe(observeRequest))).toEqual(observed);
    expect(await run(computer.action(actionRequest))).toEqual({ status: "refused", reason: "epoch_changed" });
    expect(captured).toEqual([
      { machineId: "desk", generation: 1, method: Machine.WireMethod.ScreenObserve, params: observeRequest },
      { machineId: "desk", generation: 1, method: Machine.WireMethod.InputAction, params: { ...actionRequest, requestId: "1-1" },
        binding: { pid: 42, windowId: 7, epoch: 0, app: { bundleId: null, path: "/Applications/Notes.app" } } },
    ]);
    expect(observations(desk.received)).toEqual([
      { method: Machine.WireMethod.ScreenObserve, params: observeRequest },
      { method: Machine.WireMethod.InputAction, params: { ...actionRequest, requestId: "1-1" } },
    ]);
  } finally { await f.close(); }
});

test("settle preserves method-specific quiet defaults and returns the peer observation", async () => {
  const captured: MachineInputCapture[] = [];
  const f = await fixture({ captureInput: (request, forward) => { captured.push(request); return forward; } });
  try {
    const desk = await f.peer([COMPUTER], { [Machine.WireMethod.ScreenSettle]: () => ({ status: "settled", method: "accessibility", observationId: "o4" }) });
    const request: Machine.ScreenSettleRequest = { target: { pid: 42, windowId: 7, epoch: 0 } };
    expect(await run(f.machine().settle(request))).toEqual({ status: "settled", method: "accessibility", observationId: "o4" });
    const params = { ...request, timeoutMs: 5000 };
    expect(captured).toEqual([{ machineId: "desk", generation: 1, method: Machine.WireMethod.ScreenSettle, params }]);
    expect(desk.received).toContainEqual({ method: Machine.WireMethod.ScreenSettle, params });
  } finally { await f.close(); }
});

test("settle is withheld by capture refusal and relays a v3 observer refusal", async () => {
  for (const captureInput of [() => Effect.succeed({ status: "refused", reason: "permission_denied" } as const), "absent"] as const) {
    const f = await fixture({ captureInput });
    try {
      const peer = await f.peer([COMPUTER]);
      const answer = await run(f.machine().settle({ target: { pid: 42, windowId: 7, epoch: 0 } }));
      expect(Machine.ScreenSettleResult.parse(answer)).toEqual({ status: "refused", reason: "permission_denied", ...(captureInput === "absent" ? { message: "input requires a captured tool.pre effect" } : {}) });
      expect(peer.received.filter((entry) => entry.method === Machine.WireMethod.ScreenSettle)).toEqual([]);
    } finally { await f.close(); }
  }
  const older = await fixture();
  try {
    const peer = await older.peer([COMPUTER], {
      [Machine.WireMethod.ScreenSettle]: () => ({ status: "unsupported", blocker: "no_observer" }),
    }, undefined, 3);
    expect(await run(older.machine().settle({ target: { pid: 42, windowId: 7, epoch: 0 } }))).toEqual({ status: "unsupported", blocker: "no_observer" });
    expect(peer.received.filter((entry) => entry.method === Machine.WireMethod.ScreenSettle)).toHaveLength(1);
  } finally { await older.close(); }
});

test("settle distinguishes denied grants from an attached peer without an observer", async () => {
  for (const [grants, offered, expected] of [
    [[Machine.WellKnownCapability.fsRead], [COMPUTER], { status: "refused", reason: "permission_denied" }],
    [[COMPUTER], [], { status: "unsupported", blocker: "no_observer" }],
  ] as const) {
    const f = await fixture({ grants: [...grants] });
    try {
      const peer = await f.peer(offered);
      const answer = await run(f.machine().settle({ target: { pid: 42, windowId: 7, epoch: 0 } }));
      expect(Machine.ScreenSettleResult.parse(answer)).toEqual(expected);
      expect(peer.received).toEqual([]);
    } finally { await f.close(); }
  }
});

test("settle returns typed attachment refusal before attach and after detach", async () => {
  const f = await fixture();
  const request: Machine.ScreenSettleRequest = { target: { pid: 42, windowId: 7, epoch: 0 } };
  try {
    expect(await run(f.machine().settle(request))).toEqual({ status: "refused", reason: "machine_not_attached" });
    const peer = await f.peer([COMPUTER]);
    const detached = f.events.next(Machine.Events.Detached.name);
    await peer.client.close();
    await detached;
    expect(await run(f.machine().settle(request))).toEqual({ status: "refused", reason: "machine_not_attached" });
  } finally { await f.close(); }
});

test("settle preserves generation errors rather than hiding a replacement attachment", async () => {
  let replace = (): Promise<void> => Promise.resolve();
  const f = await fixture({ captureInput: (_request, forward) => Effect.promise(() => replace()).pipe(Effect.andThen(forward)) });
  try {
    await f.peer([COMPUTER]);
    replace = async () => { await f.peer([COMPUTER], {}, 1); };
    expect(await run(Effect.flip(f.machine().settle({ target: { pid: 42, windowId: 7, epoch: 0 } })))).toMatchObject({ _tag: "MachineRefusalError", reason: "stale_generation" });
  } finally { await f.close(); }
});

test("a v3 pointer preserves capture and element targets with distinct request IDs", async () => {
  const f = await fixture();
  try {
    const peer = await f.peer([COMPUTER], { [Machine.WireMethod.InputPointer]: () => ({ status: "ok" }) }, undefined, 3);
    expect(await run(f.machine().pointer(pointer))).toEqual({ status: "ok" });
    expect(peer.received.filter((entry) => entry.method === Machine.WireMethod.InputPointer)).toEqual([{
      method: Machine.WireMethod.InputPointer,
      params: { ...pointer, requestId: "1-1" },
    }]);
    const element = { ...pointer, at: { observationId: "o1", ref: "AXButton[0]" } };
    expect(await run(f.machine().pointer(element))).toEqual({ status: "ok" });
    expect(inputs(peer.received)).toHaveLength(2);
    expect(inputs(peer.received)[1]).toEqual({ method: Machine.WireMethod.InputPointer, params: { ...element, requestId: "1-2" } });
  } finally { await f.close(); }
});

test("a refusing capture port blocks observe and action, and no port sends neither", async () => {
  for (const captureInput of [() => Effect.succeed({ status: "refused", reason: "permission_denied", message: "tool.pre blocked" } as const), "absent"] as const) {
    const f = await fixture({ captureInput });
    try {
      const desk = await f.peer([COMPUTER], observationScript);
      const message = captureInput === "absent" ? "input requires a captured tool.pre effect" : "tool.pre blocked";
      expect(await run(f.machine().observe(observeRequest))).toEqual({ status: "refused", reason: "permission_denied", message });
      expect(await run(f.machine().action(actionRequest))).toEqual({ status: "refused", reason: "permission_denied", message });
      expect(observations(desk.received)).toEqual([]);
    } finally { await f.close(); }
  }
});

test("observe and action refuse a withheld grant or missing display, while v3 peers remain supported", async () => {
  const denied = await fixture({ grants: [Machine.WellKnownCapability.fsRead] });
  try {
    const desk = await denied.peer([COMPUTER], observationScript);
    expect(await run(denied.machine().observe(observeRequest))).toEqual({ status: "refused", reason: "permission_denied" });
    expect(await run(denied.machine().action(actionRequest))).toEqual({ status: "refused", reason: "permission_denied" });
    expect(observations(desk.received)).toEqual([]);
  } finally { await denied.close(); }
  const headless = await fixture();
  try {
    const desk = await headless.peer([], observationScript);
    expect(await run(headless.machine().observe(observeRequest))).toEqual({ status: "refused", reason: "observe_not_available" });
    expect(await run(headless.machine().action(actionRequest))).toEqual({ status: "refused", reason: "input_not_available" });
    expect(observations(desk.received)).toEqual([]);
  } finally { await headless.close(); }
  const older = await fixture();
  try {
    const desk = await older.peer([COMPUTER], { ...observationScript, [Machine.WireMethod.InputPointer]: () => ({ status: "ok" }) }, undefined, 3);
    expect(await run(older.machine().observe(observeRequest))).toEqual(observed);
    expect(await run(older.machine().action(actionRequest))).toEqual({ status: "refused", reason: "epoch_changed" });
    expect(observations(desk.received)).toEqual([
      { method: Machine.WireMethod.ScreenObserve, params: observeRequest },
      { method: Machine.WireMethod.InputAction, params: { ...actionRequest, requestId: "1-1" } },
    ]);
    expect(await run(older.machine().pointer(pointer))).toEqual({ status: "ok" });
    expect(inputs(desk.received)).toEqual([
      { method: Machine.WireMethod.InputAction, params: { ...actionRequest, requestId: "1-1" } },
      { method: Machine.WireMethod.InputPointer, params: { ...pointer, requestId: "1-2" } },
    ]);
  } finally { await older.close(); }
});

test("malformed observe and action requests fail before capture", async () => {
  const captured: MachineInputCapture[] = [];
  const f = await fixture({ captureInput: (request, forward) => { captured.push(request); return forward; } });
  try {
    await f.peer([COMPUTER], observationScript);
    const badObserve = { ...observeRequest, target: { pid: 0, windowId: 7 } };
    const badAction = { ...actionRequest, ref: "no-index" };
    expect(await run(Effect.flip(f.machine().observe(badObserve)))).toMatchObject({ _tag: "MachinesFailure" });
    expect(await run(Effect.flip(f.machine().action(badAction)))).toMatchObject({ _tag: "MachinesFailure" });
    expect(captured).toEqual([]);
  } finally { await f.close(); }
});

test("lifecycle methods are captured and refuse absent grants while v3 peers stay supported", async () => {
  const target = { pid: 42, windowId: 7, epoch: 0 };
  type Answer = Machine.AppLaunchResult | Machine.AppQuitResult | Machine.WindowCloseResult | Machine.WindowParkResult;
  const operations: { method: MachineInputCapture["method"]; call: (computer: ComputerHandle) => Effect.Effect<Answer, MachineError>; answer: Answer }[] = [
    { method: Machine.WireMethod.AppLaunch, call: (c: ComputerHandle) => c.app.launch({ app: { bundleId: "org.oni.fixture" }, activate: false }), answer: { status: "ok", pid: 42, windows: [target] } },
    { method: Machine.WireMethod.AppQuit, call: (c: ComputerHandle) => c.app.quit({ pid: 42 }), answer: { status: "ok", exited: true } },
    { method: Machine.WireMethod.WindowClose, call: (c: ComputerHandle) => c.window.close({ target }), answer: { status: "ok", closed: true } },
    { method: Machine.WireMethod.WindowPark, call: (c: ComputerHandle) => c.window.park({ target }), answer: { status: "ok", parked: false } },
  ];
  const methods = operations.map((op) => op.method);
  const scenarios: { offered: Machine.CapabilityId[]; allowed: Machine.CapabilityId[]; version: number; refusal?: Answer; received: MachineInputCapture["method"][] }[] = [
    { offered: [COMPUTER], allowed: [COMPUTER], version: 4, received: methods },
    { offered: [], allowed: [COMPUTER], version: 4, refusal: { status: "refused", reason: "machine_not_attached" }, received: [] },
    { offered: [COMPUTER], allowed: [], version: 4, refusal: { status: "refused", reason: "permission_denied" }, received: [] },
    { offered: [COMPUTER], allowed: [COMPUTER], version: 3, received: methods },
  ];
  for (const scenario of scenarios) {
    const captured: MachineInputCapture[] = [];
    const f = await fixture({ captureInput: (request, forward) => { captured.push(request); return forward; } });
    try {
      const responses = Object.fromEntries(operations.map((op) => [op.method, () => op.answer]));
      const peer = await f.peer(scenario.offered, responses, undefined, scenario.version);
      f.grants.allowed = scenario.allowed;
      for (const operation of operations) {
        const result: Answer = await run(operation.call(f.machine()));
        expect(result).toEqual(scenario.refusal ?? operation.answer);
      }
      expect(captured.map((entry) => entry.method)).toEqual(methods);
      expect(peer.received.map((entry) => entry.method)).toEqual(scenario.received);
    } finally { await f.close(); }
  }
});

test("v3 input forwards background delivery without rewriting it", async () => {
  const captured: MachineInputCapture[] = [];
  const f = await fixture({ captureInput: (request, forward) => { captured.push(request); return forward; } });
  try {
    const peer = await f.peer([COMPUTER], {
      [Machine.WireMethod.InputPointer]: () => ({ status: "ok" }),
      [Machine.WireMethod.InputKey]: () => ({ status: "ok" }),
      [Machine.WireMethod.InputText]: () => ({ status: "ok" }),
    }, undefined, 3);
    expect(await run(f.machine().pointer({ ...pointer, delivery: "background" }))).toEqual({ status: "ok" });
    expect(await run(f.machine().key({ captureId: "cap-1", key: "a", action: "press" }))).toEqual({ status: "ok" });
    expect(peer.received.slice(0, 2)).toEqual([
      { method: Machine.WireMethod.InputPointer, params: { ...pointer, delivery: "background", requestId: "1-1" } },
      { method: Machine.WireMethod.InputKey, params: { captureId: "cap-1", key: "a", action: "press", delivery: "background", requestId: "1-2" } },
    ]);
    expect(await run(f.machine().pointer(pointer))).toEqual({ status: "ok" });
    expect(await run(f.machine().text({ delivery: "foreground", captureId: "cap-1", text: "x" }))).toEqual({ status: "ok" });
    const target = { pid: 42, windowId: 7, epoch: 0 };
    const key = { delivery: "foreground", captureId: "cap-1", key: "a", action: "press", target } as const;
    const text = { delivery: "foreground", captureId: "cap-1", text: "targeted", target } as const;
    expect(await run(f.machine().key(key))).toEqual({ status: "ok" });
    expect(await run(f.machine().text(text))).toEqual({ status: "ok" });
    expect(captured.slice(-2).map((entry) => entry.params)).toEqual([{ ...key, requestId: "1-5" }, { ...text, requestId: "1-6" }]);
    expect(peer.received).toEqual([
      { method: Machine.WireMethod.InputPointer, params: { ...pointer, delivery: "background", requestId: "1-1" } },
      { method: Machine.WireMethod.InputKey, params: { captureId: "cap-1", key: "a", action: "press", delivery: "background", requestId: "1-2" } },
      { method: Machine.WireMethod.InputPointer, params: { ...pointer, requestId: "1-3" } },
      { method: Machine.WireMethod.InputText, params: { delivery: "foreground", captureId: "cap-1", text: "x", requestId: "1-4" } },
      { method: Machine.WireMethod.InputKey, params: { ...key, requestId: "1-5" } },
      { method: Machine.WireMethod.InputText, params: { ...text, requestId: "1-6" } },
    ]);
  } finally { await f.close(); }
});
