import { type BusEvent, LlmCall } from "@oni/protocol";
import { generateImage } from "ai";
import { Effect } from "effect";
import { Auth } from "./auth/storage";
import { decodeLlmFailure } from "./error";
import { ModelResolutionError, type LlmError } from "./errors";
import { Provider } from "./provider";
import { BUNDLED_ROWS, type ProviderRow } from "./provider/rows";
import { getSDK, type Transport } from "./provider/sdk";

export interface GeneratedImage {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
}

export interface ImageRequest {
  readonly prompt: string;
  /** `traceId` correlates the call's observation row; the caller mints it. */
  readonly traceId: string;
  /** A model id on the first row that names an image model; absent uses that row's own id. */
  readonly model?: string;
  /** `{width}x{height}`; absent leaves the size to the provider. */
  readonly size?: `${number}x${number}`;
  /** Images per call; absent asks for one. */
  readonly n?: number;
}

export interface Image {
  readonly generate: (request: ImageRequest) => Effect.Effect<readonly GeneratedImage[], LlmError>;
}

interface Selection {
  readonly row: ProviderRow;
  readonly modelId: string;
}

/** The first row naming an image model serves every call; a per-call `model` id stays on that row. */
function select(rows: readonly ProviderRow[], modelId: string | undefined): Effect.Effect<Selection, ModelResolutionError> {
  const row = rows.find((candidate) => candidate.image !== undefined);
  return row?.image === undefined
    ? Effect.fail(new ModelResolutionError({ message: "No provider row names an image model", provider: "", model: "", reason: "model_not_found" }))
    : Effect.succeed({ row, modelId: modelId ?? row.image.model });
}

export function makeImage(input: {
  readonly authFilePath: string;
  readonly rows?: readonly ProviderRow[];
  readonly transport?: Transport;
  /** Receives one row per settled provider call: `llm.image.completed` or `llm.image.failed`. */
  readonly events: BusEvent.Sink;
  readonly now: () => number;
}): Image {
  const rows = input.rows ?? BUNDLED_ROWS;
  return {
    generate: (request) => Effect.gen(function* () {
      const { row, modelId } = yield* select(rows, request.model);
      const auth = yield* Auth.resolve(row.id, input.authFilePath);
      const sdk = getSDK(Provider.withRow({ id: modelId, providerID: row.id, name: modelId }, row), auth, input.transport);
      if (!("image" in sdk)) {
        return yield* new ModelResolutionError({
          message: `Provider ${row.id} has no image surface`, provider: row.id, model: modelId, reason: "model_not_found",
        });
      }
      const n = request.n ?? 1;
      const startedAt = input.now();
      const result = yield* Effect.tryPromise({
        // Retries belong to the caller, as for `run`: one attempt per invocation.
        try: (abortSignal) => generateImage({
          model: sdk.image(modelId),
          prompt: request.prompt,
          n,
          ...(request.size === undefined ? {} : { size: request.size }),
          maxRetries: 0,
          abortSignal,
        }),
        catch: decodeLlmFailure("image.generate"),
      }).pipe(Effect.tapError((error) => Effect.sync(() => {
        const time = input.now();
        input.events.publish(LlmCall.Events.ImageFailed, {
          traceId: request.traceId, time, provider: row.id, model: modelId, n, durationMs: time - startedAt, error: error.message,
        });
      })));
      const images = result.images.map((image) => ({ bytes: image.uint8Array, mediaType: image.mediaType }));
      const time = input.now();
      input.events.publish(LlmCall.Events.ImageCompleted, {
        traceId: request.traceId,
        time,
        provider: row.id,
        model: modelId,
        n,
        bytes: images.reduce((total, image) => total + image.bytes.byteLength, 0),
        durationMs: time - startedAt,
      });
      return images;
    }),
  };
}
