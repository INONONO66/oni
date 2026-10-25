import { toolWireName } from "@oni/protocol";
import { Effect } from "effect";
import type { Auth } from "../auth/storage";
import { AuthResolutionError, type LlmError } from "../errors";
import type { ProviderRow } from "../provider/rows";
import type { ServerEvent } from "./events";
import type { RealtimeOpenInput } from "./index";

type RealtimeRow = ProviderRow & { realtime: NonNullable<ProviderRow["realtime"]> };

export function authHeaders(row: RealtimeRow, auth: Auth.Info): Effect.Effect<Record<string, string>, LlmError> {
  if (auth.type === "api") return Effect.succeed({ ...row.headers, Authorization: `Bearer ${auth.key}` });
  const endpointHost = new URL(row.realtime.endpoint).hostname;
  if (endpointHost !== new URL(auth.baseURL).hostname) {
    return new AuthResolutionError({
      provider: row.id, reason: "invalid_auth", message: "Realtime endpoint does not match proxy host",
    });
  }
  return Effect.succeed({
    ...row.headers,
    ...(auth.apiKey === undefined ? {} : { Authorization: `Bearer ${auth.apiKey}` }),
  });
}

export function sessionUpdate(input: RealtimeOpenInput, row: RealtimeRow) {
  return {
    type: "session.update",
    session: {
      type: "realtime",
      model: row.realtime.model,
      output_modalities: ["audio"],
      instructions: input.instructions,
      tools: input.tools.map((spec) => ({
        type: "function", name: toolWireName(spec.name),
        description: spec.description ?? "", parameters: spec.inputSchema,
      })),
      audio: {
        input: {
          format: { type: "audio/pcm", rate: 24000 },
          turn_detection: { type: "semantic_vad", create_response: true },
          transcription: { model: "gpt-4o-mini-transcribe" },
        },
        output: { format: { type: "audio/pcm", rate: 24000 }, voice: row.realtime.voice },
      },
    },
  };
}

export function echoMatches(
  frame: Extract<ServerEvent, { type: "session.updated" }>,
  requested: ReturnType<typeof sessionUpdate>["session"],
): boolean {
  const echoed = frame.session.tools.map((tool) => tool.name);
  const audio = frame.session.audio;
  const expected = requested.audio;
  return audio.input.format.type === expected.input.format.type
    && audio.input.format.rate === expected.input.format.rate
    && audio.input.turn_detection?.type === expected.input.turn_detection.type
    && audio.input.turn_detection?.create_response === expected.input.turn_detection.create_response
    && audio.input.transcription?.model === expected.input.transcription.model
    && audio.output.format.type === expected.output.format.type
    && audio.output.format.rate === expected.output.format.rate
    && audio.output.voice === expected.output.voice
    && echoed.length === requested.tools.length
    && echoed.every((name, index) => name === requested.tools[index]?.name);
}
