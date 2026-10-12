import { Core } from "@openomni/agent";
import { Effect } from "effect";
import { executionReads } from "../../../../packages/agent/test/helpers/execution-reads";
import { testExecutor } from "../../../../packages/agent/test/helpers/executor";
import type { IsolatedLedger } from "../../../../packages/agent/test/helpers/isolated";

/** A fenced, committed executor for app-side dispatch integration tests. */
export function isolatedExecutorHarness(options: {
  id: string;
  kernel: IsolatedLedger["kernel"];
  seeds: Parameters<typeof Core.compilePolicySnapshot>[0]["rows"];
  registry: Parameters<typeof Core.compilePolicySnapshot>[0]["registry"];
}) {
  const { id, kernel, seeds, registry } = options;
  return Effect.gen(function* () {
    const initial = yield* kernel.materialize({
      id,
      parentId: null,
      role: "resident",
      tools: [],
      system: { preset: "", blocks: [] },
      policyGeneration: 1,
      actionId: `${id}:configure`,
      at: 100,
    });
    const lease = yield* kernel.adoptFence({ sessionId: id, owner: id, fence: initial.row.fence + 1 });
    let sequence = 0;
    const commit = (action: Parameters<typeof kernel.commit>[0]["actions"][number]) =>
      kernel.commit({
        sessionId: id,
        owner: id,
        fence: lease.fence,
        now: 100,
        expectedRevision: kernel.row(id).revision,
        actions: [action],
        state: "running",
      }).pipe(Effect.map(({ receipts }) => {
        const receipt = receipts[0];
        if (receipt === undefined) throw new Error("missing receipt");
        return receipt;
      }));
    return {
      lease,
      executor: testExecutor({
        identity: { sessionId: id, role: "resident", parentActionId: `${id}:configure` },
        clock: () => 100,
        entropy: () => `${id}:${++sequence}`,
        observations: { publish: () => undefined },
        random: () => 0,
        policy: Core.compilePolicySnapshot({ registry, generation: 1, rows: seeds }),
        ledger: { ...executionReads(kernel, id), commit },
      }),
    };
  });
}
