import { Effect } from "effect";
import { CompactionExecutionError, type ExecutionError, RunEvents, type Entropy } from "../../core/api";
import type { CompactionExecutionInput, CompactionResult } from "./contract";
import { canonicalDigest, PlainValueSchema, type BusEvent, type PlainValue } from "@openomni/protocol";
import { Compaction } from "./compact";

/** Execute the existing strategy under admission; only the receipt releases observations. */
export function executeCompaction(input: CompactionExecutionInput): Effect.Effect<CompactionResult, ExecutionError, Entropy> {
  return Effect.gen(function* () {
  const snapshot = structuredClone(input.history);
  const completed: (() => void)[] = [];
  const events: BusEvent.Sink = {
    publish(event, data) {
      if (event.name === RunEvents.CompactionStarted.name) input.events.publish(event, data);
      else completed.push(() => input.events.publish(event, data));
    },
  };
  const calculate = () => Effect.gen(function* () {
    if (input.signal?.aborted) return yield* Effect.interrupt;
    const result = yield* Compaction.compact(snapshot, input.options, input.identity, events, {
      ...input.dispatch,
      signal: input.signal,
    });
    if (input.signal?.aborted) return yield* Effect.interrupt;
    return result;
  });
  let result: CompactionResult | undefined;
  if (input.executor === undefined) {
    result = yield* calculate();
  } else {
    const execution = yield* input.executor.run(
      {
        kind: "compaction",
        op: "compact",
        intent: {
          trigger: input.dispatch.trigger,
          predecessorProjectionHash: canonicalDigest({ foldVersion: 1, projection: PlainValueSchema.parse(snapshot) }),
        },
        effect: {},
        boundary: true,
        revertData: () =>
          result?.record === undefined ? undefined : PlainValueSchema.parse(result.record.revert),
      },
      () => Effect.gen(function* () {
        result = yield* calculate();
        return recordedValue(result);
      }),
    );
    if (execution.terminal !== "executed")
      return yield* new CompactionExecutionError({ reason: execution.reason });
    if (result === undefined || canonicalDigest(execution.value) !== canonicalDigest(recordedValue(result))) {
      return yield* new CompactionExecutionError({ reason: "invalid_output" });
    }
  }
  for (const publish of completed) publish();
  return result;
  });
}

/**
 * The row's result value. `reason: "fallback"` means the summarizer failed and a deterministic
 * result replaced its summary: a snap-cut, the carried-forward previous anchor, or elision only.
 */
function recordedValue(result: CompactionResult): PlainValue {
  if (result.record === undefined) return null;
  return PlainValueSchema.parse({
    ...result.record,
    projection: result.messages,
    ...(result.summarizerFailed === true ? { summarizerFailed: true, reason: "fallback" } : {}),
  });
}
