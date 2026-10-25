import { Core } from "@oni/agent";
import { VoiceJoinRefused, type PersonStore, type ProviderVoiceRoute, type PcmVoiceHandle } from "@oni/channels";
import type { Realtime, RealtimeSession, RealtimeToolCall } from "@oni/llm";
import { toolResultText, type PlainValue, type Tool } from "@oni/protocol";
import { Effect, Stream } from "effect";
import { createDownsampler, createUpsampler } from "./live-pcm";
import type { CallPort } from "../bundles/messaging/send-message/index";

interface CallRequest {
  readonly contact: string;
  readonly surface: string;
  readonly channelId: string;
  readonly opening?: string;
  readonly sessionId: string;
  readonly turnId: string;
}

interface CallReceipt {
  readonly contact: string;
  readonly status: "joined";
  readonly call: string;
  readonly surface: string;
  readonly channelId: string;
}

export type CallEndReason =
  | "owner_left" | "voice_disconnected" | "voice_error"
  | "realtime_closed" | "realtime_error" | "interrupted" | "shutdown";

interface LiveCallEnd {
  readonly sessionId: string;
  readonly call: string;
  readonly reason: CallEndReason;
  readonly releaseFailure?: string;
}

export interface LiveVoiceInputs {
  readonly routes: ReadonlyMap<string, ProviderVoiceRoute>;
  readonly realtime: Realtime;
  readonly persons: Pick<PersonStore, "get">;
  readonly role: (sessionId: string) => string | undefined;
  readonly id: () => string;
  readonly run: <A, E>(effect: Effect.Effect<A, E>, signal?: AbortSignal) => Promise<A>;
  readonly ended: (outcome: LiveCallEnd) => void;
  readonly executeTool: (
    sessionId: string,
    input: { readonly sourceTurnId: string; readonly call: Tool.Call; readonly waitMs: number },
  ) => Effect.Effect<Tool.Result, Error>;
}

interface ActiveCall {
  readonly stop: (reason: CallEndReason) => Promise<void>;
  readonly done: Promise<void>;
}

function refused(code: string, detail: string): Core.ToolRefused {
  return new Core.ToolRefused("send_message", `${code}: ${detail}`);
}

async function joinVoice(route: ProviderVoiceRoute, request: CallRequest, speaker: string, signal: AbortSignal) {
  try {
    return await route({
      surface: request.surface, channelId: request.channelId, speakerExternalId: speaker, signal,
    });
  } catch (error) {
    if (error instanceof VoiceJoinRefused)
      throw refused("call_join_refused", `${error.reason}: ${error.detail}`);
    throw error;
  }
}

function failedCall(
  error: string | Error,
  handle: PcmVoiceHandle | undefined,
  stopped: boolean,
  joinedSettled: boolean,
  joined: ReturnType<typeof Promise.withResolvers<void>>,
): CallEndReason {
  if (handle === undefined) joined.reject(error);
  else if (!stopped && error instanceof Core.ToolRefused) joined.reject(error);
  else if (!stopped && error instanceof Error && !joinedSettled)
    joined.reject(refused("call_realtime_failed", error.message));
  return typeof error === "string" && isEndReason(error) ? error : "realtime_error";
}

function finalOutcome(sessionId: string, call: string, reason: CallEndReason, releaseFailure?: string): LiveCallEnd {
  return { sessionId, call, reason, ...(releaseFailure === undefined ? {} : { releaseFailure }) };
}

function toolOutput(result: Tool.Result): PlainValue {
  return result.isError
    ? { error: toolResultText(result) }
    : result.structuredContent ?? { content: result.content ?? "" };
}

function endOnVoiceEvents(voice: PcmVoiceHandle, speaker: string, release: () => Promise<void>) {
  return Stream.fromAsyncIterable(voice.events, (error) => new Error(String(error)))
    .pipe(Stream.runForEach((event) => {
      if (event.type === "speaker_left" && event.externalId === speaker)
        return Effect.promise(release).pipe(Effect.andThen(Effect.fail("owner_left" as CallEndReason)));
      if (event.type === "disconnected")
        return Effect.promise(release).pipe(Effect.andThen(Effect.fail("voice_disconnected" as CallEndReason)));
      if (event.type === "error")
        return Effect.promise(release).pipe(Effect.andThen(Effect.fail("voice_error" as CallEndReason)));
      return Effect.void;
    }), Effect.andThen(Effect.promise(release)), Effect.as("voice_disconnected" as CallEndReason));
}

function endOnRealtimeEvents(session: RealtimeSession, release: () => Promise<void>) {
  return Stream.runForEach(session.events, (event) =>
    event.type === "error"
      ? Effect.promise(release).pipe(Effect.andThen(Effect.fail("realtime_error" as CallEndReason)))
      : event.type === "closed"
        ? Effect.promise(release).pipe(Effect.andThen(Effect.fail("realtime_closed" as CallEndReason)))
        : Effect.void,
  ).pipe(Effect.andThen(Effect.promise(release)), Effect.as("realtime_closed" as CallEndReason));
}

function runCall(
  input: LiveVoiceInputs,
  request: CallRequest,
  voice: PcmVoiceHandle,
  specs: readonly Tool.Spec[],
  callId: string,
  speaker: string,
  joined: () => void,
  release: () => Promise<void>,
  signal: AbortSignal,
): Promise<CallEndReason> {
  const down = createDownsampler();
  const up = createUpsampler();
  const speech = Stream.fromAsyncIterable(voice.pcmIn, (error) => new Error(String(error)))
    .pipe(Stream.map((pcm) => down.push(pcm)), Stream.filter((pcm) => pcm.length > 0), Stream.orDie);
  const instructions = "You are the Owner's agent on a live voice call. Act only through your tools and keep spoken replies short.";
  return input.run(Effect.scoped(Effect.gen(function* () {
    const session = yield* input.realtime.open({
      instructions: request.opening === undefined ? instructions : `${instructions}\n${request.opening}`,
      tools: specs,
      audioIn: speech,
      audioOut: (pcm) => Effect.tryPromise({
        try: () => voice.pcmOut.write(up.push(pcm)),
        catch: (error) => new Error(String(error)),
      }).pipe(Effect.orDie),
    });
    joined();
    const tools = Stream.runForEach(session.toolCalls, (call) => dispatchTool(input, session, call, request, callId))
      .pipe(Effect.andThen(Effect.promise(release)), Effect.as("realtime_closed" as CallEndReason));
    return yield* Effect.raceAllFirst([
      tools, endOnRealtimeEvents(session, release), endOnVoiceEvents(voice, speaker, release),
    ]);
  })), signal);
}

/** Each external tool gets a fresh session turn; no turn writer survives in this driver. */
export function createLiveVoice(input: LiveVoiceInputs): {
  readonly call: CallPort;
  readonly end: (sessionId: string, reason: CallEndReason) => Promise<void>;
  readonly endAll: (reason: CallEndReason) => Promise<void>;
  readonly has: (sessionId: string) => boolean;
} {
  const active = new Map<string, ActiveCall>();

  async function start(request: CallRequest): Promise<CallReceipt> {
    if (input.role(request.sessionId) !== "resident")
      throw refused("call_child", "only the Resident can start a live call");
    const person = input.persons.get(request.contact);
    if (person?.trustTier !== "owner")
      throw refused("call_not_owner", "the contact is not the Owner");
    const platform = request.surface.split(":")[0] ?? request.surface;
    const endpoint = person.endpoints.find((candidate) => candidate.channel === platform);
    if (endpoint === undefined)
      throw refused("call_owner_unreachable", `the Owner has no ${platform} endpoint`);
    const route = input.routes.get(request.surface);
    if (route === undefined)
      throw refused("call_unrouted", `no mounted voice route for ${request.surface}`);
    if (active.has(request.sessionId))
      throw refused("call_busy", "this session already has a live call");

    const callId = input.id();
    const specs = Core.currentInvocation().cell.specs;
    const controller = new AbortController();
    const joined = Promise.withResolvers<void>();
    let reason: CallEndReason = "realtime_closed";
    let handle: PcmVoiceHandle | undefined;
    let releaseFailure: string | undefined;
    let voiceReleased = false;
    let stopped = false;
    const releaseVoice = async () => {
      if (voiceReleased || handle === undefined) return;
      voiceReleased = true;
      try { await handle.leave(); }
      catch (error) { releaseFailure = String(error); }
    };
    const stop = async (next: CallEndReason) => {
      if (!stopped) {
        stopped = true;
        reason = next;
        await releaseVoice();
        controller.abort();
      }
      await done;
    };

    const drive = async (): Promise<void> => {
      try {
        handle = await joinVoice(route, request, endpoint.externalId, controller.signal);
        reason = await runCall(input, request, handle, specs, callId, endpoint.externalId,
          joined.resolve, releaseVoice, controller.signal);
      } catch (error) {
        if (!stopped) reason = failedCall(error instanceof Error ? error : String(error), handle, stopped, joinedSettled, joined);
      } finally {
        await releaseVoice();
        joined.reject(refused("call_realtime_failed", "call ended before the realtime session opened"));
        active.delete(request.sessionId);
        input.ended(finalOutcome(request.sessionId, callId, reason, releaseFailure));
      }
    };
    let joinedSettled = false;
    void joined.promise.then(() => { joinedSettled = true; }, () => { joinedSettled = true; });
    const done = drive();
    active.set(request.sessionId, { stop, done });
    await joined.promise;
    return { contact: request.contact, status: "joined", call: callId, surface: request.surface, channelId: request.channelId };
  }

  return {
    call: { start },
    has: (sessionId) => active.has(sessionId),
    end: async (sessionId, reason) => { await active.get(sessionId)?.stop(reason); },
    endAll: async (reason) => { await Promise.all([...active.values()].map((call) => call.stop(reason))); },
  };
}

function isEndReason(reason: string): reason is CallEndReason {
  return ["owner_left", "voice_disconnected", "voice_error", "realtime_closed", "realtime_error", "interrupted", "shutdown"].includes(reason);
}

function dispatchTool(
  input: LiveVoiceInputs,
  session: RealtimeSession,
  call: RealtimeToolCall,
  request: CallRequest,
  callId: string,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const result = yield* input.executeTool(request.sessionId, {
      sourceTurnId: request.turnId,
      call: { id: `live:${callId}:${call.callId}`, tool: call.name, input: call.arguments },
      waitMs: 5_000,
    }).pipe(
      Effect.map(toolOutput),
      Effect.catch((error) => Effect.succeed(
        error instanceof Core.ToolTurnRefused ? { error: { code: error.code } } : { error: String(error) },
      )),
      Effect.catchDefect((error) => Effect.succeed({ error: String(error) })),
    );
    yield* session.respondTool(call.callId, result);
  }).pipe(Effect.orDie);
}
