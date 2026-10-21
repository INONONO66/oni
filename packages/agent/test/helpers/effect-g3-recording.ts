import { testExecutor } from "./executor";
import { Effect } from "effect";
import type { LedgerAction } from "@oni/protocol";
import type { CompiledPolicySnapshot } from "../../src/core/gate/compile";
import { allowAllPolicy } from "./compiled-policy";
import { recordingLedger } from "./recording-ledger";

export { recordingLedger };
export function recordingExecutor(options: { readonly policy?: CompiledPolicySnapshot; readonly onCommit?: (action: LedgerAction.Append) => void | Promise<void>; readonly onObservation?: (name: string) => void; readonly clock?: () => number } = {}) {
  const record = recordingLedger();
  const executor = testExecutor({
    closeGraceMs: 0,
    policy: options.policy ?? allowAllPolicy,
    retryAlarm: { arm: () => Effect.void, wait: () => Effect.void, settle: () => Effect.void },
    ledger: { commit: (action: LedgerAction.Append) => record.ledger.commit(action).pipe(Effect.tap(() => Effect.promise(async () => { await options.onCommit?.(action); }))) },
    observations: { publish: (event) => options.onObservation?.(event.name) },
    identity: { sessionId: "session-1", role: "resident", parentActionId: null }, clock: options.clock ?? (() => 1), entropy: record.entropy, random: () => 0,
  });
  return { ...record, executor };
}
