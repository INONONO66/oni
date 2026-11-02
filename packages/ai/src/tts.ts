import { type BusEvent, LlmCall, type Model } from "@oni/protocol";
import { generateSpeech } from "ai";
import { Effect } from "effect";
import { Auth } from "./auth/storage";
import { decodeLlmFailure } from "./error";
import { ModelResolutionError, type LlmError } from "./errors";
import { Provider } from "./provider";
import { BUNDLED_ROWS, type ProviderRow } from "./provider/rows";
import { getSDK, type Transport } from "./provider/sdk";

/** The audio one call produced: the container bytes and the media type the SDK read off them. */
export interface Speech {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
}

type SpeechRow = NonNullable<ProviderRow["speech"]>;

export interface Tts {
  /**
   * `traceId` correlates the call's observation row; the caller mints it. `model` is an id on the
   * selected row's provider; `voice`/`format` override the row's.
   */
  readonly speak: (call: {
    readonly text: string;
    readonly traceId: string;
    readonly model?: string;
    readonly voice?: string;
    readonly format?: SpeechRow["format"];
  }) => Effect.Effect<Speech, LlmError>;
}

interface Selection {
  readonly row: ProviderRow;
  readonly modelId: string;
  /** The row's speech defaults (voice, format), absent on a row that names none. */
  readonly defaults: SpeechRow | undefined;
}

/**
 * Absent `model`: the first row naming a speech model serves every call. Explicit `Model.Ref`: that
 * provider's row with that id. A per-call `model` id stays on the selected row either way.
 */
function select(rows: readonly ProviderRow[], model: Model.Ref | undefined): Effect.Effect<Selection, ModelResolutionError> {
  if (model === undefined) {
    const row = rows.find((candidate) => candidate.speech !== undefined);
    return row?.speech === undefined
      ? Effect.fail(new ModelResolutionError({ message: "No provider row names a speech model", provider: "", model: "", reason: "model_not_found" }))
      : Effect.succeed({ row, modelId: row.speech.model, defaults: row.speech });
  }
  const row = rows.find((candidate) => candidate.id === model.provider);
  return row === undefined
    ? Effect.fail(new ModelResolutionError({ message: `No provider row named ${model.provider}`, provider: model.provider, model: model.id, reason: "provider_not_found" }))
    : Effect.succeed({ row, modelId: model.id, defaults: row.speech });
}

export function makeTts(input: {
  readonly authFilePath: string;
  readonly rows?: readonly ProviderRow[];
  readonly transport?: Transport;
  /** Selects the provider row and model id; absent, the first row naming a speech model. */
  readonly model?: Model.Ref;
  /** Receives one row per settled provider call: `llm.speech.completed` or `llm.speech.failed`. */
  readonly events: BusEvent.Sink;
  readonly now: () => number;
}): Tts {
  const rows = input.rows ?? BUNDLED_ROWS;
  return {
    speak: (call) => Effect.gen(function* () {
      const selected = yield* select(rows, input.model);
      const { row, defaults } = selected;
      const modelId = call.model ?? selected.modelId;
      const auth = yield* Auth.resolve(row.id, input.authFilePath);
      const sdk = getSDK(Provider.withRow({ id: modelId, providerID: row.id, name: modelId }, row), auth, input.transport);
      if (!("speech" in sdk)) {
        return yield* new ModelResolutionError({
          message: `Provider ${row.id} has no speech surface`, provider: row.id, model: modelId, reason: "model_not_found",
        });
      }
      const startedAt = input.now();
      const identity = { traceId: call.traceId, provider: row.id, model: modelId, inputChars: call.text.length };
      const result = yield* Effect.tryPromise({
        // Retries belong to the caller, as for `run`: one attempt per invocation.
        try: (abortSignal) => generateSpeech({
          model: sdk.speech(modelId),
          text: call.text,
          ...(call.voice ?? defaults?.voice) === undefined ? {} : { voice: call.voice ?? defaults?.voice },
          outputFormat: call.format ?? defaults?.format ?? "mp3",
          maxRetries: 0,
          abortSignal,
        }),
        catch: decodeLlmFailure("tts.speak"),
      }).pipe(Effect.tapError((error) => Effect.sync(() => {
        const time = input.now();
        input.events.publish(LlmCall.Events.SpeechFailed, { ...identity, time, durationMs: time - startedAt, error: error.message });
      })));
      const bytes = result.audio.uint8Array;
      const time = input.now();
      input.events.publish(LlmCall.Events.SpeechCompleted, { ...identity, time, outputBytes: bytes.byteLength, durationMs: time - startedAt });
      return { bytes, mediaType: result.audio.mediaType };
    }),
  };
}
