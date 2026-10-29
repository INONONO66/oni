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
  const state = { count: 0, keys: 0, bytes: 0, head: [], waiters: [], pc: undefined, remote: [], video: undefined };
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
    }).then(() => ({ count: state.count, keys: state.keys, bytes: state.bytes, head: state.head, connection: state.pc.connectionState }));
  }
  function untilPixel(x, y, black) {
    return new Promise((resolve) => {
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      const video = state.video;
      if (video === undefined) throw new Error("video track not received");
      function sample() {
        video.requestVideoFrameCallback(() => {
          if (video.videoWidth <= x || video.videoHeight <= y) {
            sample();
            return;
          }
          context.drawImage(video, x, y, 1, 1, 0, 0, 1, 1);
          const rgba = Array.from(context.getImageData(0, 0, 1, 1).data);
          if ((rgba[0] + rgba[1] + rgba[2] < ${MASKED_PIXEL_SUM}) === black) resolve(rgba);
          else sample();
        });
      }
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
    connection: z.string(),
  })
  .strict();
export type ViewerFrames = z.infer<typeof Frames>;

export interface Viewer {
  answer(offer: string): Promise<ViewerAnswer>;
  candidate(line: string): Promise<void>;
  until(frames: number, keys: number): Promise<ViewerFrames>;
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
    untilPixel: async (x, y, black) =>
      z.array(z.number().int().min(0).max(255)).length(4).parse(
        await view.evaluate(`window.__viewer.untilPixel(${x}, ${y}, ${black})`),
      ),
    close: () => view.close(),
  };
}
