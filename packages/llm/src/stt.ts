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
  readonly transcribe: (audio: { readonly bytes: Uint8Array }) => Effect.Effect<Transcript, LlmError>;
}

export function makeStt(input: {
  readonly authFilePath: string;
  readonly rows?: readonly ProviderRow[];
  readonly transport?: Transport;
}): Stt {
  return {
    transcribe: (audio) => Effect.gen(function* () {
      const row = (input.rows ?? BUNDLED_ROWS).find((candidate) => candidate.transcription !== undefined);
      if (row?.transcription === undefined) {
        return yield* new ModelResolutionError({
          message: "No provider row names a transcription model", provider: row?.id ?? "", model: "", reason: "model_not_found",
        });
      }
      const modelId = row.transcription;
      const auth = yield* Auth.resolve(row.id, input.authFilePath);
      const sdk = getSDK(Provider.withRow({ id: modelId, providerID: row.id, name: modelId }, row), auth, input.transport);
      if (!("transcription" in sdk)) {
        return yield* new ModelResolutionError({
          message: `Provider ${row.id} has no transcription surface`, provider: row.id, model: modelId, reason: "model_not_found",
        });
      }
      const result = yield* Effect.tryPromise({
        // Retries belong to the caller, as for `run`: one attempt per invocation.
        try: (abortSignal) => transcribe({ model: sdk.transcription(modelId), audio: audio.bytes, maxRetries: 0, abortSignal }),
        catch: decodeLlmFailure("stt.transcribe"),
      });
      return {
        text: result.text,
        ...(result.language === undefined ? {} : { language: result.language }),
        ...(result.durationInSeconds === undefined ? {} : { durationMs: Math.round(result.durationInSeconds * 1000) }),
      };
    }),
  };
}
