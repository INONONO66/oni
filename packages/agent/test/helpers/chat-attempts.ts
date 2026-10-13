import { Effect } from "effect";
import type { LedgerAction, PlainObject, PlainValue } from "@openomni/protocol";
import type { ExecutionError } from "../../src/core/ports/failure";
import type { DurableExecutor, LlmAttempts } from "../../src/core/loop/executor";
import { fakeClassifyFailure } from "./fake-llm";

/** Runs one recorded `llm/chat` action whose attempts all share the trivial prepare/admit shape. */
export function runChatAttempts<T extends PlainValue>(
  executor: Pick<DurableExecutor, "run" | "runAttempts">,
  body: (attempt: number) => Effect.Effect<T, ExecutionError>,
  evidence?: LlmAttempts<T>["evidence"],
  intent?: PlainObject,
) {
  return executor.run({ kind: "llm", op: "chat", intent: {}, effect: {} }, (parent: LedgerAction.Receipt) =>
    executor.runAttempts(parent, {
      prepare: (attempt: number) => Effect.succeed({
        request: { op: "chat", intent: intent ?? { attempt }, effect: {} },
        admit: () => Effect.void,
        body: () => body(attempt),
      }),
      classify: (error) => fakeClassifyFailure({ error }),
      ...(evidence === undefined ? {} : { evidence }),
    }),
  );
}
