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

export function echoMatches(frame: Extract<ServerEvent, { type: "session.updated" }>, names: readonly string[]): boolean {
  const echoed = frame.session.tools.map((tool) => tool.name);
  const audio = frame.session.audio;
  return audio.input.format.type === "audio/pcm" && audio.input.format.rate === 24000
    && audio.output.format.type === "audio/pcm" && audio.output.format.rate === 24000
    && echoed.length === names.length && echoed.every((name, index) => name === names[index]);
}
