import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseJson } from "@oni/protocol";
import { Cause, Deferred, Effect, Exit, Fiber, Option, Stream } from "effect";
import { z } from "zod";
import { Auth, makeRealtime, ProviderRow } from "../src";
import type { RealtimeEvent } from "../src/realtime";
import type { RealtimeSocket } from "../src/realtime/openai";
import type { RealtimeOpenInput } from "../src/realtime";
import { runTestExit } from "./helpers/runner";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

async function credentials(info: Auth.Info): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "oni-realtime-"));
  dirs.push(dir);
  const path = join(dir, "auth.json");
  expect(await runTestExit(Auth.set("openai", info, { id: () => "realtime", authFilePath: path }))).toEqual(Exit.succeed(undefined));
  return path;
}

const tools: RealtimeOpenInput["tools"] = [
  { name: "file.read", description: "Read a file", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
  { name: "file.write", description: "Write a file", inputSchema: { type: "object", properties: {} } },
];
const request: RealtimeOpenInput = {
  instructions: "Act on the caller's instructions",
  tools,
  audioIn: Stream.empty,
  audioOut: () => Effect.void,
};

const clientFrame = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session.update"), session: z.object({
    type: z.literal("realtime"), model: z.string(), output_modalities: z.array(z.literal("audio")),
    instructions: z.string(),
    tools: z.array(z.object({
      type: z.literal("function"), name: z.string(), description: z.string(), parameters: z.json().optional(),
    })),
    audio: z.object({
      input: z.object({
        format: z.object({ type: z.string(), rate: z.number() }),
        turn_detection: z.object({ type: z.string(), create_response: z.boolean() }),
        transcription: z.object({ model: z.string() }),
      }),
      output: z.object({ format: z.object({ type: z.string(), rate: z.number() }), voice: z.string() }),
    }),
  }) }),
  z.object({ type: z.literal("input_audio_buffer.append"), audio: z.string() }),
  z.object({ type: z.literal("conversation.item.create"), item: z.object({
    type: z.literal("function_call_output"), call_id: z.string(), output: z.string(),
  }) }),
  z.object({ type: z.literal("response.create") }),
]);

class Socket implements RealtimeSocket {
  readonly sent: z.infer<typeof clientFrame>[] = [];
  readonly closes: number[] = [];
  readonly echo: "valid" | "mismatch" | "error" | "close" | "socketError";
  echoField?: "vad" | "createResponse" | "transcription" | "voice" | "inputType" | "outputType" | "outputRate" | "tools";
  silent = false;
  throwOn?: string;
  private listener: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  constructor(echo: "valid" | "mismatch" | "error" | "close" | "socketError" = "valid") { this.echo = echo; }
  get onmessage() { return this.listener; }
  set onmessage(listener: ((event: MessageEvent) => void) | null) {
    this.listener = listener;
    if (listener !== null) {
      if (this.echo === "error") this.push({ type: "error", error: { message: "unavailable" } });
      else if (this.echo === "close") this.remoteClose();
      else if (this.echo === "socketError") this.onerror?.(new Event("error"));
      else if (!this.silent) this.push({ type: "session.created" });
    }
  }
  push(frame: object) { this.listener?.(new MessageEvent("message", { data: JSON.stringify(frame) })); }
  raw(data: string) { this.listener?.(new MessageEvent("message", { data })); }
  send(data: string) {
    const frame = parseJson(clientFrame, data);
    if (frame === undefined) throw new Error("Malformed client frame");
    if (frame.type === this.throwOn) throw new Error("injected socket failure");
    this.sent.push(frame);
    if (frame.type === "session.update") {
      const audio = frame.session.audio;
      this.push({
        type: "session.updated",
        session: {
          audio: {
            input: {
              format: { type: this.echoField === "inputType" ? "audio/other" : audio.input.format.type,
                rate: this.echo === "mismatch" ? 16000 : audio.input.format.rate },
              turn_detection: this.echoField === "vad" ? null : {
                ...audio.input.turn_detection, create_response: this.echoField !== "createResponse",
              },
              transcription: this.echoField === "transcription" ? null : audio.input.transcription,
            },
            output: {
              format: { type: this.echoField === "outputType" ? "audio/other" : audio.output.format.type,
                rate: this.echoField === "outputRate" ? 16000 : audio.output.format.rate },
              voice: this.echoField === "voice" ? "wrong" : audio.output.voice,
            },
          },
          tools: this.echoField === "tools" ? [] : frame.session.tools.map((tool) => ({ name: tool.name })),
        },
      });
    }
  }
  close(code: number) { this.closes.push(code); }
  remoteClose(reason = "remote closed") { this.onclose?.(new CloseEvent("close", { code: 1000, reason })); }
}

function failure<A, E>(exit: Exit.Exit<A, E>): E | undefined {
  if (Exit.isSuccess(exit)) return undefined;
  const error = Cause.findErrorOption(exit.cause);
  return Option.isSome(error) ? error.value : undefined;
}

function socketSession(socket: Socket, input: RealtimeOpenInput = request) {
  return Effect.gen(function* () {
    const authFilePath = yield* Effect.promise(() => credentials({ type: "api", key: "key" }));
    return yield* makeRealtime({ authFilePath, socket: () => socket }).open(input);
  });
}

function completedCall(socket: Socket, id = "c") {
  socket.push({ type: "response.created", response: { id: "r" } });
  socket.push({ type: "response.output_item.done", item: {
    type: "function_call", status: "completed", call_id: id, name: "file_read", arguments: "{}",
  } });
}

function socketEvents(socket: Socket, count: number, emit: () => void) {
  return Effect.scoped(Effect.gen(function* () {
    const session = yield* socketSession(socket);
    const events = yield* Effect.forkScoped(Stream.runCollect(Stream.take(session.events, count)));
    emit();
    return yield* Fiber.join(events);
  }));
}

function reasons<E>(exit: Exit.Exit<readonly RealtimeEvent[], E>): string[] {
  return Exit.isSuccess(exit) ? exit.value.map((event) => event.type === "transcript" ? "" : event.reason) : [];
}

describe("realtime socket", () => {
  test("a configured endpoint query survives beside the model selection", async () => {
    const authFilePath = await credentials({ type: "api", key: "key" });
    const socket = new Socket();
    const urls: string[] = [];
    const exit = await runTestExit(Effect.scoped(makeRealtime({
      authFilePath,
      rows: [ProviderRow.parse({
        id: "openai", npm: "@ai-sdk/openai",
        realtime: { endpoint: "wss://hub.test/v1/realtime?api-version=v1", model: "custom", voice: "marin" },
      })],
      socket: (url) => { urls.push(url); return socket; },
    }).open(request)));
    expect(Exit.isSuccess(exit)).toBe(true);
    const url = new URL(urls[0] ?? "https://missing.test");
    expect(url.searchParams.get("model")).toBe("custom");
    expect(url.searchParams.get("api-version")).toBe("v1");
  });

  test("sends exact session configuration, bearer and encoded model URL", async () => {
    const socket = new Socket();
    const seen: { url: string; headers: Readonly<Record<string, string>> }[] = [];
    const authFilePath = await credentials({ type: "api", key: "sk-voice" });
    const exit = await runTestExit(Effect.scoped(Effect.gen(function* () {
      yield* makeRealtime({ authFilePath, socket: (url, options) => {
        seen.push({ url, headers: options.headers }); return socket;
      } }).open(request);
      return socket.sent[0];
    })));
    expect(exit).toEqual(Exit.succeed({
      type: "session.update",
      session: {
        type: "realtime", model: "gpt-realtime-2.1", output_modalities: ["audio"],
        instructions: request.instructions,
        tools: [
          { type: "function", name: "file_read", description: "Read a file", parameters: tools[0]?.inputSchema },
          { type: "function", name: "file_write", description: "Write a file", parameters: tools[1]?.inputSchema },
        ],
        audio: {
          input: { format: { type: "audio/pcm", rate: 24000 },
            turn_detection: { type: "semantic_vad", create_response: true },
            transcription: { model: "gpt-4o-mini-transcribe" } },
          output: { format: { type: "audio/pcm", rate: 24000 }, voice: "marin" },
        },
      },
    }));
    expect(seen).toEqual([{ url: "wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1", headers: { Authorization: "Bearer sk-voice" } }]);
    expect(socket.closes).toEqual([1000]);
  });

  test("accepts same-host proxy but refuses foreign host before socket construction", async () => {
    const rows = [ProviderRow.parse({
      id: "openai", npm: "@ai-sdk/openai", headers: { "X-Tenant": "owner" },
      realtime: { endpoint: "wss://hub.test/v1/realtime", model: "live model", voice: "marin" },
    })];
    const authFilePath = await credentials({ type: "proxy", baseURL: "https://hub.test/v1", apiKey: "proxy-secret" });
    const socket = new Socket();
    const seen: object[] = [];
    const accepted = await runTestExit(Effect.scoped(makeRealtime({
      authFilePath, rows, socket: (url, options) => {
        seen.push({ url, headers: options.headers }); return socket;
      },
    }).open(request)));
    expect(Exit.isSuccess(accepted)).toBe(true);
    expect(seen).toEqual([{
      url: "wss://hub.test/v1/realtime?model=live%20model",
      headers: { "X-Tenant": "owner", Authorization: "Bearer proxy-secret" },
    }]);
    const refused = await runTestExit(Effect.scoped(makeRealtime({
      authFilePath, rows: [ProviderRow.parse({
        ...rows[0], realtime: { endpoint: "wss://api.openai.com/v1/realtime", model: "live", voice: "marin" },
      })],
      socket: () => { throw new Error("socket factory must not run"); },
    }).open(request)));
    expect(failure(refused)).toMatchObject({ _tag: "AuthResolutionError", reason: "invalid_auth" });
  });

  test("refuses absent realtime row, mismatched echo and early provider error with typed errors", async () => {
    const authFilePath = await credentials({ type: "api", key: "sk-voice" });
    const noRow = await runTestExit(Effect.scoped(makeRealtime({
      authFilePath, rows: [ProviderRow.parse({ id: "openai", npm: "@ai-sdk/openai" })],
      socket: () => { throw new Error("unexpected socket"); },
    }).open(request)));
    expect(failure(noRow)).toMatchObject({ _tag: "ModelResolutionError", reason: "model_not_found" });
    for (const echo of ["mismatch", "error"] as const) {
      const result = await runTestExit(Effect.scoped(makeRealtime({
        authFilePath, socket: () => new Socket(echo),
      }).open(request)));
      expect(failure(result)).toMatchObject({ _tag: "InvalidProviderData", operation: "realtime.handshake" });
    }
  });

  test("refuses each mismatched field in the requested session echo", async () => {
    for (const field of ["vad", "createResponse", "transcription", "voice",
      "inputType", "outputType", "outputRate", "tools"] as const) {
      const socket = new Socket();
      socket.echoField = field;
      const result = await runTestExit(Effect.scoped(socketSession(socket)));
      expect(failure(result)).toMatchObject({ _tag: "InvalidProviderData", operation: "realtime.handshake" });
      expect(socket.closes).toEqual([1000]);
    }
  });

  test("times out a silent handshake without waiting", async () => {
    const socket = new Socket();
    socket.silent = true;
    const authFilePath = await credentials({ type: "api", key: "key" });
    const result = await runTestExit(Effect.scoped(makeRealtime({
      authFilePath, socket: () => socket, handshakeTimeoutMs: 0,
    }).open(request)));
    expect(failure(result)).toMatchObject({ _tag: "TransportFailure", operation: "realtime.handshake" });
    expect(socket.closes).toEqual([1000]);
  });

  test("fails malformed outgoing client frames at the fake socket boundary", () => {
    expect(() => new Socket().send('{"type":"session.update","session":{"tools":"broken"}}')).toThrow("Malformed client frame");
  });

  test("ends both streams and closes the socket when playback fails", async () => {
    const socket = new Socket();
    const exit = await runTestExit(Effect.scoped(Effect.gen(function* () {
      const failed = yield* Deferred.make<void>();
      const session = yield* socketSession(socket, { ...request, audioOut: () => Effect.die(new Error("playback failed")).pipe(
        Effect.ensuring(Deferred.succeed(failed, undefined)),
      ) });
      const events = yield* Effect.forkScoped(Stream.runCollect(session.events));
      const calls = yield* Effect.forkScoped(Stream.runCollect(session.toolCalls));
      socket.push({ type: "response.output_audio.delta", delta: "AQI=" });
      yield* Deferred.await(failed);
      return { events: [...(yield* Fiber.join(events))], calls: [...(yield* Fiber.join(calls))] };
    })));
    expect(Exit.isSuccess(exit) && exit.value.calls).toEqual([]);
    expect(Exit.isSuccess(exit) && exit.value.events.map((event) => event.type)).toEqual(["error", "closed"]);
    expect(Exit.isSuccess(exit) && exit.value.events[0]?.type === "error"
      && exit.value.events[0].reason).toContain("Realtime audio output failed");
    expect(socket.closes).toEqual([1000]);
  });

  test("ends a failing input stream and closes the socket", async () => {
    const socket = new Socket();
    const exit = await runTestExit(Effect.scoped(Effect.gen(function* () {
      const session = yield* socketSession(socket, { ...request, audioIn: Stream.die(new Error("microphone failed")) });
      return yield* Stream.runCollect(session.events);
    })));
    expect(Exit.isSuccess(exit) && [...exit.value].map((event) => event.type)).toEqual(["error", "closed"]);
    expect(reasons(exit)[0]).toContain("Realtime audio input failed");
    expect(socket.closes).toEqual([1000]);
  });

  test("allows exactly the queued PCM byte budget then ends on one byte more", async () => {
    for (const extra of [0, 1]) {
      const socket = new Socket();
      const exit = await runTestExit(Effect.scoped(Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const session = yield* socketSession(socket, {
          ...request, audioOut: () => Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
          ),
        });
        const events = yield* Effect.forkScoped(Stream.runCollect(session.events));
        socket.push({ type: "response.output_audio.delta", delta: "AQ==" });
        yield* Deferred.await(entered);
        socket.push({ type: "response.output_audio.delta", delta: Buffer.alloc(48_000 + extra).toString("base64") });
        const closes = [...socket.closes];
        yield* Deferred.succeed(release, undefined);
        if (extra === 0) socket.remoteClose("done");
        return { closes, events: [...(yield* Fiber.join(events))] };
      })));
      expect(Exit.isSuccess(exit) && exit.value).toMatchObject(extra === 0
        ? { closes: [], events: [{ type: "closed", reason: "done" }] }
        : { closes: [1000], events: [
          { type: "error", reason: "Realtime output audio queue overflow" },
          { type: "closed", reason: "output audio overflow" },
        ] });
    }
  });

  test("streams input base64, ordered output bytes and both transcripts", async () => {
    const socket = new Socket();
    const heard: number[][] = [];
    const exit = await runTestExit(Effect.scoped(Effect.gen(function* () {
      const session = yield* socketSession(socket, {
        ...request,
        audioIn: Stream.fromIterable([new Uint8Array([0, 255, 1]), new Uint8Array([2, 3])]),
        audioOut: (pcm) => Effect.sync(() => { heard.push([...pcm]); }),
      });
      const transcripts = yield* Effect.forkScoped(Stream.runCollect(Stream.take(session.events, 2)));
      socket.push({ type: "conversation.item.input_audio_transcription.completed", transcript: "hello" });
      socket.push({ type: "response.output_audio_transcript.done", transcript: "hi" });
      socket.push({ type: "response.output_audio.delta", delta: "AQI=" });
      socket.push({ type: "response.output_audio.delta", delta: "A/8=" });
      return yield* Fiber.join(transcripts);
    })));
    expect(Exit.isSuccess(exit) && [...exit.value]).toEqual([
      { type: "transcript", speaker: "user", text: "hello" },
      { type: "transcript", speaker: "assistant", text: "hi" },
    ]);
    expect(socket.sent.filter((frame) => "type" in frame && frame.type === "input_audio_buffer.append")).toEqual([
      { type: "input_audio_buffer.append", audio: "AP8B" },
      { type: "input_audio_buffer.append", audio: "AgM=" },
    ]);
    expect(heard).toEqual([[1, 2], [3, 255]]);
  });

  test("deduplicates calls, defers one continuation for two answers and refuses repeated answers", async () => {
    const socket = new Socket();
    const exit = await runTestExit(Effect.scoped(Effect.gen(function* () {
      const session = yield* socketSession(socket);
      const pending = yield* Effect.forkScoped(Stream.runCollect(Stream.take(session.toolCalls, 2)));
      socket.push({ type: "response.created", response: { id: "r1" } });
      for (const [call_id, name] of [["c1", "file_read"], ["c2", "file_write"]]) {
        socket.push({ type: "response.output_item.done", item: {
          type: "function_call", status: "completed", call_id, name, arguments: "{\"path\":\"a\"}",
        } });
      }
      socket.push({ type: "response.output_item.done", item: {
        type: "function_call", status: "completed", call_id: "c1", name: "file_read", arguments: "{}",
      } });
      const calls = yield* Fiber.join(pending);
      yield* session.respondTool("c1", { ok: true });
      const beforeDone = socket.sent.filter((frame) => frame.type === "response.create").length;
      socket.push({ type: "response.done", response: { id: "r1" } });
      yield* session.respondTool("c2", { ok: false });
      const duplicate = yield* Effect.exit(session.respondTool("c1", "again"));
      const unknown = yield* Effect.exit(session.respondTool("missing", "no"));
      return { calls: [...calls], beforeDone, duplicate: failure(duplicate), unknown: failure(unknown) };
    })));
    expect(Exit.isSuccess(exit) && exit.value).toMatchObject({
      calls: [
        { callId: "c1", name: "file.read", arguments: { path: "a" } },
        { callId: "c2", name: "file.write", arguments: { path: "a" } },
      ],
      beforeDone: 0,
      duplicate: { _tag: "InvalidProviderData" },
      unknown: { _tag: "InvalidProviderData" },
    });
    expect(socket.sent.filter((frame) => "type" in frame && ["conversation.item.create", "response.create"].includes(String(frame.type)))).toEqual([
      { type: "conversation.item.create", item: { type: "function_call_output", call_id: "c1", output: "{\"ok\":true}" } },
      { type: "conversation.item.create", item: { type: "function_call_output", call_id: "c2", output: "{\"ok\":false}" } },
      { type: "response.create" },
    ]);
  });

  test("invalid arguments and unknown wire names yield events without calls; close ends streams and refuses answers", async () => {
    const socket = new Socket();
    const exit = await runTestExit(Effect.scoped(Effect.gen(function* () {
      const session = yield* socketSession(socket);
      const calls = yield* Effect.forkScoped(Stream.runCollect(session.toolCalls));
      const events = yield* Effect.forkScoped(Stream.runCollect(session.events));
      socket.push({ type: "response.created", response: { id: "r" } });
      socket.push({ type: "response.output_item.done", item: {
        type: "function_call", status: "completed", call_id: "bad", name: "file_read", arguments: "[]",
      } });
      socket.push({ type: "response.output_item.done", item: {
        type: "function_call", status: "completed", call_id: "missing", name: "no_tool", arguments: "{}",
      } });
      socket.remoteClose("finished");
      return {
        calls: [...(yield* Fiber.join(calls))], events: [...(yield* Fiber.join(events))],
        refusal: failure(yield* Effect.exit(session.respondTool("bad", 1))),
      };
    })));
    expect(Exit.isSuccess(exit) && exit.value.calls).toEqual([]);
    expect(Exit.isSuccess(exit) && exit.value.events).toEqual([
        { type: "error", reason: "Invalid completed tool call bad" },
        { type: "error", reason: "Invalid completed tool call missing" },
        { type: "closed", reason: "finished" },
      ]);
    expect(Exit.isSuccess(exit) && exit.value.refusal).toMatchObject({ _tag: "InvalidProviderData", cause: "closed" });
  });

  test("rejects malformed rows and socket construction failures", async () => {
    expect(ProviderRow.safeParse({
      id: "openai", npm: "@ai-sdk/openai",
      realtime: { endpoint: "https://api.openai.com/v1/realtime", model: "m", voice: "v" },
    }).success).toBe(false);
    expect(ProviderRow.safeParse({
      id: "openai", npm: "@ai-sdk/openai",
      realtime: { endpoint: "wss://api.openai.com/v1/realtime", model: "m", voice: "v", extra: true },
    }).success).toBe(false);
    const authFilePath = await credentials({ type: "api", key: "key" });
    const exit = await runTestExit(Effect.scoped(makeRealtime({
      authFilePath, socket: () => { throw new Error("transport offline"); },
    }).open(request)));
    expect(failure(exit)).toMatchObject({ _tag: "TransportFailure", operation: "realtime.socket" });
  });

  test("fails typed when socket closes, errors or rejects session update during handshake", async () => {
    const authFilePath = await credentials({ type: "api", key: "key" });
    for (const echo of ["close", "socketError"] as const) {
      const exit = await runTestExit(Effect.scoped(makeRealtime({
        authFilePath, socket: () => new Socket(echo),
      }).open(request)));
      expect(failure(exit)).toMatchObject({ _tag: "TransportFailure", operation: "realtime.socket" });
    }
    const socket = new Socket();
    socket.throwOn = "session.update";
    const exit = await runTestExit(Effect.scoped(makeRealtime({ authFilePath, socket: () => socket }).open(request)));
    expect(failure(exit)).toMatchObject({ _tag: "TransportFailure", message: "Realtime session update failed" });
  });

  test("reports malformed provider frames, invalid audio and post-open provider errors", async () => {
    const socket = new Socket();
    const exit = await runTestExit(socketEvents(socket, 3, () => {
      socket.raw("{");
      socket.push({ type: "response.output_audio.delta", delta: "not base64" });
      socket.push({ type: "error", error: { message: "service unavailable" } });
    }));
    expect(Exit.isSuccess(exit) && exit.value).toEqual([
      { type: "error", reason: "Invalid realtime frame" },
      { type: "error", reason: "Invalid output audio delta" },
      { type: "error", reason: "service unavailable" },
    ]);
  });

  test("rejects malformed arguments once, unsupported calls and calls outside a response", async () => {
    const socket = new Socket();
    const exit = await runTestExit(socketEvents(socket, 3, () => {
      socket.push({ type: "response.output_item.done", item: {
        type: "function_call", status: "completed", call_id: "orphan", name: "file_read", arguments: "{}",
      } });
      socket.push({ type: "response.created", response: { id: "r" } });
      for (const _ of [0, 1]) socket.push({ type: "response.output_item.done", item: {
        type: "function_call", status: "completed", call_id: "invalid", name: "file_read", arguments: "{",
      } });
      socket.push({ type: "response.output_item.done", item: {
        type: "function_call", status: "completed", call_id: "array", name: "file_read", arguments: "[]",
      } });
    }));
    expect(Exit.isSuccess(exit) && exit.value).toEqual([
      { type: "error", reason: "Tool call orphan has no active response" },
      { type: "error", reason: "Invalid completed tool call invalid" },
      { type: "error", reason: "Invalid completed tool call array" },
    ]);
  });

  test("respondTool refuses invalid output and reports socket send failure", async () => {
    const socket = new Socket();
    const exit = await runTestExit(Effect.scoped(Effect.gen(function* () {
      const session = yield* socketSession(socket);
      completedCall(socket);
      const invalid = yield* Effect.exit(session.respondTool("c", Number.NaN));
      socket.throwOn = "conversation.item.create";
      const rejected = yield* Effect.exit(session.respondTool("c", "valid"));
      return { invalid: failure(invalid), rejected: failure(rejected) };
    })));
    expect(Exit.isSuccess(exit) && exit.value).toMatchObject({
      invalid: { _tag: "InvalidProviderData", operation: "realtime.respondTool" },
      rejected: { _tag: "TransportFailure", operation: "realtime.socket" },
    });
  });

  test("ignores unrecognized events, reports malformed known frames and ignores post-open session notices", async () => {
    const socket = new Socket();
    const exit = await runTestExit(socketEvents(socket, 2, () => {
      socket.push({ type: "response.future_event", value: true });
      socket.push({ type: "session.created" });
      socket.push({});
      socket.push({ type: "response.output_audio.delta", delta: 42 });
    }));
    expect(Exit.isSuccess(exit) && exit.value).toEqual([
      { type: "error", reason: "Invalid realtime frame" },
      { type: "error", reason: "Invalid realtime response.output_audio.delta frame" },
    ]);
  });

  test("an input-send failure closes the streams with an error event", async () => {
    const socket = new Socket();
    socket.throwOn = "input_audio_buffer.append";
    const exit = await runTestExit(Effect.scoped(Effect.gen(function* () {
      const session = yield* socketSession(socket, {
        ...request, audioIn: Stream.fromIterable([new Uint8Array([1, 2])]),
      });
      return yield* Stream.runCollect(session.events);
    })));
    expect(Exit.isSuccess(exit) && exit.value.map((event) => event.type)).toEqual(["error", "closed"]);
    expect(reasons(exit)[0]).toContain("Realtime audio input failed");
  });

  test("a failed response.create is a typed refusal rather than a successful tool reply", async () => {
    const socket = new Socket();
    socket.throwOn = "response.create";
    const exit = await runTestExit(Effect.scoped(Effect.gen(function* () {
      const session = yield* socketSession(socket);
      completedCall(socket);
      socket.push({ type: "response.done", response: { id: "r" } });
      return failure(yield* Effect.exit(session.respondTool("c", { result: "ok" })));
    })));
    expect(Exit.isSuccess(exit) && exit.value).toMatchObject({
      _tag: "TransportFailure", message: "Realtime socket send failed",
    });
  });
});
