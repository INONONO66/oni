import { memoryExecutionReads } from "./execution-reads";
import { testExecutor } from "./executor";
import type { LedgerError } from "../../src/core/store/errors";
import type { CompiledPolicySnapshot } from "../../src/core/gate/compile";
import { LedgerAction } from "@oni/protocol";
import { Effect } from "effect";
import { compiledPolicy, fixtureHashes } from "./compiled-policy";

/** Commit gates and refusals happen before persistence, as in the real ledger. */
export function recoveryRecording(options: {
  readonly policy?: CompiledPolicySnapshot;
  readonly beforeCommit?: (action: LedgerAction.Append) => Effect.Effect<void, LedgerError>;
} = {}) {
  const committed: LedgerAction.Node[] = [];
  let sequence = 0;
  const executor = testExecutor({
    policy: options.policy ?? compiledPolicy(),
    ledger: {
      ...memoryExecutionReads(() => committed),
      commit: (action) => Effect.gen(function* () {
        yield* options.beforeCommit?.(action) ?? Effect.void;
        const ordinal = committed.length + 1;
        const node = LedgerAction.Node.parse({ ...action, ordinal, ...fixtureHashes(ordinal) });
        committed.push(node);
        return { action: node, revision: ordinal };
      }),
    },
    observations: { publish: () => undefined },
    identity: { sessionId: "session-1", role: "resident", parentActionId: null },
    clock: () => 1,
    entropy: () => `action-${++sequence}`,
    random: () => 0,
  });
  return { executor, committed };
}
