import { policySnapshot } from "../../../../packages/agent/test/helpers/compiled-policy";
import { APPROVAL_POLICY } from "../../src/composition/policy";
import { Effect } from "effect";
import { executorLayer } from "../../../../packages/agent/test/helpers/service-layers";
import { runSyncEffect } from "./effect";
import { Core } from "@oni/agent";
const createExecutor = Core.createExecutor;
import { LedgerAction } from "@oni/protocol";
import { nullRetryAlarm } from "../../../../packages/agent/test/helpers/effect-g1";
const KERNEL_POLICY_REGISTRY = Core.KERNEL_POLICY_REGISTRY;
const SEEDED_POLICY_ROWS = Core.SEEDED_POLICY_ROWS;

let ordinal = 0;

/** The seeded policy rows compiled at generation 1: the real snapshot test executors enforce. */
export const seededPolicy = policySnapshot({
  registry: KERNEL_POLICY_REGISTRY,
  generation: 1,
  mandatory: [],
  rows: SEEDED_POLICY_ROWS.map((row) => ({ ...row, generation: 1 })),
});

/** Production executor composition with deterministic in-memory receipts. */
export const fixtureLedger = {
    commit(action: Parameters<Parameters<typeof createExecutor>[0]["ledger"]["commit"]>[0]) {
      ordinal += 1;
      return Effect.succeed({
        action: LedgerAction.Node.parse({ ...action, ordinal }),
        revision: ordinal,
      });
    },
};

export const executorServices = executorLayer({ policy: seededPolicy, clock: () => 1, entropy: () => `test-action-${ordinal + 1}`, observations: { publish: () => undefined } });
export const executor = runSyncEffect(createExecutor({
  approvalPolicy: APPROVAL_POLICY,
  ledger: fixtureLedger,
  identity: { sessionId: "test", role: "resident", parentActionId: null },
  // In-memory ledger: durable retry scheduling is covered by the agent package tests.
  retryAlarm: nullRetryAlarm,
}).pipe(Effect.provide(executorServices)));
