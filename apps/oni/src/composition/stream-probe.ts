import { frameLatency, type ComputerStream, type DisplayedFrame, type FrameLatency, type RelayEnd, type StreamListeners } from "@oni/machines";
import { Machine, parseJson, PlainValueSchema } from "@oni/protocol";
import { z } from "zod";

const Signal = Machine.StreamSignalRequest.shape.signal;
const Request = z.discriminatedUnion("type", [
  z.object({ type: z.literal("stream_probe_open"), requestId: z.string().min(1), machineId: z.string().min(1), display: z.number().int().nonnegative(), reconnect: z.boolean().default(false) }).strict(),
  z.object({ type: z.literal("stream_probe_signal"), requestId: z.string().min(1), signal: Signal }).strict(),
  z.object({ type: z.literal("stream_probe_frame"), requestId: z.string().min(1), seq: z.number().int().nonnegative(), capturedAtUs: z.number().int().nonnegative(), receivedAt: z.number().finite(), decodedAt: z.number().finite().nullable() }).strict(),
  z.object({ type: z.literal("stream_probe_close"), requestId: z.string().min(1), reconnect: z.boolean().default(false) }).strict(),
  z.object({ type: z.literal("stream_probe_report"), requestId: z.string().min(1) }).strict(),
]);
export type StreamProbeRequest = z.infer<typeof Request>;

const Percentiles = z.object({
  frames: z.number().int().nonnegative(), p50: z.number().nullable(), p95: z.number().nullable(),
  p99: z.number().nullable(), reconnectFirstFreshFrameMs: z.number().nullable(), dropped: z.number().int().nonnegative(),
}).strict();
export const StreamProbeResponse = z.discriminatedUnion("type", [
  z.object({ type: z.literal("stream_probe_opened"), requestId: z.string(), streamId: z.string() }).strict(),
  z.object({ type: z.literal("stream_probe_signal"), requestId: z.string(), signal: Signal }).strict(),
  z.object({ type: z.literal("stream_probe_accepted"), requestId: z.string() }).strict(),
  z.object({ type: z.literal("stream_probe_closed"), requestId: z.string() }).strict(),
  z.object({ type: z.literal("stream_probe_refused"), requestId: z.string(), reason: z.string() }).strict(),
  z.object({
    type: z.literal("stream_probe_report"), requestId: z.string(),
    stages: z.object({
      captureToReceipt: Percentiles, captureToDecoded: Percentiles,
      captureToDisplay: z.null(), displayedBy: z.literal("none"),
    }).strict(),
    reconnect: z.enum(["not_requested", "measured", "unavailable"]),
    reconnectFirstFreshFrameMs: z.number().nullable(),
  }).strict(),
]);
export type StreamProbeResponse = z.infer<typeof StreamProbeResponse>;

type Stream = Pick<ComputerStream, "streamId" | "capturedAt"> & {
  readonly signal: (signal: Machine.StreamSignalRequest["signal"]) => Promise<Machine.StreamSignalResult>;
  readonly close: () => Promise<Machine.StreamCloseResult>;
};
interface ProbePorts {
  readonly open: (machineId: string, display: number, listeners: StreamListeners) =>
    Promise<Stream | Extract<Machine.StreamOpenResult, { status: "refused" }>>;
  readonly now: () => number;
}
interface ProbeConnection {
  send(frame: string): void;
}
interface Session {
  stream?: Stream;
  readonly receipt: DisplayedFrame[];
  readonly decoded: DisplayedFrame[];
  reconnectAt?: number;
  reconnect: "not_requested" | "measured" | "unavailable";
}

const send = (ws: ProbeConnection, frame: StreamProbeResponse): void => ws.send(JSON.stringify(frame));

async function openSession(
  ws: ProbeConnection, input: Extract<StreamProbeRequest, { type: "stream_probe_open" }>,
  sessions: Map<string, Session>, ports: ProbePorts,
): Promise<void> {
  const { requestId } = input;
  const previous = sessions.get(requestId);
  if (previous?.stream !== undefined) {
    send(ws, { type: "stream_probe_refused", requestId, reason: "already_open" });
    return;
  }
  if (input.reconnect && previous === undefined) {
    send(ws, { type: "stream_probe_refused", requestId, reason: "no_previous_stream" });
    return;
  }
  const state: Session = previous ?? { receipt: [], decoded: [], reconnect: "not_requested" };
  const listeners: StreamListeners = {
    onSignal: (signal) => send(ws, { type: "stream_probe_signal", requestId, signal: signal.signal }),
    onClose: (_reason: RelayEnd) => { state.stream = undefined; },
  };
  try {
    const opened = await ports.open(input.machineId, input.display, listeners);
    if ("status" in opened) {
      if (input.reconnect) state.reconnect = "unavailable";
      send(ws, { type: "stream_probe_refused", requestId, reason: opened.reason });
      return;
    }
    state.stream = opened;
    sessions.set(requestId, state);
    send(ws, { type: "stream_probe_opened", requestId, streamId: opened.streamId });
  } catch (error) {
    if (input.reconnect) state.reconnect = "unavailable";
    send(ws, { type: "stream_probe_refused", requestId, reason: error instanceof Error ? error.message : "stream_open_failed" });
  }
}

async function signalSession(
  ws: ProbeConnection, input: Extract<StreamProbeRequest, { type: "stream_probe_signal" }>,
  session: Session,
): Promise<void> {
  const answer = await session.stream?.signal(input.signal);
  send(ws, answer?.status === "accepted"
    ? { type: "stream_probe_accepted", requestId: input.requestId }
    : { type: "stream_probe_refused", requestId: input.requestId, reason: answer?.reason ?? "stream_not_open" });
}

function receiveFrame(
  ws: ProbeConnection, input: Extract<StreamProbeRequest, { type: "stream_probe_frame" }>,
  session: Session,
): void {
  const capturedAt = session.stream?.capturedAt(input.capturedAtUs);
  if (capturedAt === undefined) {
    send(ws, { type: "stream_probe_refused", requestId: input.requestId, reason: "clock_unavailable" });
    return;
  }
  const reconnect = session.reconnectAt === undefined ? {} : { reconnectedAt: session.reconnectAt };
  const frame = { seq: input.seq, capturedAt, ...reconnect };
  session.receipt.push({ ...frame, displayAt: input.receivedAt });
  if (input.decodedAt !== null) session.decoded.push({ ...frame, displayAt: input.decodedAt });
  if (session.reconnectAt !== undefined) {
    session.reconnectAt = undefined;
    session.reconnect = "measured";
  }
  send(ws, { type: "stream_probe_accepted", requestId: input.requestId });
}

async function closeSession(
  ws: ProbeConnection, input: Extract<StreamProbeRequest, { type: "stream_probe_close" }>,
  session: Session, now: () => number,
): Promise<void> {
  const stream = session.stream;
  if (stream === undefined) {
    send(ws, { type: "stream_probe_refused", requestId: input.requestId, reason: "stream_not_open" });
    return;
  }
  session.stream = undefined;
  const closed = await stream.close();
  if (closed.status !== "closed") {
    session.reconnect = "unavailable";
    send(ws, { type: "stream_probe_refused", requestId: input.requestId, reason: closed.reason });
    return;
  }
  if (input.reconnect) session.reconnectAt = now();
  send(ws, { type: "stream_probe_closed", requestId: input.requestId });
}

function reportSession(ws: ProbeConnection, requestId: string, session: Session): void {
  const captureToReceipt: FrameLatency = frameLatency(session.receipt);
  const captureToDecoded: FrameLatency = frameLatency(session.decoded);
  send(ws, {
    type: "stream_probe_report", requestId,
    stages: { captureToReceipt, captureToDecoded, captureToDisplay: null, displayedBy: "none" },
    reconnect: session.reconnect,
    reconnectFirstFreshFrameMs: session.reconnect === "measured" ? captureToReceipt.reconnectFirstFreshFrameMs : null,
  });
}

async function dispatch(
  ws: ProbeConnection, input: StreamProbeRequest,
  sessions: Map<string, Session>, ports: ProbePorts,
): Promise<void> {
  if (input.type === "stream_probe_open") {
    await openSession(ws, input, sessions, ports);
    return;
  }
  const session = sessions.get(input.requestId);
  if (input.type === "stream_probe_report") {
    if (session === undefined) send(ws, { type: "stream_probe_refused", requestId: input.requestId, reason: "stream_not_open" });
    else reportSession(ws, input.requestId, session);
    return;
  }
  if (session?.stream === undefined) {
    send(ws, { type: "stream_probe_refused", requestId: input.requestId, reason: "stream_not_open" });
    return;
  }
  switch (input.type) {
    case "stream_probe_signal":
      await signalSession(ws, input, session);
      break;
    case "stream_probe_frame":
      receiveFrame(ws, input, session);
      break;
    case "stream_probe_close":
      await closeSession(ws, input, session, ports.now);
      break;
  }
}

/** A per-socket stream probe. The frame source and clock are injected, including in conformance. */
export function createStreamProbe(ports: ProbePorts) {
  const connections = new Map<ProbeConnection, Map<string, Session>>();
  return {
    async handle(ws: ProbeConnection, data: string | Buffer, authenticated: boolean): Promise<boolean> {
      const document = parseJson(PlainValueSchema, typeof data === "string" ? data : data.toString());
      if (document === null || typeof document !== "object" || Array.isArray(document) ||
          typeof document.type !== "string" || !document.type.startsWith("stream_probe_")) return false;
      const request = Request.safeParse(document);
      const requestId = typeof document.requestId === "string" && document.requestId.length > 0 ? document.requestId : "invalid";
      if (!request.success || !authenticated) {
        send(ws, { type: "stream_probe_refused", requestId, reason: request.success ? "unauthenticated" : "invalid_request" });
        return true;
      }
      const sessions = connections.get(ws) ?? new Map<string, Session>();
      connections.set(ws, sessions);
      await dispatch(ws, request.data, sessions, ports);
      return true;
    },
    async close(ws: ProbeConnection): Promise<void> {
      const sessions = connections.get(ws);
      connections.delete(ws);
      if (sessions !== undefined) await Promise.all([...sessions.values()].flatMap((session) =>
        session.stream === undefined ? [] : [session.stream.close()]));
    },
  };
}
