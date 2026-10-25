import { PlainValueSchema, toolWireName, type PlainValue } from "@oni/protocol";
import { Deferred, Effect, Queue, Stream } from "effect";
import { Auth } from "../auth/storage";
import {
  InvalidProviderData, ModelResolutionError, TransportFailure, type LlmError,
} from "../errors";
import { BUNDLED_ROWS, type ProviderRow } from "../provider/rows";
import { authHeaders, echoMatches, sessionUpdate } from "./config";
import { decodeArguments, decodeFrame, type ServerEvent } from "./events";
import type { Realtime, RealtimeEvent, RealtimeToolCall, RealtimeSession } from "./index";

const MAX_QUEUED_PCM_BYTES = 48_000;
const HANDSHAKE_TIMEOUT_MS = 10_000;

export interface RealtimeSocket {
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  send(data: string): void;
  close(code: number): void;
}
export type SocketFactory = (url: string, options: { readonly headers: Readonly<Record<string, string>> }) => RealtimeSocket;

type ResponseState = { readonly id: string; readonly calls: Set<string>; done: boolean; continued: boolean };
type CallState = { readonly response: ResponseState; answered: boolean };

function transport(message: string): TransportFailure {
  return new TransportFailure({ operation: "realtime.socket", message, cause: message });
}

export function makeRealtime(input: {
  readonly authFilePath: string;
  readonly rows?: readonly ProviderRow[];
  readonly socket?: SocketFactory;
  readonly handshakeTimeoutMs?: number;
}): Realtime {
  return {
    open: (request) => Effect.gen(function* () {
      const row = (input.rows ?? BUNDLED_ROWS).find((candidate) => candidate.realtime !== undefined);
      if (row?.realtime === undefined) {
        return yield* new ModelResolutionError({
          provider: "", model: "", reason: "model_not_found", message: "No provider row names a realtime model",
        });
      }
      const selected = { ...row, realtime: row.realtime };
      const auth = yield* Auth.resolve(row.id, input.authFilePath);
      const headers = yield* authHeaders(selected, auth);
      const calls = yield* Queue.unbounded<RealtimeToolCall | null>();
      const events = yield* Queue.unbounded<RealtimeEvent | null>();
      const output = yield* Queue.unbounded<Uint8Array | null>();
      const stopped = yield* Deferred.make<void>();
      const states = new Map<string, CallState>();
      const seen = new Set<string>();
      let active: ResponseState | undefined;
      let closed = false;
      let open = false;
      let created = false;
      const update = sessionUpdate(request, selected);
      let queuedBytes = 0;

      const finish = (reason: string) => {
        if (closed) return;
        closed = true;
        socket.onmessage = null;
        socket.onclose = null;
        socket.onerror = null;
        socket.close(1000);
        Deferred.doneUnsafe(stopped, Effect.void);
        Queue.offerUnsafe(events, { type: "closed", reason });
        Queue.offerUnsafe(events, null);
        Queue.offerUnsafe(calls, null);
        Queue.offerUnsafe(output, null);
      };
      const emitError = (reason: string) => {
        if (!closed) Queue.offerUnsafe(events, { type: "error", reason });
      };
      const socket = yield* Effect.acquireRelease(
        Effect.try({
          try: () => {
            const url = new URL(selected.realtime.endpoint);
            url.searchParams.delete("model");
            // Percent-encode the model (not form `+`), beside any configured query.
            const query = url.searchParams.toString();
            url.search = `${query}${query === "" ? "" : "&"}model=${encodeURIComponent(selected.realtime.model)}`;
            return (input.socket ?? ((href, options) => new WebSocket(href, { headers: options.headers })))(url.href, { headers });
          },
          catch: () => transport("Realtime socket could not open"),
        }),
        () => Effect.sync(() => {
          finish("scope closed");
        }),
      );
      const send = (frame: PlainValue): Effect.Effect<void, LlmError> => Effect.try({
        try: () => {
          if (closed) throw transport("Realtime socket is closed");
          socket.send(JSON.stringify(frame));
        },
        catch: () => transport("Realtime socket send failed"),
      });
      const maybeContinue = (response: ResponseState) => {
        if (!response.done || response.continued || response.calls.size === 0) return;
        if ([...response.calls].some((id) => !states.get(id)?.answered)) return;
        response.continued = true;
        try { socket.send(JSON.stringify({ type: "response.create" })); }
        catch {
          emitError("Realtime socket send failed");
          finish("socket send failed");
          return transport("Realtime socket send failed");
        }
      };
      const handleCall = (frame: Extract<ServerEvent, { type: "response.output_item.done" }>) => {
        const item = frame.item;
        if (item.type !== "function_call" || item.status !== "completed" || item.call_id === undefined) return;
        if (seen.has(item.call_id)) return;
        seen.add(item.call_id);
        const spec = request.tools.find((tool) => toolWireName(tool.name) === item.name);
        const args = decodeArguments(item.arguments ?? "");
        if (spec === undefined || !args.success) {
          emitError(`Invalid completed tool call ${item.call_id}`);
          return;
        }
        const response = active;
        if (response === undefined) {
          emitError(`Tool call ${item.call_id} has no active response`);
          return;
        }
        response.calls.add(item.call_id);
        states.set(item.call_id, { response, answered: false });
        Queue.offerUnsafe(calls, { callId: item.call_id, name: spec.name, arguments: args.data });
      };
      const handle = (frame: ServerEvent) => {
        switch (frame.type) {
          case "response.created":
            active = { id: frame.response.id, calls: new Set(), done: false, continued: false };
            return;
          case "response.done":
            if (active?.id === frame.response.id) {
              active.done = true;
              maybeContinue(active);
              active = undefined;
            }
            return;
          case "response.output_item.done": handleCall(frame); return;
          case "response.output_audio.delta": {
            if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.delta)) {
              emitError("Invalid output audio delta");
              return;
            }
            const pcm = Uint8Array.from(Buffer.from(frame.delta, "base64"));
            if (pcm.byteLength > MAX_QUEUED_PCM_BYTES - queuedBytes) {
              const error = new InvalidProviderData({
                operation: "realtime.audio", message: "Realtime output audio queue overflow",
                cause: "queued PCM byte limit exceeded",
              });
              emitError(error.message);
              finish("output audio overflow");
              return;
            }
            queuedBytes += pcm.byteLength;
            Queue.offerUnsafe(output, pcm);
            return;
          }
          case "conversation.item.input_audio_transcription.completed":
            Queue.offerUnsafe(events, { type: "transcript", speaker: "user", text: frame.transcript });
            return;
          case "response.output_audio_transcript.done":
            Queue.offerUnsafe(events, { type: "transcript", speaker: "assistant", text: frame.transcript });
            return;
          case "error": emitError(frame.error.message); return;
          case "session.created":
          case "session.updated": return;
        }
      };
      const acceptUpdate = (
        frame: Extract<ServerEvent, { type: "session.updated" }>,
        succeed: () => void, fail: (failure: LlmError) => void,
      ) => {
        if (!echoMatches(frame, update.session)) {
          fail(new InvalidProviderData({
            operation: "realtime.handshake", message: "Realtime session echo differs from requested audio or tools",
            cause: "session.updated mismatch",
          }));
          return;
        }
        open = true;
        succeed();
      };
      const handshake = (
        frame: ServerEvent, succeed: () => void, fail: (failure: LlmError) => void,
      ) => {
        if (frame.type === "error") {
          fail(new InvalidProviderData({
            operation: "realtime.handshake", message: "Provider refused realtime session", cause: "provider error",
          }));
          return;
        }
        if (frame.type === "session.created" && !created) {
          created = true;
          try { socket.send(JSON.stringify(update)); }
          catch { fail(transport("Realtime session update failed")); }
          return;
        }
        if (frame.type === "session.updated" && created) acceptUpdate(frame, succeed, fail);
      };
      const receive = (
        message: MessageEvent, succeed: () => void, fail: (failure: LlmError) => void,
      ) => {
        if (closed) return;
        const incoming = decodeFrame(String(message.data));
        if (!incoming.ok) {
          if (open) emitError(incoming.failure.message);
          else fail(incoming.failure);
          return;
        }
        if (incoming.frame === undefined) return;
        if (open) handle(incoming.frame);
        else handshake(incoming.frame, succeed, fail);
      };
      yield* Effect.callback<void, LlmError>((resume) => {
        let settled = false;
        const fail = (error: LlmError) => {
          if (settled) return;
          settled = true;
          resume(Effect.fail(error));
        };
        socket.onclose = (event) => {
          finish(event.reason || `socket closed (${event.code})`);
          if (!open) fail(transport("Realtime socket closed during handshake"));
        };
        socket.onerror = () => {
          if (!open) fail(transport("Realtime socket failed during handshake"));
          else { emitError("Realtime socket failed"); finish("socket failed"); }
        };
        socket.onmessage = (message) => {
          receive(message, () => { settled = true; resume(Effect.void); }, fail);
        };
      }).pipe(Effect.timeoutOrElse({
        duration: input.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS,
        orElse: () => Effect.fail(new TransportFailure({
          operation: "realtime.handshake", message: "Realtime handshake timed out", cause: "handshake timeout",
        })),
      }));
      const supervise = <A, E>(pump: Effect.Effect<A, E>, reason: string) =>
        Effect.raceFirst(pump, Deferred.await(stopped)).pipe(
          Effect.catchCause((cause) => Effect.sync(() => {
            emitError(`${reason}: ${cause}`);
            finish(reason);
          })),
        );
      yield* Effect.forkScoped(supervise(Stream.runForEach(
        Stream.takeWhile(Stream.fromQueue(output), (chunk) => chunk !== null),
        (chunk) => {
          queuedBytes -= chunk.byteLength;
          return request.audioOut(chunk);
        },
      ), "Realtime audio output failed"));
      yield* Effect.forkScoped(supervise(Stream.runForEach(request.audioIn, (chunk) =>
        send({ type: "input_audio_buffer.append", audio: Buffer.from(chunk).toString("base64") }),
      ), "Realtime audio input failed"));
      const session: RealtimeSession = {
        toolCalls: Stream.takeWhile(Stream.fromQueue(calls), (call) => call !== null),
        events: Stream.takeWhile(Stream.fromQueue(events), (event) => event !== null),
        respondTool: (callId, value) => Effect.gen(function* () {
          const state = states.get(callId);
          if (closed || state === undefined || state.answered) {
            return yield* new InvalidProviderData({
              operation: "realtime.respondTool", message: `No unanswered live call ${callId}`,
              cause: closed ? "closed" : "unknown or answered call",
            });
          }
          const valid = PlainValueSchema.safeParse(value);
          if (!valid.success) {
            return yield* new InvalidProviderData({
              operation: "realtime.respondTool", message: `Invalid output for ${callId}`, cause: "invalid plain value",
            });
          }
          yield* send({ type: "conversation.item.create", item: {
            type: "function_call_output", call_id: callId, output: JSON.stringify(valid.data),
          } });
          state.answered = true;
          yield* (maybeContinue(state.response) ?? Effect.void);
        }),
      };
      return session;
    }),
  };
}
