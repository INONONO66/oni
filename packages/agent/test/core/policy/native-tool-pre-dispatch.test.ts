import { executionReads } from "../../helpers/execution-reads";
import { sessionTree } from "../../helpers/session-tree";
import { testExecutor, runAgentSync } from "../../helpers/executor";
import { executorLayer, catalogLayer } from "../../helpers/service-layers";
import { expect, test } from "bun:test";
import { compilePolicySnapshot, KERNEL_POLICY_REGISTRY, SEEDED_POLICY_ROWS } from "../../../src/core/gate/compile";
import { PlainObjectSchema } from "@openomni/protocol";
import { Cause, Effect, Fiber } from "effect";
import { createHandlerTable } from "../../../src/core/gate/compile";
import { requestLedger, crashAfterRequestOpen, failure } from "../../helpers/effect-g1";
import { z } from "zod";
import { createExecutor } from "../../../src/core/loop/executor";
import { defineTool } from "../../../src/core/loop/tool";
import { createDispatcher } from "../../../src/plugins/tool";
import { isolated, isolatedLedger } from "../../helpers/isolated";
import { TEST_APPROVAL_POLICY } from "../../helpers/approval-policy";

test("approval recovery executes recorded admitted bytes without transforming again", () => isolated(Effect.scoped(Effect.gen(function* () {
  const recorded = yield* requestLedger();
  let transformations = 0;
  const executed: string[] = [];
  const registry = createHandlerTable({ ...KERNEL_POLICY_REGISTRY, transformers: [
    ...KERNEL_POLICY_REGISTRY.transformers,
    { name: "demo/normalize", apply: () => { transformations += 1; return { text: `admitted-${transformations}` }; } },
  ] });
  const policy = compilePolicySnapshot({ registry, generation: 1, rows: [
    ...SEEDED_POLICY_ROWS.map((row) => ({ ...row, generation: 1 })),
    { name: "normalize", kind: "tool", phase: "pre", generation: 1, priority: 1,
      match: { encodingVersion: 1, value: { op: "write" } },
      verdict: { encodingVersion: 1, value: { type: "transform", ref: "demo/normalize", config: { fields: ["text"] } } } },
  ] });
  const definition = defineTool({ name: "write", description: "Write", category: "mutation",
    input: z.object({ text: z.string() }), output: z.string(), visibility: { model: ["resident"], cell: ["resident"] },
    execute: async ({ text }) => { executed.push(text); return text; }, render: (_input, output) => output,
  }, () => ({ required: true, domainRevisions: {} }));
  const providers = executorLayer({ ...recorded, policy, observations: { publish: () => undefined } });
  const crashed = yield* createExecutor({ approvalPolicy: TEST_APPROVAL_POLICY, ...crashAfterRequestOpen(recorded, "crash"), identity: recorded.identity }).pipe(Effect.provide(providers));
  const initial = yield* createDispatcher({ executor: crashed }).pipe(Effect.provide(catalogLayer([definition])));
  const context = { sessionId: recorded.identity.sessionId, turnId: recorded.identity.turnId };
  expect(yield* failure(initial.execute({ id: "write-call", tool: "write", input: { text: "original" } }, context)))
    .toMatchObject({ _tag: "AgentFailure", operation: "crash" });
  expect(executed).toEqual([]);
  expect(transformations).toBe(1);
  // Recovery replays the committed gate decision: the transformer is gone
  // from this process (it throws), yet the recorded output still admits (r3).
  const recoveredPolicy = compilePolicySnapshot({
    registry: createHandlerTable({ ...KERNEL_POLICY_REGISTRY, transformers: [
      ...KERNEL_POLICY_REGISTRY.transformers,
      { name: "demo/normalize", apply: () => { throw new Error("handler must not run during replay"); } },
    ] }),
    generation: 1, rows: [
      ...SEEDED_POLICY_ROWS.map((row) => ({ ...row, generation: 1 })),
      { name: "normalize", kind: "tool", phase: "pre", generation: 1, priority: 1,
        match: { encodingVersion: 1, value: { op: "write" } },
        verdict: { encodingVersion: 1, value: { type: "transform", ref: "demo/normalize", config: { fields: ["text"] } } } },
    ] });
  const recoveredProviders = executorLayer({ ...recorded, policy: recoveredPolicy, observations: { publish: () => undefined } });
  const ready = Promise.withResolvers<void>();
  const recovered = yield* createExecutor({ approvalPolicy: TEST_APPROVAL_POLICY, ...recorded, ledger: { ...recorded.ledger, requestById: (id) => {
    if ((recovered.approvals?.pending().length ?? 0) > 0) ready.resolve();
    return recorded.ledger.requestById?.(id);
  } }, authorizeApproval: () => Effect.succeed({ kind: "owner", principalId: "owner", evidenceId: "proof" }) }).pipe(Effect.provide(recoveredProviders));
  const dispatcher = yield* createDispatcher({ executor: recovered }).pipe(Effect.provide(catalogLayer([definition])));
  const recovering = yield* Effect.forkScoped(recovered.recover().pipe(
    Effect.andThen(() => dispatcher.recover(sessionTree(isolatedLedger().kernel, recorded.identity.sessionId), context)),
    Effect.tapCause((cause) => Effect.sync(() => ready.reject(Cause.squash(cause)))),
  ));
  yield* Effect.promise(() => ready.promise).pipe(Effect.timeout("5 seconds"));
  const approvals = recovered.approvals;
  if (approvals === undefined) throw new Error("approvals missing");
  const request = approvals.pending()[0];
  if (request === undefined) throw new Error("approval missing");
  expect(request.durable.parsedInput).toEqual({ text: "original" });
  yield* approvals.answer({ request, decision: "approve", credential: "proof" });
  yield* Fiber.join(recovering);
  expect(transformations).toBe(1);
  expect(executed).toEqual(["admitted-1"]);
}))), 15000);

for (const door of ["model", "cell", "wave"] as const) {
  for (const replacement of ["admitted", null]) {
    test(`${door} executes and renders only schema-valid admitted input (${replacement})`, () => isolated(Effect.gen(function* () {
      const id = `pre-${door}-${replacement}`;
      const kernel = isolatedLedger().kernel;
      const materialized = yield* kernel.materialize({
        id, parentId: null, role: "resident", tools: [], system: { preset: "", blocks: [] },
        policyGeneration: 1, actionId: `${id}:configure`, at: 100,
      });
      const lease = yield* kernel.adoptFence({
        sessionId: id, owner: id, fence: materialized.row.fence + 1,
      });
      let sequence = 0;
      const executed: string[] = [];
      const rendered: string[] = [];
      const definition = defineTool({
        name: "echo", description: "Echo input", category: "query",
        input: z.object({ text: z.string() }), output: z.string(),
        visibility: { model: ["resident"], cell: ["resident"] },
        execute: async ({ text }) => { executed.push(text); return text; },
        render: ({ text }, output) => { rendered.push(text); return output; },
      });
      const executor = testExecutor({
        identity: { sessionId: id, role: "resident", parentActionId: `${id}:configure` },
        clock: () => 100, entropy: () => `${id}:${++sequence}`, observations: { publish: () => undefined }, random: () => 0,
        policy: compilePolicySnapshot({
          registry: KERNEL_POLICY_REGISTRY, generation: 1, rows: [...SEEDED_POLICY_ROWS.map((row) => ({ ...row, generation: 1 })), {
            name: "redact-input", kind: "tool", phase: "pre", generation: 1, priority: 1,
            match: { encodingVersion: 1, value: { op: "echo" } },
            verdict: { encodingVersion: 1, value: { type: "transform", ref: "kernel/redact", config: { paths: ["text"], replacement } } },
          }],
        }),
        ledger: {
          ...executionReads(kernel, id),
          commit: (action) => kernel.commit({
            sessionId: id, owner: id, fence: lease.fence, now: 100,
            expectedRevision: kernel.row(id).revision,
            actions: [action], state: "running",
          }).pipe(Effect.map((result) => {
            const receipt = result.receipts[0];
            if (receipt === undefined) throw new Error("missing receipt");
            return receipt;
          })),
        },
      });
      const dispatcher = runAgentSync(createDispatcher({ executor }).pipe(Effect.provide(catalogLayer([definition]))));
      const call = { id: "call", tool: "echo", input: { text: "original" } };
      const context = { sessionId: id, turnId: "turn" };
      const result = yield* (door === "wave" ? dispatcher.executeWave([call], context).pipe(Effect.map((results) => results[0]))
        : door === "cell" ? dispatcher.executeCell(call, context) : dispatcher.execute(call, context));
      expect(executed).toEqual(replacement === null ? [] : [replacement]);
      expect(rendered).toEqual(replacement === null || door === "cell" ? [] : [replacement]);
      expect(result).toMatchObject(replacement === null ? { isError: true, errorKind: "invalid_input" } : door === "cell" ? { structuredContent: replacement } : { content: replacement });
      const actions = sessionTree(kernel, id);
      const intent = actions.find((action) => action.kind === "tool" && PlainObjectSchema.parse(action.intent.value).phase === "intent");
      expect(intent?.intent.value).toMatchObject({ value: { text: replacement }, originalArgs: { text: "original" } });
      const decision = actions.find((action) => action.kind === "policy.decision");
      // The committed receipt carries the gate's recorded responses: the
      // consulted payload/digest and the replayable rewritten output (r3).
      expect(decision?.intent.value).toMatchObject({
        transforms: [{ ruleId: "redact-input", ref: "kernel/redact" }], ref: "kernel/redact",
        gate: {
          output: { text: replacement },
          consulted: [expect.objectContaining({ ref: "kernel/redact", digest: expect.any(String) })],
        },
      });
    })));
  }
}
