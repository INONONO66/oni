import { Core } from "@oni/agent";
import { VoiceJoinRefused, type PersonStore, type ProviderVoiceRoute, type PcmVoiceHandle } from "@oni/channels";
import type { Realtime, RealtimeSession, RealtimeToolCall } from "@oni/llm";
import { toolResultText, type PlainValue, type Tool } from "@oni/protocol";
import { Effect, Fiber, Stream } from "effect";
import { createDownsampler, createUpsampler } from "./live-pcm";
import { ThrownError } from "../thrown";
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
  readonly ended?: (outcome: LiveCallEnd) => void;
  readonly incident: (message: string, error: Error) => void;
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
  const result = await route({
    surface: request.surface, channelId: request.channelId, speakerExternalId: speaker, signal,
  }).then((voice) => ({ voice }), ThrownError.transform((failure) => ({ failure })).parse);
  if ("failure" in result) {
    if (result.failure instanceof VoiceJoinRefused)
      throw refused("call_join_refused", `${result.failure.reason}: ${result.failure.detail}`);
    throw result.failure;
  }
  return result.voice;
}

function failedCall(
  error: Error,
  handle: PcmVoiceHandle | undefined,
  joinedSettled: boolean,
  joined: ReturnType<typeof Promise.withResolvers<void>>,
): CallEndReason {
  if (handle === undefined || error instanceof Core.ToolRefused) joined.reject(error);
  else if (!joinedSettled) joined.reject(refused("call_realtime_failed", error.message));
  return isEndReason(error.message) ? error.message : "realtime_error";
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
  return Stream.fromAsyncIterable(voice.events, ThrownError.parse)
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
  admission: AbortSignal,
): Promise<CallEndReason> {
  const down = createDownsampler();
  const up = createUpsampler();
  const speech = Stream.fromAsyncIterable(voice.pcmIn, ThrownError.parse)
    .pipe(Stream.map((pcm) => down.push(pcm)), Stream.filter((pcm) => pcm.length > 0), Stream.orDie);
  const instructions = "You are the Owner's agent on a live voice call. Act only through your tools and keep spoken replies short.";
  return input.run(Effect.scoped(Effect.gen(function* () {
    const voiceTermination = yield* Effect.forkScoped(
      endOnVoiceEvents(voice, speaker, release), { startImmediately: true },
    );
    return yield* Effect.raceAllFirst([
      Effect.gen(function* () {
        const session = yield* input.realtime.open({
          instructions: request.opening === undefined ? instructions : `${instructions}\n${request.opening}`,
          tools: specs,
          audioIn: speech,
          audioOut: (pcm) => Effect.tryPromise({
            try: () => voice.pcmOut.write(up.push(pcm)),
            catch: ThrownError.parse,
          }).pipe(Effect.orDie),
        });
        joined();
        const tools = Stream.runForEach(session.toolCalls, (call) => dispatchTool(input, session, call, request, callId, admission))
          .pipe(Effect.andThen(Effect.promise(release)), Effect.as("realtime_closed" as CallEndReason));
        return yield* Effect.raceAllFirst([tools, endOnRealtimeEvents(session, release)]);
      }),
      Fiber.join(voiceTermination),
    ]);
  })), signal);
}

/** Each external tool gets a fresh session turn; no turn writer survives in this driver. */
export function createLiveVoice(input: LiveVoiceInputs): {
  readonly call: CallPort;
  readonly end: (sessionId: string, reason: CallEndReason) => Promise<void>;
  readonly endAll: (reason: CallEndReason) => Promise<void>;
  readonly has: (sessionId: string) => boolean;
  readonly interrupt: (sessionId: string) => Effect.Effect<void, Core.AgentFailure>;
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
    const admission = new AbortController();
    const joined = Promise.withResolvers<void>();
    let reason: CallEndReason = "realtime_closed";
    let handle: PcmVoiceHandle | undefined;
    let releaseFailure: string | undefined;
    let voiceRelease: Promise<void> | undefined;
    let stopped = false;
    const releaseVoice = (): Promise<void> => {
      const leaving = handle;
      if (leaving === undefined) return Promise.resolve();
      if (voiceRelease === undefined)
        voiceRelease = leaving.leave().then(() => undefined, ThrownError.parse).then((failure) => {
          if (failure !== undefined) releaseFailure = String(failure);
        });
      return voiceRelease;
    };
    // Every terminal path closes tool admission before it waits on the voice leave.
    const terminate = (): Promise<void> => {
      admission.abort();
      return releaseVoice();
    };
    const stop = async (next: CallEndReason) => {
      if (!stopped) {
        stopped = true;
        reason = next;
        controller.abort();
        await terminate();
      }
      await done;
    };

    const drive = async (): Promise<void> => {
      const outcome = await joinVoice(route, request, endpoint.externalId, controller.signal)
        .then((voice) => {
          handle = voice;
          return runCall(input, request, voice, specs, callId, endpoint.externalId,
            joined.resolve, terminate, controller.signal, admission.signal);
        }, ThrownError.parse).then((value) => value, ThrownError.parse);
      if (outcome instanceof Error) {
        if (!stopped) reason = failedCall(outcome, handle, joinedSettled, joined);
      } else reason = outcome;
      await terminate();
      joined.reject(refused("call_realtime_failed", "call ended before the realtime session opened"));
      active.delete(request.sessionId);
      if (releaseFailure !== undefined)
        input.incident(`live call ${callId} release failed`, new Error(releaseFailure));
      input.ended?.(finalOutcome(request.sessionId, callId, reason, releaseFailure));
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
    interrupt: (sessionId) => Effect.suspend(() => {
      const call = active.get(sessionId);
      return call === undefined ? Effect.void : Effect.tryPromise({
        try: () => call.stop("interrupted"),
        catch: ThrownError.transform((error) => new Core.AgentFailure({
          operation: "call.interrupt", cause: String(error),
        })).parse,
      });
    }),
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
  signal: AbortSignal,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    if (signal.aborted) return;
    const result = yield* input.executeTool(request.sessionId, {
      sourceTurnId: request.turnId,
      call: { id: `live:${callId}:${call.callId}`, tool: call.name, input: call.arguments },
      waitMs: 5_000,
    }).pipe(
      Effect.map(toolOutput),
      Effect.catch((error) => Effect.succeed(
        error instanceof Core.ToolTurnRefused ? { error: { code: error.code } } : { error: String(error) },
      )),
      Effect.catchDefect(ThrownError.transform((error) => Effect.succeed({ error: String(error) })).parse),
    );
    if (signal.aborted) return;
    yield* session.respondTool(call.callId, result);
  }).pipe(Effect.orDie);
}
