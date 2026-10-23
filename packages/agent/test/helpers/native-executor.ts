import { KERNEL_POLICY_REGISTRY, SEEDED_POLICY_ROWS } from "../../src/core/gate/compile";
import { policySnapshot } from "./compiled-policy";
import { executionReads } from "./execution-reads";
import { isolatedLedger } from "./isolated";
import { sessionTree } from "./session-tree";
import type { ResolvedExecutorOptions } from "../../src/core/loop/executor";

import { type LedgerAction, PlainObjectSchema } from "@oni/protocol";
import { Effect } from "effect";
import type { SessionKernel } from "../../src/core/session/entity";
import type { ExecutionLedger } from "../../src/core/loop/executor";
import { TEST_APPROVAL_POLICY } from "../helpers/approval-policy";

export const fiberSessionId = "fiber-session";
export const nativePolicy = policySnapshot({ registry: KERNEL_POLICY_REGISTRY,
  generation: 1,
  rows: SEEDED_POLICY_ROWS.map((row) => ({ ...row, generation: 1 })),
});
export const effectValue = (action: LedgerAction.Append) => PlainObjectSchema.parse(action.effect.value);

export function nativeExecutorOptions(now = 100, id = fiberSessionId, handle?: SessionKernel) {
  return Effect.gen(function* () {
    const kernel = handle ?? isolatedLedger().kernel;
    const initial = yield* kernel.materialize({
      id, parentId: null, role: "resident", tools: [], system: { preset: "A", blocks: [] },
      policyGeneration: 1, actionId: `${id}:configure`, at: now,
    });
    const owner = `owner:${now}`;
    const adopted = yield* kernel.adoptFence({
      sessionId: id, owner, fence: initial.row.fence + 1,
    });
    const turnId = `${id}:turn`;
    const ledger: ExecutionLedger = {
      ...executionReads(kernel, id),
      commit: (action) => Effect.suspend(() => kernel.commit({
        sessionId: id, owner, fence: adopted.fence, now,
        expectedRevision: kernel.row(id).revision,
        actions: [action], state: "running",
      })).pipe(Effect.map((result) => {
        const receipt = result.receipts[0];
        if (receipt === undefined) throw new Error("missing action receipt");
        return receipt;
      })),
    };
    if (!sessionTree(kernel, id).some((action) => action.id === turnId)) {
      const generation = kernel.latestGenerationFor(id);
      yield* ledger.commit({
        id: turnId, parentId: `${id}:configure`, sessionId: id, kind: "turn",
        intent: { encodingVersion: 1, value: {
          phase: "intent", resultId: `${id}:result`, deliveryIds: [], resumeCount: 0,
          boundaryActionId: null, toolsGeneration: generation.generation,
          toolsHash: generation.toolsHash, systemHash: generation.systemHash, policyGeneration: 1,
        } },
        effect: { encodingVersion: 1, value: { phase: "pending" } }, ts: now, irreversible: true,
      });
    }
    let sequence = kernel.row(id).revision;
    return {
      policy: nativePolicy, ledger, observations: { publish: () => undefined },
      clock: () => now, entropy: () => `${id}:${now}:${++sequence}`, random: () => 0,
      identity: { sessionId: id, role: "resident", parentActionId: turnId, turnId },
      approvalPolicy: TEST_APPROVAL_POLICY,
} satisfies ResolvedExecutorOptions;
  });
}
