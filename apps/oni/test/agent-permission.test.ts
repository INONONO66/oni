import { expect, test } from "bun:test";
import { Core } from "@oni/agent";
import type { DecisionFact, Machine, ToolExecutionContext } from "@oni/protocol";
import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import {
  AGENT_PERMISSION_DEADLINE_MS,
  AGENT_PERMISSION_HOST_DEADLINE_MS,
  createAgentPermissionPort,
} from "../src/bundles/approval-policy/agent-permission";
import type { ProvisionPort } from "../src/bundles/provision/channels";
import { executePermission } from "../src/bundles/provision/machines";
import { executeProvision, provisionApproval } from "../src/bundles/provision/execution";
import { runEffect, runSyncEffect } from "./helpers/effect";

const OWNER = "session-owner";
const MACHINE = "mac-1";
const REQUEST: Machine.AgentPermissionRequest = { sessionId: "agent-1", requestId: "req-1", tool: "Bash", description: "rm -rf build" };
const KEY = "agent-permission:mac-1:agent-1:req-1";
const REF = { machineId: MACHINE, agentSessionId: "agent-1", requestId: "req-1" } as const;
const context: ToolExecutionContext = { sessionId: OWNER, turnId: "turn", callId: "call", signal: new AbortController().signal };

function harness(options: { readonly deliverFails?: boolean } = {}) {
  const facts = new Map<string, Map<string, DecisionFact.Recorded>>();
  const rows: { sessionId: string; kind: string; body: string; source: string; idempotencyKey: string }[] = [];
  const incidents: string[] = [];
  const delivered = runSyncEffect(Deferred.make<void>());
  const store = (sessionId: string) => {
    const own = facts.get(sessionId) ?? new Map<string, DecisionFact.Recorded>();
    facts.set(sessionId, own);
    return {
      head: (key: string) => own.get(key),
      record: (fact: DecisionFact.Record): DecisionFact.Outcome => {
        const existing = own.get(fact.key);
        if (existing !== undefined) return { kind: "exists", fact: existing };
        own.set(fact.key, fact);
        return { kind: "recorded", fact };
      },
    };
  };
  const port = createAgentPermissionPort({
    owner: (child) => (child === REQUEST.sessionId ? OWNER : undefined),
    deliver: (sessionId, input) => Effect.suspend(() => {
      if (options.deliverFails) return Effect.fail(new Error("entity is gone"));
      rows.push({ sessionId, ...input });
      return Deferred.succeed(delivered, undefined).pipe(Effect.asVoid);
    }),
    decisions: store,
    incident: (message) => incidents.push(message),
    now: () => 1_000,
  });
  return { port, rows, incidents, delivered, store };
}

test("the request lands in the owning session as one action row and an allow fact resolves it allowed", async () => {
  const { port, rows, delivered, store } = harness();
  const decision = await runEffect(Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(port.decide(MACHINE, REQUEST));
    yield* Deferred.await(delivered);
    expect(port.answer({ sessionId: OWNER, ...REF, status: "allowed" })).toEqual({ kind: "recorded", status: "allowed" });
    return yield* Fiber.join(fiber);
  }));
  expect(decision).toEqual({ status: "allowed", sessionId: "agent-1", requestId: "req-1" });
  expect(rows).toEqual([{
    sessionId: OWNER,
    kind: "action",
    body: JSON.stringify({ content: [{ kind: "text", text: JSON.stringify({
      agentSessionId: "agent-1", deadlineMs: AGENT_PERMISSION_DEADLINE_MS, description: "rm -rf build",
      kind: "agent_permission", machineId: MACHINE, requestId: "req-1", tool: "Bash",
    }) }] }),
    source: JSON.stringify({ kind: "agent_permission", machineId: MACHINE, reply: "none" }),
    idempotencyKey: KEY,
  }]);
  expect(store(OWNER).head(KEY)).toEqual({ key: KEY, type: "agent_permission.decided", data: { status: "allowed" }, timeCreated: 1_000 });
  expect(await runEffect(port.decide(MACHINE, REQUEST))).toEqual({ status: "allowed", sessionId: "agent-1", requestId: "req-1" });
  expect(rows).toHaveLength(1);
  expect(port.answer({ sessionId: OWNER, ...REF, status: "denied" })).toEqual({ kind: "exists", status: "allowed" });
});

test("a deny fact refuses the host, and a session that does not own the child is not an answerer", async () => {
  const { port, delivered } = harness();
  const decision = await runEffect(Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(port.decide(MACHINE, REQUEST));
    yield* Deferred.await(delivered);
    expect(port.answer({ sessionId: OWNER, ...REF, status: "denied" })).toEqual({ kind: "recorded", status: "denied" });
    return yield* Fiber.join(fiber);
  }));
  expect(decision).toEqual({ status: "refused", sessionId: "agent-1", requestId: "req-1", reason: "denied" });
  expect(port.answer({ sessionId: "session-other", ...REF, status: "allowed" })).toEqual({ kind: "not_owner" });
});

test("an agent session no cli turn owns is refused without a row", async () => {
  const { port, rows, incidents } = harness();
  const decision = await runEffect(port.decide(MACHINE, { ...REQUEST, sessionId: "agent-unknown" }));
  expect(decision).toEqual({ status: "refused", sessionId: "agent-unknown", requestId: "req-1", reason: "denied" });
  expect(rows).toEqual([]);
  expect(incidents).toEqual([]);
});

test("an unanswered request is refused at the app deadline, which precedes the host backstop", async () => {
  const { port, rows, delivered } = harness();
  const decision = await runEffect(Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(port.decide(MACHINE, REQUEST));
    yield* Deferred.await(delivered);
    yield* TestClock.adjust(AGENT_PERMISSION_DEADLINE_MS);
    return yield* Fiber.join(fiber);
  }).pipe(Effect.provide(TestClock.layer())));
  expect(decision).toEqual({ status: "refused", sessionId: "agent-1", requestId: "req-1", reason: "timeout" });
  expect(rows).toHaveLength(1);
  expect(AGENT_PERMISSION_HOST_DEADLINE_MS).toBeGreaterThan(AGENT_PERMISSION_DEADLINE_MS);
  expect(AGENT_PERMISSION_DEADLINE_MS).toBeLessThan(120_000);
});

test("a row the owning session cannot take is an incident and a refusal", async () => {
  const { port, incidents } = harness({ deliverFails: true });
  const decision = await runEffect(port.decide(MACHINE, REQUEST));
  expect(decision).toEqual({ status: "refused", sessionId: "agent-1", requestId: "req-1", reason: "denied" });
  expect(incidents).toEqual([`agent permission request ${KEY} was not delivered to ${OWNER}`]);
});

test("provision permission_allow needs Owner consent before it records, permission_deny records at once", async () => {
  const { port } = harness();
  const approval = provisionApproval(undefined);
  // The provision tool routes both permission ops to the composed permission port.
  const execute = executeProvision({ permissions: port } as Pick<ProvisionPort, "permissions"> as ProvisionPort, () => 1_000);
  expect(await execute({ operation: { op: "permission_allow", args: REF } }, context))
    .toEqual({ op: "permission_allow", result: { type: "require_approval", id: "req-1" } });
  expect(approval({ operation: { op: "permission_allow", args: REF } })).toEqual({ required: true, domainRevisions: {} });
  expect(approval({ operation: { op: "permission_deny", args: REF } })).toEqual({ required: false, domainRevisions: {} });
  expect(executePermission(port, { op: "permission_allow", args: REF }, context))
    .toEqual({ op: "permission_allow", result: { type: "require_approval", id: "req-1" } });
  expect(executePermission(port, { op: "permission_allow", args: REF }, { ...context, domainRevisions: {} }))
    .toEqual({ op: "permission_allow", result: { kind: "recorded", status: "allowed" } });
  expect(await execute({ operation: { op: "permission_deny", args: REF } }, context))
    .toEqual({ op: "permission_deny", result: { kind: "exists", status: "allowed" } });
  expect(() => executePermission(port, { op: "permission_deny", args: { ...REF, agentSessionId: "agent-x" } }, context))
    .toThrow(new Core.ToolRefused("provision", "no cli turn of this session owns agent session agent-x"));
  expect(() => executePermission(undefined, { op: "permission_deny", args: REF }, context))
    .toThrow(new Core.ToolRefused("provision", "agent permission port is not composed"));
});
