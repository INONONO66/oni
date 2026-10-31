/**
 * The stream receipt's WebRTC answerer: a headless `Bun.WebView` page that
 * answers the client's send-only H.264 offer, trickles its ICE candidates,
 * and counts every encoded frame the receiver hands its encoded-frame
 * transform (keyframes, bytes and the first keyframe's leading bytes). Waits
 * resolve inside the page on the frame event that satisfies them.
 */
import { z } from "zod";

/** A decoded H.264 pixel counts as masked below this channel sum: lossy decode never returns exact zeros. */
export const MASKED_PIXEL_SUM = 12;

const PAGE = `(window.__viewer = (() => {
  const state = { count: 0, keys: 0, bytes: 0, head: [], sidecars: [], waiters: [], pc: undefined, remote: [], video: undefined };
  const worker = "onrtctransform = (event) => { const t = event.transformer; const r = t.readable.getReader(); const w = t.writable.getWriter(); (async () => { for (;;) { const { value, done } = await r.read(); if (done) break; postMessage({ type: value.type, data: value.data.slice(0, 8), size: value.data.byteLength }); await w.write(value); } })(); };";
  function frame(type, data, size) {
    state.count += 1;
    state.bytes += size;
    if (type === "key") {
      state.keys += 1;
      if (state.head.length === 0) state.head = Array.from(new Uint8Array(data));
    }
    settle();
  }
  function settle() {
    state.waiters = state.waiters.filter((waiter) => {
      if (state.count < waiter.frames || state.keys < waiter.keys) return true;
      waiter.resolve();
      return false;
    });
  }
  function received(event) {
    const video = document.createElement("video");
    video.muted = true;
    video.autoplay = true;
    video.srcObject = event.streams[0];
    document.body.append(video);
    video.play();
    state.video = video;
    if (typeof RTCRtpScriptTransform === "function") {
      const transform = new Worker(URL.createObjectURL(new Blob([worker], { type: "text/javascript" })));
      transform.onmessage = (message) => frame(message.data.type, message.data.data, message.data.size);
      event.receiver.transform = new RTCRtpScriptTransform(transform, {});
      return;
    }
    const { readable, writable } = event.receiver.createEncodedStreams();
    readable.pipeThrough(new TransformStream({ transform(chunk, controller) {
      frame(chunk.type, chunk.data.slice(0, 8), chunk.data.byteLength);
      controller.enqueue(chunk);
    } })).pipeTo(writable);
  }
  async function answer(offer) {
    const pc = new RTCPeerConnection({ encodedInsertableStreams: typeof RTCRtpScriptTransform !== "function" });
    state.pc = pc;
    pc.ontrack = received;
    pc.ondatachannel = (event) => {
      event.channel.binaryType = "arraybuffer";
      event.channel.onmessage = (message) => {
        state.sidecars.push(JSON.parse(new TextDecoder().decode(message.data)));
        settle();
      };
    };
    const candidates = [];
    const gathered = new Promise((resolve) => {
      pc.onicecandidate = (event) => {
        if (event.candidate === null) resolve();
        else if (event.candidate.candidate.length > 0) candidates.push({ candidate: event.candidate.candidate, sdpMid: event.candidate.sdpMid ?? undefined });
      };
    });
    await pc.setRemoteDescription({ type: "offer", sdp: offer });
    for (const line of state.remote) await add(pc, line);
    await pc.setLocalDescription(await pc.createAnswer());
    await gathered;
    return { sdp: pc.localDescription.sdp, candidates };
  }
  async function add(pc, line) {
    try {
      await pc.addIceCandidate({ candidate: line, sdpMLineIndex: 0 });
    } catch (error) {
      throw new Error(error.message + ": " + JSON.stringify(line));
    }
  }
  async function candidate(line) {
    if (state.pc === undefined) state.remote.push(line);
    else await add(state.pc, line);
    return true;
  }
  function until(frames, keys) {
    return new Promise((resolve) => {
      state.waiters.push({ frames, keys, resolve });
      settle();
    }).then(() => ({ count: state.count, keys: state.keys, bytes: state.bytes, head: state.head, sidecars: state.sidecars, connection: state.pc.connectionState }));
  }
  async function diagnose(samples) {
    const video = state.video;
    const inbound = [];
    if (state.pc !== undefined) {
      (await state.pc.getStats()).forEach((entry) => {
        if (entry.type === "inbound-rtp" && entry.kind === "video") inbound.push({ framesReceived: entry.framesReceived ?? null, framesDecoded: entry.framesDecoded ?? null, framesDropped: entry.framesDropped ?? null, decoderImplementation: entry.decoderImplementation ?? null });
        if (entry.type === "codec") inbound.push({ mimeType: entry.mimeType ?? null, sdpFmtpLine: entry.sdpFmtpLine ?? null });
      });
    }
    return {
      visibility: document.visibilityState,
      connection: state.pc === undefined ? null : state.pc.connectionState,
      video: video === undefined ? null : { readyState: video.readyState, width: video.videoWidth, height: video.videoHeight, paused: video.paused, currentTime: video.currentTime },
      inbound,
      samples,
    };
  }
  function untilPixel(x, y, black, budgetMs) {
    return new Promise((resolve, reject) => {
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      const video = state.video;
      if (video === undefined) throw new Error("video track not received");
      const samples = { events: 0, undersized: 0, last: null };
      // Playback progress, not requestVideoFrameCallback: a headless page is hidden, and Chrome
      // never runs rVFC on a hidden document even while it keeps decoding the track.
      const deadline = setTimeout(() => {
        video.removeEventListener("timeupdate", sample);
        diagnose(samples).then((diagnostics) => resolve({ diagnostics }), reject);
      }, budgetMs);
      function sample() {
        samples.events += 1;
        if (video.videoWidth <= x || video.videoHeight <= y) {
          samples.undersized += 1;
          return;
        }
        context.drawImage(video, x, y, 1, 1, 0, 0, 1, 1);
        const rgba = Array.from(context.getImageData(0, 0, 1, 1).data);
        samples.last = rgba;
        if ((rgba[0] + rgba[1] + rgba[2] < ${MASKED_PIXEL_SUM}) === black) {
          clearTimeout(deadline);
          video.removeEventListener("timeupdate", sample);
          resolve({ rgba });
        }
      }
      video.addEventListener("timeupdate", sample);
      sample();
    });
  }
  return { answer, candidate, until, untilPixel };
})(), true)`;

const Answer = z
  .object({
    sdp: z.string().min(1),
    candidates: z.array(z.object({ candidate: z.string().min(1), sdpMid: z.string().optional() })),
  })
  .strict();
export type ViewerAnswer = z.infer<typeof Answer>;

const Frames = z
  .object({
    count: z.number().int(),
    keys: z.number().int(),
    bytes: z.number().int(),
    head: z.array(z.number().int()),
    sidecars: z.array(z.object({ seq: z.number().int().nonnegative(), capturedAtUs: z.number().int().nonnegative() }).strict()),
    connection: z.string(),
  })
  .strict();
export type ViewerFrames = z.infer<typeof Frames>;

const Pixel = z.array(z.number().int().min(0).max(255)).length(4);

/** What the page knows about its decode path when a pixel wait exhausts its budget. */
const Diagnostics = z
  .object({
    visibility: z.string(),
    connection: z.string().nullable(),
    video: z
      .object({
        readyState: z.number().int(),
        width: z.number().int(),
        height: z.number().int(),
        paused: z.boolean(),
        currentTime: z.number(),
      })
      .strict()
      .nullable(),
    inbound: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.null()]))),
    samples: z.object({ events: z.number().int(), undersized: z.number().int(), last: Pixel.nullable() }).strict(),
  })
  .strict();

/** One page round-trip: the matching pixel, or the diagnostics after `budgetMs` without one. */
const PixelOutcome = z.union([
  z.object({ rgba: Pixel }).strict(),
  z.object({ diagnostics: Diagnostics }).strict(),
]);

/** Shorter than the harness step timeout so the page answers with diagnostics before the step gives up. */
const PIXEL_BUDGET_MS = 45_000;

export interface Viewer {
  answer(offer: string): Promise<ViewerAnswer>;
  candidate(line: string): Promise<void>;
  until(frames: number, keys: number): Promise<ViewerFrames>;
  /** Resolves with the first sampled pixel whose masked state equals `black`; throws with the page's decode diagnostics when none arrives within the budget. */
  untilPixel(x: number, y: number, black: boolean): Promise<readonly number[]>;
  close(): void;
}

export async function openViewer(): Promise<Viewer> {
  const view = new Bun.WebView({ width: 64, height: 64 });
  await view.navigate("about:blank");
  z.literal(true).parse(await view.evaluate(PAGE));
  return {
    answer: async (offer) =>
      Answer.parse(await view.evaluate(`window.__viewer.answer(${JSON.stringify(offer)})`)),
    candidate: async (line) => {
      z.literal(true).parse(
        await view.evaluate(
          `window.__viewer.candidate(${JSON.stringify(line)})`,
        ),
      );
    },
    until: async (frames, keys) =>
      Frames.parse(await view.evaluate(`window.__viewer.until(${frames}, ${keys})`)),
    untilPixel: async (x, y, black) => {
      const outcome = PixelOutcome.parse(
        await view.evaluate(`window.__viewer.untilPixel(${x}, ${y}, ${black}, ${PIXEL_BUDGET_MS})`),
      );
      if ("rgba" in outcome) return outcome.rgba;
      throw new Error(
        `no ${black ? "masked" : "ordinary"} pixel at ${x},${y} within ${PIXEL_BUDGET_MS} ms; viewer ${JSON.stringify(outcome.diagnostics)}`,
      );
    },
    close: () => view.close(),
  };
}
