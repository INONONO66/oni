import { z } from "zod";

const PAGE = `(window.__probe = (() => {
  const state = { pc: null, remote: [], sidecars: new Map(), received: new Map(), decoded: new Map(), waiters: [], error: null };
  const source = \`let decoder;
    onrtctransform = (event) => {
      const reader = event.transformer.readable.getReader();
      const writer = event.transformer.writable.getWriter();
      decoder = new VideoDecoder({
        output(frame) { postMessage({ kind: "decoded", timestamp: frame.timestamp, at: Date.now() }); frame.close(); },
        error(error) { postMessage({ kind: "error", message: error.message }); },
      });
      decoder.configure({ codec: "avc1.42E01F", avc: { format: "annexb" } });
      (async () => { for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        postMessage({ kind: "received", timestamp: value.timestamp, at: Date.now() });
        decoder.decode(new EncodedVideoChunk({ type: value.type, timestamp: value.timestamp, data: value.data }));
        await writer.write(value);
      } })().catch(error => postMessage({ kind: "error", message: error.message }));
    };\`;
  function joined() {
    return [...state.sidecars.values()].flatMap(sidecar => {
      const receivedAt = state.received.get(sidecar.rtpTimestamp);
      if (receivedAt === undefined) return [];
      return [{ seq: sidecar.seq, capturedAtUs: sidecar.capturedAtUs,
        receivedAt, decodedAt: state.decoded.get(sidecar.rtpTimestamp) ?? null }];
    });
  }
  function settle() {
    const frames = joined();
    state.waiters = state.waiters.filter(waiter => {
      if (state.error !== null) { waiter.reject(new Error(state.error)); return false; }
      if (frames.filter(frame => frame.decodedAt !== null).length < waiter.count) return true;
      waiter.resolve(frames);
      return false;
    });
  }
  function message(event) {
    const item = event.data;
    if (item.kind === "error") state.error = item.message;
    else if (item.kind === "received") state.received.set(item.timestamp, item.at);
    else if (item.kind === "decoded") state.decoded.set(item.timestamp, item.at);
    settle();
  }
  async function add(line) {
    if (state.pc === null) state.remote.push(line);
    else await state.pc.addIceCandidate({ candidate: line, sdpMLineIndex: 0 });
  }
  async function answer(offer) {
    const pc = new RTCPeerConnection({ encodedInsertableStreams: typeof RTCRtpScriptTransform !== "function" });
    state.pc = pc;
    pc.ontrack = event => {
      const video = document.createElement("video");
      video.muted = true; video.autoplay = true;
      video.srcObject = event.streams[0]; document.body.append(video);
      video.play();
      if (typeof RTCRtpScriptTransform === "function") {
        const worker = new Worker(URL.createObjectURL(new Blob([source], { type: "text/javascript" })));
        worker.onmessage = message;
        event.receiver.transform = new RTCRtpScriptTransform(worker, {});
      } else {
        const decoder = new VideoDecoder({
          output(frame) { state.decoded.set(frame.timestamp, Date.now()); frame.close(); settle(); },
          error(error) { state.error = error.message; settle(); },
        });
        decoder.configure({ codec: "avc1.42E01F", avc: { format: "annexb" } });
        const { readable, writable } = event.receiver.createEncodedStreams();
        readable.pipeThrough(new TransformStream({ transform(frame, controller) {
          state.received.set(frame.timestamp, Date.now());
          decoder.decode(new EncodedVideoChunk({ type: frame.type, timestamp: frame.timestamp, data: frame.data }));
          settle(); controller.enqueue(frame);
        } })).pipeTo(writable).catch(error => { state.error = error.message; settle(); });
      }
    };
    pc.ondatachannel = event => {
      event.channel.binaryType = "arraybuffer";
      event.channel.onmessage = message => {
        const sidecar = JSON.parse(new TextDecoder().decode(message.data));
        state.sidecars.set(sidecar.rtpTimestamp, sidecar);
        settle();
      };
    };
    const candidates = [];
    const gathered = new Promise(resolve => {
      pc.onicecandidate = event => {
        if (event.candidate === null) resolve();
        else if (event.candidate.candidate.length > 0)
          candidates.push({ candidate: event.candidate.candidate, sdpMid: event.candidate.sdpMid ?? undefined });
      };
    });
    await pc.setRemoteDescription({ type: "offer", sdp: offer });
    for (const line of state.remote) await add(line);
    await pc.setLocalDescription(await pc.createAnswer());
    await gathered;
    return { sdp: pc.localDescription.sdp, candidates };
  }
  function until(count) {
    return new Promise((resolve, reject) => {
      const waiter = {
        count,
        resolve(frames) { clearTimeout(deadline); resolve(frames); },
        reject(error) { clearTimeout(deadline); reject(error); },
      };
      const deadline = setTimeout(() => {
        state.waiters = state.waiters.filter(entry => entry !== waiter);
        reject(new Error("stream probe decoded frame timed out"));
      }, 30000);
      state.waiters.push(waiter); settle();
    });
  }
  return { answer, add, until };
})(), true)`;

const Answer = z.object({
  sdp: z.string().min(1),
  candidates: z.array(z.object({ candidate: z.string(), sdpMid: z.string().optional() })),
}).strict();
const Frames = z.array(z.object({
  seq: z.number().int().nonnegative(),
  capturedAtUs: z.number().int().nonnegative(),
  receivedAt: z.number().finite(),
  decodedAt: z.number().finite().nullable(),
}).strict());

export interface StreamViewer {
  answer(offer: string): Promise<z.infer<typeof Answer>>;
  candidate(line: string): Promise<void>;
  until(count: number): Promise<z.infer<typeof Frames>>;
  close(): void;
}

/** The headless probe decodes H.264 independently of page visibility. */
export async function openStreamViewer(): Promise<StreamViewer> {
  const view = new Bun.WebView({ width: 64, height: 64 });
  await view.navigate("about:blank");
  z.literal(true).parse(await view.evaluate(PAGE));
  return {
    answer: async (offer) => Answer.parse(await view.evaluate(`window.__probe.answer(${JSON.stringify(offer)})`)),
    candidate: async (line) => {
      await view.evaluate(`window.__probe.add(${JSON.stringify(line)})`);
    },
    until: async (count) => Frames.parse(await view.evaluate(`window.__probe.until(${count})`)),
    close: () => view.close(),
  };
}
