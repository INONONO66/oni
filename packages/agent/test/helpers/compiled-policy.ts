import { KERNEL_POLICY_REGISTRY, compile } from "../../src/core/gate/compile";
import type { PolicyBinding, PolicyRows, HandlerTable } from "../../src/core/gate/types";
import { bind } from "../../src/core/gate/bind";
export function policySnapshot({ registry, ...rows }: PolicyRows & { readonly registry: HandlerTable }): PolicyBinding {
  return bind(compile(rows, registry));
}

import type { LedgerAction, PolicyRow } from "@oni/protocol";

const mandatoryPolicyRow: PolicyRow.Row = {
  name: "compaction",
  kind: "compaction",
  phase: "pre",
  match: { encodingVersion: 1, value: { op: "compact" } },
  verdict: { encodingVersion: 1, value: { type: "allow" } },
  priority: 1000,
  generation: 1,
};

/** Every write needs the owner's approval before it runs. */
export const approveWriteRow: PolicyRow.Row = {
  name: "approve-write",
  kind: "tool",
  phase: "pre",
  match: { encodingVersion: 1, value: { op: "write" } },
  verdict: { encodingVersion: 1, value: { type: "require_approval", reason: "owner" } },
  priority: 1,
  generation: 1,
};

/** A compiled test policy with the mandatory row plus the supplied behavior rows. */
export function compiledPolicy(rows: readonly PolicyRow.Row[] = []): PolicyBinding {
  return policySnapshot({ registry: KERNEL_POLICY_REGISTRY,
    generation: 1,
    mandatory: [],
    rows: [mandatoryPolicyRow, ...rows],
  });
}

export function accountOutputDeniedPolicy() {
  return compiledPolicy([{
    name: "deny-account-output",
    kind: "tool",
    phase: "post",
    match: { encodingVersion: 1, value: { op: "account" } },
    verdict: { encodingVersion: 1, value: { type: "deny", reason: "output_denied" } },
    priority: 1,
    generation: 1,
  }]);
}

/** An "allow everything" compiled policy for tests. */
export const allowAllPolicy = compiledPolicy();

/** Read the executor's nested operation and phase fields from an action append. */
export function opPhaseOf(action: LedgerAction.Append): string {
  for (const carrier of [action.intent?.value, action.effect?.value]) {
    if (carrier === null || typeof carrier !== "object" || Array.isArray(carrier)) continue;
    const { op, phase } = carrier;
    if (typeof op === "string" && typeof phase === "string") return `${op}:${phase}`;
  }
  return "unmatched";
}

/** A manually released commit boundary for deterministic record-before-publish tests. */
export function actionCommitGate(expectedOpPhase: string): {
  readonly reached: Promise<void>;
  readonly release: () => void;
  readonly onCommit: (action: LedgerAction.Append) => Promise<void>;
} {
  const reached = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  return {
    reached: reached.promise,
    release: release.resolve,
    async onCommit(action: LedgerAction.Append) {
      if (opPhaseOf(action) !== expectedOpPhase) return;
      reached.resolve();
      await release.promise;
    },
  };
}

/** Records only tool lifecycle names while allowing exact-event test signals. */
export function recordingToolObservations(onToolEvent?: (name: string) => void): {
  readonly names: string[];
  readonly observe: (name: string) => void;
} {
  const names: string[] = [];
  return {
    names,
    observe(name: string) {
      if (!name.startsWith("tool.execution.")) return;
      names.push(name);
      onToolEvent?.(name);
    },
  };
}
