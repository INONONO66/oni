import { Cause, Effect, Exit, Option } from "effect";
import { runTestExit, runTestSync } from "../../helpers/isolated";
import { Processor as NativeProcessor } from "../../../src/model/processor";
import { run as nativeRun } from "../../../src/model/run";
import { decodeLlmFailure } from "../../../src/model/error";
import { fixedNow, sequentialIds } from "./fixtures";
export type { Run, RunInput } from "../../../src/model/run";
export { LlmRunFailure } from "../../../src/model/errors";

/** Only the test edge executes native effects; failures retain their tagged identity. */
export async function runEffect<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  const exit = await runTestExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  const failure = Cause.findErrorOption(exit.cause);
  if (Option.isSome(failure)) throw failure.value;
  throw Cause.squash(exit.cause);
}

export function runSyncEffect<A, E>(effect: Effect.Effect<A, E>): A {
  return runTestSync(effect);
}

export function runEffectExit<A, E>(effect: Effect.Effect<A, E>): Promise<Exit.Exit<A, E>> {
  return runTestExit(effect);
}
export namespace Processor {
  type StreamInput = Parameters<NativeProcessor.ProcessorOptions["createStream"]>[0];
  type Stream = Effect.Success<ReturnType<NativeProcessor.ProcessorOptions["createStream"]>>;
  export type ProcessorOptions = Omit<NativeProcessor.ProcessorOptions, "createStream"> & { createStream: (input: StreamInput) => Promise<Stream> };
  export function create(options: ProcessorOptions) {
    const value = NativeProcessor.create({ ...options, createStream: (input) => Effect.tryPromise({ try: () => options.createStream(input), catch: decodeLlmFailure("test.provider") }) });
    return { get message() { return value.message; }, get usageTotals() { return value.usageTotals; }, get visibleOutput() { return value.visibleOutput; }, process: (streamInput: { system: string; promptText: string }) => runEffect(value.process(streamInput)) };
  }
}
type NativeInput = Parameters<typeof nativeRun>[0];
/** Fixed `now`/`id` stubs by default; a test overrides them to assert exact values. */
export type TestRunInput = Omit<NativeInput, "now" | "id" | "authFilePath"> & Partial<Pick<NativeInput, "now" | "id" | "authFilePath">>;
export function run(input: TestRunInput, sink: Parameters<typeof nativeRun>[1], dependencies: { createStream?: Processor.ProcessorOptions["createStream"] } = {}) {
  const createStream = dependencies.createStream;
  return runEffect(nativeRun({ now: fixedNow, id: sequentialIds(), authFilePath: "/nonexistent/openomni-llm-test/auth.json", ...input }, sink, createStream ? { createStream: (request) => Effect.tryPromise({ try: () => createStream(request), catch: decodeLlmFailure("test.provider") }) } : {}));
}
