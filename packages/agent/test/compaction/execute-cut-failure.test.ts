import { expect, it } from "bun:test";
import { Effect } from "effect";
import { executeCompaction } from "../../src/plugins/compaction/execute-cut";
import type { Executor } from "../../src/core/loop/executor";
import { compactionExecutionInput, evidenceAssistant } from "../helpers/compaction-cut";
import { isolated } from "../helpers/isolated";

const assistant = (id: string) => evidenceAssistant("execute-cut-failure", id);

const executionInput = (executor: Executor, observed: string[]) =>
  compactionExecutionInput(executor, observed, [assistant("first"), assistant("last")]);

it("fails with a catchTag-able CompactionExecutionError when the durable output no longer matches", async () => {
  // Given: an executor that reports success with output the compaction never produced.
  const tampering: Executor = {
    run: () => Effect.succeed({ terminal: "executed", value: "tampered" }),
  };
  const observed: string[] = [];

  // When: the typed failure is recovered through Effect.catchTag, not instanceof sniffing.
  const recovered = await isolated(
    executeCompaction(executionInput(tampering, observed)).pipe(
      Effect.map(() => "unexpected success"),
      Effect.catchTag("CompactionExecutionError", (error) =>
        Effect.succeed(`caught:${error._tag}:${error.reason}|${error.message}`),
      ),
    ),
  );

  // Then: the invalid_output refusal is a typed failure whose message carries the reason, and held observations never fired.
  expect(recovered).toBe("caught:CompactionExecutionError:invalid_output|compaction execution refused: invalid_output");
  expect(observed).toEqual([]);
});
