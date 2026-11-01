import { type StreamProbeResponse, StreamProbeResponse as Response } from "../composition/stream-probe";
import { CliError } from "./errors";
import { openStreamViewer, type StreamViewer } from "./stream-viewer";

type Frame = { readonly type: string; readonly requestId: string; readonly [field: string]: string | number | boolean | null | object };

export interface ProbeLink {
  send(frame: Frame): void;
  next(match: (response: StreamProbeResponse) => boolean): Promise<StreamProbeResponse>;
  close(): void;
}

export interface StreamProbeDeps {
  readonly id: () => string;
  readonly connect: () => Promise<ProbeLink>;
  readonly viewer: () => Promise<StreamViewer>;
  readonly wait: (ms: number) => Promise<void>;
  readonly frameCount?: number;
}

export interface StreamProbeOptions {
  readonly machineId: string;
  readonly display: number;
  readonly reconnect?: { readonly afterMs: number };
}

const USAGE = "usage: oni machine probe <machine-id> <display-id> [--reconnect-after-ms <1..60000>]";

export function parseStreamProbeArgs(args: readonly string[]): StreamProbeOptions {
  const [machineId, display, flag, delay, extra] = args;
  if (machineId === undefined || machineId.length === 0 || display === undefined ||
      !/^\d+$/.test(display) || !Number.isSafeInteger(Number(display)) || extra !== undefined ||
      (flag !== undefined && (flag !== "--reconnect-after-ms" || delay === undefined ||
        !/^[1-9]\d*$/.test(delay) || Number(delay) > 60_000)) ||
      (flag === undefined && delay !== undefined)) throw new CliError(USAGE);
  return { machineId, display: Number(display),
    ...(delay === undefined ? {} : { reconnect: { afterMs: Number(delay) } }) };
}

function requireAnswer(response: StreamProbeResponse, type: StreamProbeResponse["type"]): void {
  if (response.type === "stream_probe_refused") throw new CliError(`${response.type}: ${response.reason}${response.message === undefined ? "" : `: ${response.message}`}`);
  if (response.type !== type) throw new CliError(`expected ${type}, got ${response.type}`);
}

/** Runs one negotiated stream, forwarding candidate signals unchanged. */
async function receive(
  link: ProbeLink,
  viewer: StreamViewer,
  requestId: string,
  machineId: string,
  display: number,
  reconnect: boolean,
  count: number,
): Promise<void> {
  const signals: Array<Extract<StreamProbeResponse, { type: "stream_probe_signal" }>["signal"]> = [];
  const opened = link.next((response) =>
    response.requestId === requestId && (response.type === "stream_probe_opened" || response.type === "stream_probe_refused"));
  link.send({ type: "stream_probe_open", requestId, machineId, display, reconnect });
  requireAnswer(await opened, "stream_probe_opened");
  // Each signaling record is buffered by the link even when it precedes the open answer.
  for (;;) {
    const response = await link.next((frame) => frame.requestId === requestId && frame.type === "stream_probe_signal");
    if (response.type !== "stream_probe_signal") throw new CliError("missing stream signal");
    signals.push(response.signal);
    if (response.signal.type === "end_of_candidates") break;
  }
  const offer = signals.find((signal) => signal.type === "offer");
  if (offer?.type !== "offer") throw new CliError("stream offer missing");
  for (const signal of signals) if (signal.type === "candidate") await viewer.candidate(signal.candidate);
  const answer = await viewer.answer(offer.sdp);
  for (const signal of [{ type: "answer", sdp: answer.sdp } as const,
    ...answer.candidates.map(({ candidate, sdpMid }) => ({
      type: "candidate" as const, candidate, ...(sdpMid === undefined ? {} : { sdpMid }),
    })),
    { type: "end_of_candidates" as const }]) {
    const accepted = link.next((frame) => frame.requestId === requestId &&
      (frame.type === "stream_probe_accepted" || frame.type === "stream_probe_refused"));
    link.send({ type: "stream_probe_signal", requestId, signal });
    requireAnswer(await accepted, "stream_probe_accepted");
  }
  const frames = await viewer.until(count);
  for (const frame of frames) {
    const accepted = link.next((response) => response.requestId === requestId &&
      (response.type === "stream_probe_accepted" || response.type === "stream_probe_refused"));
    link.send({ type: "stream_probe_frame", requestId, ...frame });
    requireAnswer(await accepted, "stream_probe_accepted");
  }
}

/** One live measurement over the Owner's gateway socket; no frame payload enters the gateway. */
export async function runStreamProbe(options: StreamProbeOptions, deps: StreamProbeDeps): Promise<Extract<StreamProbeResponse, { type: "stream_probe_report" }>> {
  const link = await deps.connect();
  const requestId = deps.id();
  try {
    const passes = options.reconnect === undefined ? 1 : 2;
    for (let pass = 0; pass < passes; pass += 1) {
      const viewer = await deps.viewer();
      try {
        await receive(link, viewer, requestId, options.machineId, options.display, pass > 0, deps.frameCount ?? 10);
        if (pass === 0 && options.reconnect !== undefined) await deps.wait(options.reconnect.afterMs);
        const closed = link.next((frame) => frame.requestId === requestId &&
          (frame.type === "stream_probe_closed" || frame.type === "stream_probe_refused"));
        link.send({ type: "stream_probe_close", requestId, reconnect: pass === 0 && options.reconnect !== undefined });
        requireAnswer(await closed, "stream_probe_closed");
      } catch (error) {
        if (pass === 0 || !(error instanceof CliError) || !error.message.startsWith("stream_probe_refused:")) throw error;
        break;
      } finally {
        viewer.close();
      }
    }
    const reported = link.next((frame) => frame.requestId === requestId &&
      (frame.type === "stream_probe_report" || frame.type === "stream_probe_refused"));
    link.send({ type: "stream_probe_report", requestId });
    const response = await reported;
    requireAnswer(response, "stream_probe_report");
    if (response.type !== "stream_probe_report") throw new CliError("stream probe report missing");
    return response;
  } finally {
    link.close();
  }
}

export async function streamProbeCommand(
  args: readonly string[], deps: StreamProbeDeps,
  io: { readonly stdout: (line: string) => void; readonly stderr: (line: string) => void },
): Promise<number> {
  try {
    io.stdout(JSON.stringify(await runStreamProbe(parseStreamProbeArgs(args), deps)));
    return 0;
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export function connectProbe(url: string, token: string, timeoutMs = 30_000): Promise<ProbeLink> {
  const socket = new WebSocket(url, ["auth", token]);
  return new Promise((resolve, reject) => {
    const pending: StreamProbeResponse[] = [];
    const waiters: Array<{ readonly match: (frame: StreamProbeResponse) => boolean; readonly resolve: (frame: StreamProbeResponse) => void; readonly reject: (error: Error) => void }> = [];
    let connected = false;
    const disconnect = () => {
      const error = new CliError("stream probe socket closed");
      if (!connected) reject(error);
      for (const waiter of waiters.splice(0)) waiter.reject(error);
    };
    const deadline = setTimeout(() => { socket.close(); reject(new CliError("stream probe connection timed out")); }, timeoutMs);
    socket.addEventListener("error", () => {
      clearTimeout(deadline);
      disconnect();
    });
    socket.addEventListener("close", () => {
      clearTimeout(deadline);
      disconnect();
    });
    socket.addEventListener("open", () => {
      clearTimeout(deadline);
      connected = true;
      resolve({
        send: (frame) => socket.send(JSON.stringify(frame)),
        next: (match) => {
          const index = pending.findIndex(match);
          if (index >= 0) {
            const [frame] = pending.splice(index, 1);
            if (frame !== undefined) return Promise.resolve(frame);
          }
          return new Promise((done, fail) => {
            const waiter = {
              match,
              resolve: (frame: StreamProbeResponse) => { clearTimeout(responseTimer); done(frame); },
              reject: (error: Error) => { clearTimeout(responseTimer); fail(error); },
            };
            const responseTimer = setTimeout(() => {
              waiters.splice(waiters.indexOf(waiter), 1);
              fail(new CliError("stream probe response timed out"));
            }, timeoutMs);
            waiters.push(waiter);
          });
        },
        close: () => socket.close(),
      });
    });
    socket.addEventListener("message", (event) => {
      const parsed = Response.safeParse(JSON.parse(String(event.data)));
      if (!parsed.success) return;
      const index = waiters.findIndex((waiter) => waiter.match(parsed.data));
      if (index < 0) pending.push(parsed.data);
      else {
        const [waiter] = waiters.splice(index, 1);
        waiter?.resolve(parsed.data);
      }
    });
  });
}

export const streamProbeDeps = (id: () => string, connect: () => Promise<ProbeLink>): StreamProbeDeps => ({
  id, connect, viewer: openStreamViewer,
  wait: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
});
