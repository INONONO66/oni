/** #1348: one executed assistant answer followed by a durable threshold compaction over it. */
import { Effect } from "effect";
import { PlainValueSchema } from "@openomni/protocol";
import type { ExecutionError } from "../../src/core/ports/failure";
import type { Executor } from "../../src/core/loop/executor";
import { createAssistantMessage } from "../../src/core/journal/message-factory";
import type { SessionKernel } from "../../src/core/store/fence";
import { foldSessionHistory } from "../../src/inspect/history";
import { createCompactionPlan } from "../../src/plugins/compaction/durable";
import { messageSource } from "./message-source";
import { sessionTree } from "./session-tree";

/** Runs the `answer` message through `executor`, then a threshold compaction whose synthesis is that answer. */
export function answerThenCompaction(
  executor: Executor,
  kernel: SessionKernel,
  sessionId: string,
  answerText: string,
): Effect.Effect<void, ExecutionError> {
  return Effect.gen(function* () {
    const answer = createAssistantMessage(answerText, "", sessionId, messageSource);
    yield* executor.run(
      { kind: "message", op: "assistant", intent: { messageId: answer.info.id }, effect: {} },
      () => Effect.sync(() => PlainValueSchema.parse(answer)),
    );
    const prior = foldSessionHistory(sessionId, sessionTree(kernel, sessionId));
    const plan = createCompactionPlan(prior, [answer], 100);
    yield* executor.run(
      {
        kind: "compaction",
        op: "compact",
        intent: { trigger: "threshold" },
        effect: {},
        revertData: () => PlainValueSchema.parse(plan.record.revert),
      },
      () =>
        Effect.sync(() => PlainValueSchema.parse({ ...plan.record, projection: plan.projection })),
    );
  });
}
