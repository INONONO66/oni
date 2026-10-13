import { Effect } from "effect";
import { createExecutor } from "../../src/core/loop/executor";
import type { ResolvedExecutorOptions } from "../../src/core/loop/executor";
import { runTestSync } from "./isolated";
import { executorLayer } from "./service-layers";
import { TEST_APPROVAL_POLICY } from "./approval-policy";
export { runAgent, runAgentSync } from "./isolated";

/**
 * Acquire an executor with the fixture's services supplied through their
 * Layer. The approval policy is composition-owned; fixtures default to
 * the shipped values unless a case states its own.
 */
export function testExecutor(
  options: Omit<ResolvedExecutorOptions, "approvalPolicy"> &
    Partial<Pick<ResolvedExecutorOptions, "approvalPolicy">>,
) {
  const { policy, observations, clock, entropy, ...executorOptions } = options;
  return runTestSync(
    createExecutor({ approvalPolicy: TEST_APPROVAL_POLICY, ...executorOptions }).pipe(
      Effect.provide(executorLayer({ policy, observations, clock, entropy })),
    ),
  );
}
