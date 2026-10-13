import { mock } from "bun:test";
import { APICallError, type jsonSchema, type streamText } from "ai";
import type { StreamEvent } from "../../src/processor/stream-events";

export type StreamTextArgs = Parameters<typeof streamText>[0];

/** The step shape the model's stop conditions actually read. */
export type Condition = (input: {
  steps: ReadonlyArray<{ usage?: { inputTokens?: number } }>;
}) => boolean;

/** What the mocked `streamText` hands back: the chunks as the SDK's fullStream. */
export function streamOf(chunks: StreamEvent[]): {
  fullStream: AsyncIterable<StreamEvent>;
} {
  return {
    fullStream: (async function* (): AsyncGenerator<StreamEvent, void, undefined> {
      yield* chunks;
    })(),
  };
}

export interface AiMockOptions<Args = StreamTextArgs> {
  streamText: (args: Args) => { fullStream: AsyncIterable<StreamEvent> };
  /** Overrides the default exact-count condition, e.g. to record the cap. */
  isStepCount?: (stepCount: number) => Condition;
}

/**
 * The one ai-module mock, with the 7-major signatures the model consumes:
 * `streamText`, `jsonSchema`, `isStepCount`. `APICallError` passes through to
 * the real class so error identity (`APICallError.isInstance`) keeps working
 * under the module mock.
 */
export function mockAiModule<Args = StreamTextArgs>(options: AiMockOptions<Args>): void {
  mock.module("ai", () => ({
    APICallError,
    streamText: options.streamText,
    jsonSchema: (schema: Parameters<typeof jsonSchema>[0]) => ({ jsonSchema: schema }),
    isStepCount:
      options.isStepCount ??
      ((stepCount: number): Condition =>
        ({ steps }) =>
          steps.length === stepCount),
  }));
}
