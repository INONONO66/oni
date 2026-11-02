import { type BusEvent, LlmCall, type Model } from "@oni/protocol";
import { transcribe } from "ai";
import { Effect } from "effect";
import { Auth } from "./auth/storage";
import { decodeLlmFailure } from "./error";
import { ModelResolutionError, type LlmError } from "./errors";
import { Provider } from "./provider";
import { BUNDLED_ROWS, type ProviderRow } from "./provider/rows";
import { getSDK, type Transport } from "./provider/sdk";

export interface Transcript {
  readonly text: string;
  readonly language?: string;
  readonly durationMs?: number;
}

export interface Stt {
  /** `traceId` correlates the call's observation row; the caller mints it. */
  readonly transcribe: (audio: { readonly bytes: Uint8Array; readonly traceId: string }) => Effect.Effect<Transcript, LlmError>;
}

interface Selection {
  readonly row: ProviderRow;
  readonly modelId: string;
}

function select(rows: readonly ProviderRow[], model: Model.Ref | undefined): Effect.Effect<Selection, ModelResolutionError> {
  if (model === undefined) {
    const row = rows.find((candidate) => candidate.transcription !== undefined);
    return row?.transcription === undefined
      ? Effect.fail(new ModelResolutionError({ message: "No provider row names a transcription model", provider: "", model: "", reason: "model_not_found" }))
      : Effect.succeed({ row, modelId: row.transcription });
  }
  const row = rows.find((candidate) => candidate.id === model.provider);
  return row === undefined
    ? Effect.fail(new ModelResolutionError({ message: `No provider row named ${model.provider}`, provider: model.provider, model: model.id, reason: "provider_not_found" }))
    : Effect.succeed({ row, modelId: model.id });
}

export function makeStt(input: {
  readonly authFilePath: string;
  readonly rows?: readonly ProviderRow[];
  readonly transport?: Transport;
  readonly model?: Model.Ref;
  /** Receives one `llm.transcription.completed` row per settled provider call. */
  readonly events: BusEvent.Sink;
  readonly now: () => number;
}): Stt {
  const rows = input.rows ?? BUNDLED_ROWS;
  return {
    transcribe: (audio) => Effect.gen(function* () {
      const { row, modelId } = yield* select(rows, input.model);
      const auth = yield* Auth.resolve(row.id, input.authFilePath);
      const sdk = getSDK(Provider.withRow({ id: modelId, providerID: row.id, name: modelId }, row), auth, input.transport);
      if (!("transcription" in sdk)) {
        return yield* new ModelResolutionError({
          message: `Provider ${row.id} has no transcription surface`, provider: row.id, model: modelId, reason: "model_not_found",
        });
      }
      const startedAt = input.now();
      const result = yield* Effect.tryPromise({
        // Retries belong to the caller, as for `run`: one attempt per invocation.
        try: (abortSignal) => transcribe({ model: sdk.transcription(modelId), audio: audio.bytes, maxRetries: 0, abortSignal }),
        catch: decodeLlmFailure("stt.transcribe"),
      });
      const time = input.now();
      input.events.publish(LlmCall.Events.TranscriptionCompleted, {
        traceId: audio.traceId, time, provider: row.id, model: modelId, inputBytes: audio.bytes.byteLength, durationMs: time - startedAt,
      });
      return {
        text: result.text,
        ...(result.language === undefined ? {} : { language: result.language }),
        ...(result.durationInSeconds === undefined ? {} : { durationMs: Math.round(result.durationInSeconds * 1000) }),
      };
    }),
  };
}
