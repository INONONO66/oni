import { expect, test } from "bun:test";
import { type Capability, type Stt, resolveInputParts } from "@oni/llm";
import type { Gateway } from "@oni/protocol";
import { Effect } from "effect";
import type { FilePorts } from "../src/bundles/tools/core/filesystem";
import { MEDIA_BYTE_CAP } from "../src/composition/media";
import { inboxPartBytes, type MediaWarning, mediaDerive } from "../src/composition/media-input";
import { runEffect } from "./helpers/effect";

type ToolMachine = ReturnType<NonNullable<FilePorts["machines"]>["get"]>;
type ExecAnswer = Awaited<ReturnType<ToolMachine["exec"]>>;
type Modality = "text" | "image" | "audio" | "video";

const encode = (text: string) => new TextEncoder().encode(text);
const completed = (exitCode: number, stdout = "", stderr = ""): ExecAnswer => ({
  status: "completed", exitCode, signal: null, truncated: false, stdout: encode(stdout), stderr: encode(stderr),
});
const unsupported = () => Promise.reject(new Error("not under test"));

function machine(options: {
  readonly files?: Record<string, Uint8Array>;
  readonly exec?: (cmd: string) => ExecAnswer | Promise<ExecAnswer>;
  readonly frames?: readonly string[];
  readonly listFails?: boolean;
}) {
  const commands: string[] = [];
  const files: Record<string, Uint8Array> = {
    "/inbox/k2-clip.mp4": encode("video"),
    "/inbox/second.mp4": encode("second video"),
    ...options.files,
  };
  const writes: string[] = [];
  const host: ToolMachine = {
    fs: {
      stat: (path) => {
        const data = files[path];
        return data === undefined
          ? Promise.reject(new Error(`no ${path}`))
          : Promise.resolve({ op: "stat", kind: "file", size: data.byteLength, mtimeMs: 0 });
      },
      read: (path) => {
        const data = files[path];
        return data === undefined
          ? Promise.reject(new Error(`no ${path}`))
          : Promise.resolve({ op: "read", data, bytesRead: data.byteLength, size: data.byteLength, truncated: false });
      },
      list: () => options.listFails ? Promise.reject(new Error("frames unavailable")) : Promise.resolve({
        op: "list", truncated: false,
        entries: [{ name: "stray.txt", kind: "file" }, ...(options.frames ?? []).map((name) => ({ name, kind: "file" as const }))],
      }),
      write: (path, data, settings) => {
        if (settings?.create !== "exclusive" || files[path] !== undefined) return Promise.reject(new Error("not exclusive"));
        files[path] = data;
        writes.push(path);
        return Promise.resolve({ op: "write", bytesWritten: data.byteLength });
      },
    },
    exec: (cmd) => {
      commands.push(cmd);
      return Promise.resolve(cmd.startsWith("rm -f ") ? completed(0) : options.exec?.(cmd) ?? completed(0));
    },
    pty: { open: unsupported, write: unsupported, read: unsupported },
  };
  const ports: FilePorts = { machines: { defaultMachine: "mac", get: () => host } };
  return { ports, commands, writes };
}

function harness(options: Parameters<typeof machine>[0] & {
  readonly input?: readonly Modality[];
  readonly npm?: string;
  readonly style?: "chat" | "responses";
  readonly exported?: boolean;
}) {
  const { ports, commands, writes } = machine(options);
  const exports = () => options.exported === false ? [{ path: "/" }] : [{ path: "/inbox" }];
  const warnings: MediaWarning[] = [];
  const heard: string[] = [];
  const stt: Stt = {
    transcribe: ({ bytes }) => Effect.sync(() => {
      heard.push(new TextDecoder().decode(bytes));
      return { text: "see you at noon" };
    }),
  };
  let nextId = 0;
  const derive = mediaDerive({
    files: ports,
    root: "/inbox",
    exports,
    id: () => `derived-${++nextId}`,
    stt,
    warn: (warning) => warnings.push(warning),
  });
  const model: Capability.InputModel = {
    input: options.input,
    ...(options.npm === undefined ? {} : { api: { npm: options.npm, style: options.style } }),
  };
  const consume = (part: Gateway.MediaPart, candidate = model) => derive(part, candidate);
  return { consume, derive, model, ports, commands, writes, exports, warnings, heard };
}

const voice: Gateway.MediaPart = { kind: "audio", ref: "mac:/inbox/k1-note.ogg", voice: true };
const clip = (durationMs?: number): Gateway.MediaPart => ({
  kind: "video", ref: "mac:/inbox/k2-clip.mp4", ...(durationMs === undefined ? {} : { durationMs }),
});

test("the inbox port reads bytes and mime from the attached machine and refuses refs outside the inbox", async () => {
  const { ports } = machine({ files: { "/inbox/k1-note.ogg": encode("ogg") } });
  const bytes = inboxPartBytes(ports, "/inbox", () => [{ path: "/inbox" }]);

  const read = await runEffect(bytes("mac:/inbox/k1-note.ogg"));
  expect({ text: new TextDecoder().decode(read.bytes), mime: read.mime }).toEqual({ text: "ogg", mime: "audio/ogg" });

  for (const [ref, code] of [
    ["mac:/etc/passwd", "not_inbox"],
    ["other:/inbox/k1-note.ogg", "not_inbox"],
    ["https://cdn.example/a.ogg", "not_inbox"],
    ["mac:/inbox/missing.ogg", "read_failed"],
  ] as const) {
    const refused = await runEffect(Effect.flip(bytes(ref)));
    expect({ name: refused.name, code: refused.data.code, ref: refused.data.ref }).toEqual({ name: "OniPartUnreadable", code, ref });
  }
});

test("the inbox port refuses a part over the media byte cap before reading it", async () => {
  const { ports } = machine({});
  const host = ports.machines?.get("mac");
  if (host === undefined) throw new Error("stub machine missing");
  const capped: FilePorts = {
    machines: {
      defaultMachine: "mac",
      get: () => ({
        ...host,
        fs: { ...host.fs, stat: () => Promise.resolve({ op: "stat", kind: "file", size: MEDIA_BYTE_CAP + 1, mtimeMs: 0 }), read: unsupported },
      }),
    },
  };
  const refused = await runEffect(Effect.flip(inboxPartBytes(capped, "/inbox", () => [{ path: "/inbox" }])("mac:/inbox/big.ogg")));
  expect(refused.data.code).toBe("too_large");
});

test("automatic byte and frame reads refuse an inbox without its own export", async () => {
  const h = harness({ input: ["text", "image"], exported: false, files: { "/inbox/k1-note.ogg": encode("voice") } });
  const refused = await runEffect(Effect.flip(inboxPartBytes(h.ports, "/inbox", h.exports)(voice.ref)));
  expect(refused.data.code).toBe("inbox_not_exported");
  expect(refused.data.detail).toContain("/inbox");
  expect(await runEffect(h.consume(clip(5_000)))).toEqual({ text: "[video 5s, 0 frames]", parts: [] });
  expect(h.warnings).toHaveLength(1);
  expect(h.warnings[0]?.code).toBe("frames_failed");
  expect(h.commands).toEqual([]);
  expect(h.writes).toEqual([]);
});

test("a detached machine whose exports cannot be queried refuses the read", async () => {
  const { ports } = machine({ files: { "/inbox/note": encode("voice") } });
  const bytes = inboxPartBytes(ports, "/inbox", () => { throw new Error("machine detached"); });
  const refusal = await runEffect(Effect.flip(bytes("mac:/inbox/note")));
  expect(refusal.data.code).toBe("read_failed");
  expect(refusal.data.detail).toContain("machine detached");
});

test.each([
  ["ogg", [79, 103, 103, 83], "audio/ogg"],
  ["wav", [82, 73, 70, 70, 0, 0, 0, 0, 87, 65, 86, 69], "audio/wav"],
  ["wav with a binary chunk size", [82, 73, 70, 70, 224, 160, 160, 2, 87, 65, 86, 69], "audio/wav"],
  ["mp3 id3", [73, 68, 51], "audio/mpeg"],
  ["mp3 frame", [255, 251], "audio/mpeg"],
  ["png", [137, 80, 78, 71], "image/png"],
  ["jpeg", [255, 216, 255], "image/jpeg"],
  ["gif87", [71, 73, 70, 56, 55, 97], "image/gif"],
  ["gif89", [71, 73, 70, 56, 57, 97], "image/gif"],
  ["webp", [82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80], "image/webp"],
  ["mp4", [0, 0, 0, 0, ...encode("ftypmp42")], "video/mp4"],
  ["m4a", [0, 0, 0, 0, ...encode("ftypM4A ")], "audio/mp4"],
  ["quicktime", [0, 0, 0, 0, ...encode("ftypqt  ")], "video/quicktime"],
  ["3gp", [0, 0, 0, 0, ...encode("ftyp3gp5")], "video/3gpp"],
  ["webm", [26, 69, 223, 163, 119, 101, 98, 109], "video/webm"],
  ["mkv", [26, 69, 223, 163, 109, 97, 116, 114, 111, 115, 107, 97], "video/x-matroska"],
] satisfies readonly (readonly [string, readonly number[], string])[])("the inbox port sniffs %s before trusting an extensionless filename", async (_name, signature, mime) => {
  const { ports } = machine({ files: { "/inbox/note": Uint8Array.from(signature) } });
  const result = await runEffect(inboxPartBytes(ports, "/inbox", () => [{ path: "/inbox" }])("mac:/inbox/note"));
  expect(result.mime).toBe(mime);
});

test.each([
  ["an ftyp box with an unlisted brand", "photo.heic", [0, 0, 0, 0, ...encode("ftypheic")], "application/octet-stream"],
  ["an ftyp box without a brand", "clip.m4a", [0, 0, 0, 0, ...encode("ftyp")], "audio/mp4"],
  ["a frame sync with a reserved MPEG version", "clip.bin", [255, 239, 0, 0], "application/octet-stream"],
  ["a frame sync with a reserved layer", "clip.bin", [255, 249, 144, 0], "application/octet-stream"],
  ["a frame sync with a reserved bitrate", "clip.bin", [255, 251, 240, 0], "application/octet-stream"],
  ["a frame sync with a reserved sampling rate", "clip.bin", [255, 251, 156, 0], "application/octet-stream"],
] satisfies readonly (readonly [string, string, readonly number[], string])[])("%s sniffs nothing and the filename decides", async (_name, name, signature, mime) => {
  const { ports } = machine({ files: { [`/inbox/${name}`]: Uint8Array.from(signature) } });
  const result = await runEffect(inboxPartBytes(ports, "/inbox", () => [{ path: "/inbox" }])(`mac:/inbox/${name}`));
  expect(result.mime).toBe(mime);
});

test("an extensionless declared WAV reaches the byte source as audio/wav", async () => {
  const wav = Uint8Array.from([82, 73, 70, 70, 0, 0, 0, 0, 87, 65, 86, 69]);
  const { ports } = machine({ files: { "/inbox/note": wav } });
  const read = await runEffect(inboxPartBytes(ports, "/inbox", () => [{ path: "/inbox" }])("mac:/inbox/note"));
  expect({ bytes: read.bytes, mime: read.mime }).toEqual({ bytes: wav, mime: "audio/wav" });
});

test("a voice note the model cannot hear becomes its transcript in the prompt text", async () => {
  const { consume, heard, warnings } = harness({ input: ["text", "image"], files: { "/inbox/k1-note.ogg": encode("ogg-bytes") } });

  const result = await runEffect(consume(voice));

  expect(heard).toEqual(["ogg-bytes"]);
  expect(result).toEqual({ text: "[voice transcript]\nsee you at noon", parts: [] });
  expect(warnings).toEqual([]);
});

test("an audio-capable OpenAI chat model transcribes an ogg voice note it cannot transport", async () => {
  const ogg = { ...voice, mime: "audio/ogg" };
  const { consume, heard, warnings } = harness({
    input: ["text", "image", "audio"], npm: "@ai-sdk/openai", style: "chat",
    files: { "/inbox/k1-note.ogg": encode("ogg-bytes") },
  });
  const result = await runEffect(consume(ogg));
  expect(heard).toEqual(["ogg-bytes"]);
  expect(result.text).toBe("[voice transcript]\nsee you at noon");
  expect(warnings).toEqual([]);
});

test("supported audio passes through untouched", async () => {
  const { consume, heard, commands } = harness({ input: ["text", "audio"], npm: "@ai-sdk/openai", style: "chat" });

  expect(await runEffect(consume({ ...voice, mime: "audio/wav" }))).toEqual({ parts: [] });
  expect({ heard, commands }).toEqual({ heard: [], commands: [] });
});

test("a video-capable model samples unsupported video instead of bypassing degradation", async () => {
  const { consume, commands } = harness({
    input: ["text", "image", "video"], npm: "@ai-sdk/openai", frames: ["frame-01.jpg"],
  });
  const result = await runEffect(consume({ ...clip(8_000), mime: "video/mp4" }));
  expect(commands).toHaveLength(2);
  expect(result.text).toBe("[video 8s, 1 frames]");
  expect(result.parts.at(-1)?.kind).toBe("image");
});

test("a video the model cannot watch is sampled into at most eight frames on the machine", async () => {
  const frames = [...new Array(9).keys()].map((index) => `frame-${String(index + 1).padStart(2, "0")}.jpg`).reverse();
  const { consume, commands, writes, warnings } = harness({ input: ["text", "image"], frames });

  const result = await runEffect(consume(clip(20_000)));

  expect(commands).toEqual([
    "mkdir 'derived-1.frames' && ffmpeg -nostdin -v error -y -i 'derived-1.video' -vf fps=1/3:round=up -frames:v 8 'derived-1.frames/frame-%02d.jpg'",
    "rm -f 'derived-1.video'",
  ]);
  expect(writes).toEqual(["/inbox/derived-1.video"]);
  expect(result.text).toBe("[video 20s, 8 frames]");
  expect(result.parts).toEqual([...frames].sort().slice(0, 8).map((name) => ({
    kind: "image", ref: `mac:/inbox/derived-1.frames/${name}`, name, mime: "image/jpeg",
  })));
  expect(warnings).toEqual([]);
});

test("a video without a duration is probed with ffprobe before sampling", async () => {
  const { consume, commands } = harness({
    input: ["text", "image"],
    frames: ["frame-01.jpg"],
    exec: (cmd) => cmd.startsWith("ffprobe") ? completed(0, "12.5\n") : completed(0),
  });

  const result = await runEffect(consume(clip()));

  expect(commands[1]).toContain("-vf fps=1/2:round=up -frames:v 8");
  expect(result.text).toBe("[video 13s, 1 frames]");
});

test("a failed frame listing warns while retaining the video line and no frames", async () => {
  const { consume, warnings } = harness({ input: ["text", "image"], listFails: true });
  const source = clip(20_000);
  const result = await runEffect(consume(source));
  expect(warnings).toEqual([{ code: "frames_failed", ref: source.ref, detail: "Error: frames unavailable" }]);
  expect(result).toEqual({ text: "[video 20s, 0 frames]", parts: [] });
});

test("a rejected machine command warns and preserves the video line", async () => {
  const h = harness({
    input: ["text", "image"], exec: () => Promise.reject(new Error("machine disconnected")),
  });
  const source = clip(5_000);
  expect(await runEffect(h.consume(source))).toEqual({ text: "[video 5s, 0 frames]", parts: [] });
  expect(h.warnings).toEqual([{ code: "frames_failed", ref: source.ref, detail: "Error: machine disconnected" }]);
});

test("a refused staging write warns without running or removing anything on the machine", async () => {
  const h = harness({ input: ["text", "image"], files: { "/inbox/derived-1.video": encode("another writer") } });
  const source = clip(5_000);
  expect(await runEffect(h.consume(source))).toEqual({ text: "[video 5s, 0 frames]", parts: [] });
  expect(h.warnings).toEqual([{ code: "frames_failed", ref: source.ref, detail: "Error: not exclusive" }]);
  expect({ commands: h.commands, writes: h.writes }).toEqual({ commands: [], writes: [] });
});

test("an absent ffmpeg keeps the text line and warns once across messages", async () => {
  const { consume, warnings } = harness({ input: ["text", "image"], exec: () => completed(127, "", "sh: ffmpeg: not found") });

  const first = await runEffect(consume(clip(20_000)));
  const second = await runEffect(consume({ ...clip(), ref: "mac:/inbox/second.mp4" }));

  expect([first.text, second.text]).toEqual(["[video 20s, 0 frames]", "[video unknown duration, 0 frames]"]);
  expect(first.parts).toEqual([]);
  expect(warnings).toEqual([{
    code: "ffmpeg_missing", ref: "mac:/inbox/k2-clip.mp4",
    detail: "ffmpeg is not on the attached machine; video kept as its duration line",
  }]);
});

test("a text-only model gets the video line without frames, and failures warn instead of throwing", async () => {
  const textOnly = harness({});
  const lined = await runEffect(textOnly.consume(clip(5_000)));
  expect({ result: lined, commands: textOnly.commands }).toEqual({ result: { text: "[video 5s, 0 frames]", parts: [] }, commands: [] });

  const broken = harness({ input: ["text", "image"], exec: () => completed(1, "", "bad codec") });
  const failed = await runEffect(Effect.forEach([clip(5_000), voice], (part) => broken.consume(part)));
  expect(failed).toEqual([{ text: "[video 5s, 0 frames]", parts: [] }, { parts: [] }]);
  expect(broken.warnings.map((warning) => [warning.code, warning.ref])).toEqual([
    ["frames_failed", "mac:/inbox/k2-clip.mp4"],
    ["transcript_failed", "mac:/inbox/k1-note.ogg"],
  ]);

});

test("a text primary leaves extraction available to a later vision candidate and caches frames", async () => {
  const h = harness({ frames: ["frame-01.jpg"] });
  const source = clip(1_000);
  const vision: Capability.InputModel = { input: ["text", "image"], api: { npm: "@ai-sdk/openai", style: "responses" } };
  const first = await runEffect(h.consume(source));
  expect(first).toEqual({ text: "[video 1s, 0 frames]", parts: [] });
  expect(h.commands).toEqual([]);
  const [second, third] = await runEffect(Effect.all([
    h.consume(source, vision), h.consume(source, vision),
  ], { concurrency: "unbounded" }));
  expect(second).toEqual({
    text: "[video 1s, 1 frames]",
    parts: [{ kind: "image", ref: "mac:/inbox/derived-1.frames/frame-01.jpg", name: "frame-01.jpg", mime: "image/jpeg" }],
  });
  expect(third).toEqual(second);
  expect(h.commands).toHaveLength(2);
  expect((await runEffect(h.consume(source))).text).toBe("[video 1s, 1 frames]");
});

test("candidate retries share one transcription including simultaneous requests", async () => {
  const h = harness({ files: { "/inbox/k1-note.ogg": encode("ogg-bytes") } });
  const results = await runEffect(Effect.all([
    h.consume(voice), h.consume(voice, { input: ["text", "image"] }),
  ], { concurrency: "unbounded" }));
  expect(results).toEqual([
    { text: "[voice transcript]\nsee you at noon", parts: [] },
    { text: "[voice transcript]\nsee you at noon", parts: [] },
  ]);
  expect(h.heard).toEqual(["ogg-bytes"]);
});

test("a resolved chat model keeps native WAV without a catalog-shaped ingress decision", async () => {
  const wav = Uint8Array.from([82, 73, 70, 70, 0, 0, 0, 0, 87, 65, 86, 69]);
  const h = harness({
    input: ["text", "audio"], npm: "@ai-sdk/openai", style: "chat", files: { "/inbox/note": wav },
  });
  const result = await runEffect(resolveInputParts({
    parts: [{ kind: "audio", ref: "mac:/inbox/note" }], model: h.model,
    bytes: inboxPartBytes(h.ports, "/inbox", h.exports), derive: h.derive,
  }));
  expect(result).toEqual({ blocks: [{ type: "file", data: wav, mediaType: "audio/wav" }], unaccepted: [] });
  expect(h.heard).toEqual([]);
});

test("source-MIME refusal still derives an audio part without a declared MIME", async () => {
  const h = harness({
    input: ["text", "audio"], npm: "@ai-sdk/openai", style: "chat", files: { "/inbox/k1-note.ogg": encode("OggS") },
  });
  const result = await runEffect(resolveInputParts({
    parts: [voice], model: h.model, bytes: inboxPartBytes(h.ports, "/inbox", h.exports), derive: h.derive,
  }));
  expect(result).toEqual({ blocks: [{ type: "text", text: "[voice transcript]\nsee you at noon" }], unaccepted: [] });
  expect(h.heard).toEqual(["OggS"]);
});
