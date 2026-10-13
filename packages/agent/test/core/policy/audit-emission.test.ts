import { testExecutor } from "../../helpers/executor";
import { KERNEL_POLICY_REGISTRY } from "../../../src/core/gate/compile";
import { Effect, Fiber } from "effect";
import { expect, it } from "bun:test";
import type { ExecutionLedger } from "../../../src/core/loop/executor";
import { compilePolicySnapshot } from "../../../src/core/gate/compile";
import { L0Observation, type LedgerAction, type PolicyRow } from "@openomni/protocol";
import { isolated } from "../../helpers/isolated";

function policyRow(name: string, kind: PolicyRow.Row["kind"], phase: PolicyRow.Phase, verdict: PolicyRow.Row["verdict"]["value"]): PolicyRow.Row {
  return { name, kind, phase, match: { encodingVersion: 1, value: { op: "read" } }, verdict: { encodingVersion: 1, value: verdict }, priority: 100, generation: 7 };
}

it("awaits policy.decision commit before publishing its observation", async () => isolated(Effect.scoped(Effect.gen(function* () {
  const appended: LedgerAction.Append[] = [];
  const observations: string[] = [];
  const decisionCommit = Promise.withResolvers<void>();
  const reached = Promise.withResolvers<void>();
  let revision = 0;
  const ledger: ExecutionLedger = {
    commit(action) {
      return Effect.gen(function* () {
        if (action.kind === "policy.decision") {
          reached.resolve();
          yield* Effect.promise(() => decisionCommit.promise);
        }
        appended.push(action);
        revision += 1;
        return { action: { ...action, ordinal: revision, prevHash: "fixture-prev", actionHash: "fixture-hash" }, revision };
      });
    },
  };
  const executor = testExecutor({
    policy: compilePolicySnapshot({ registry: KERNEL_POLICY_REGISTRY, generation: 7, mandatory: ["compaction"], rows: [
      { ...policyRow("compaction", "turn", "post", { type: "allow" }), match: { encodingVersion: 1, value: {} } },
      policyRow("allow-read", "tool", "pre", { type: "allow" }),
    ] }),
    ledger,
    observations: { publish(event, value) { if (event.name === L0Observation.ActionCommittedEvent.name) observations.push(L0Observation.ActionCommitted.parse(value).id); } },
    identity: { sessionId: "session-audit", role: "resident", parentActionId: "turn-parent" },
    clock: () => 42,
    entropy: (() => { let index = 0; return () => `audit-${++index}`; })(),
    random: () => 0,
  });
  const running = yield* Effect.forkScoped(executor.run({ kind: "tool", op: "read", intent: { path: "/tmp/a" }, effect: { ok: true } }, () => Effect.succeed("done")));
  yield* Effect.promise(() => reached.promise).pipe(Effect.timeout("5 seconds"));
  expect(appended).toHaveLength(0);
  expect(observations).toHaveLength(0);
  decisionCommit.resolve();
  yield* Fiber.join(running);
  const decision = appended.find((action) => action.kind === "policy.decision");
  expect(decision).toMatchObject({ parentId: "turn-parent", sessionId: "session-audit", kind: "policy.decision", intent: { value: { hook: "tool.pre", generation: 7, matchedRuleIds: ["allow-read"], verdict: "allow" } } });
  const value = decision?.intent.value;
  expect(typeof value === "object" && value !== null && !Array.isArray(value) ? value.inputHash : undefined).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(observations[0]).toBe(decision?.id);
  expect(appended.findIndex((action) => action.id === observations[0])).toBe(0);
}))));
