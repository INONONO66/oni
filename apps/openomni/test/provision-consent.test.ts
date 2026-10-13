import { APPROVAL_POLICY } from "../src/bundles/approval-policy";
import { dispatcherFixture } from "./helpers/dispatcher-fixture";
import { Effect, Fiber } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bundle, Core } from "@openomni/agent";
import { createSessionKernel } from "../../../packages/agent/src/core/store/fence";
const createTurnDispatcher = Bundle.createTurnDispatcher;
import type { AnyToolDefinition, LedgerAction } from "@openomni/protocol";
import { requestLedger, crashAfterRequestOpen, type RequestLedger } from "../../../packages/agent/test/helpers/effect-g1";
import { catalogLayer, executorLayer } from "../../../packages/agent/test/helpers/service-layers";
import { runnerTestLayer } from "../../../packages/agent/test/helpers/isolated";
import { compiledPolicy } from "../../../packages/agent/test/helpers/compiled-policy";
import { sessionTree } from "../../../packages/agent/test/store/helpers/session-tree";
import { createRequestDomainRevisions } from "../src/tools/core/request-domain-revisions";
import { runEffect } from "./helpers/effect";
import { afterEach, beforeEach, expect, it } from "bun:test";
import { openCatalogStore } from "../../../packages/agent/src/core/store/catalog";
import { openSessionStore } from "../../../packages/agent/src/core/store/session-file";
import type { AppLedgerPlane } from "../src/composition/cluster-runtime";
import { testPlane } from "./helpers/ledger";
const eraseTool = Core.eraseTool;
import type { PlainObject } from "@openomni/protocol";
import { createProvisionTool, PROVISION_POLICY_ROWS } from "../src/tools/provision";
import { catalogDefinitions } from "../src/tools/core/catalog";
import { testToolPorts } from "./helpers/tool-ports";
import { executor } from "./helpers/executor";
import { bounded, protectedDispatch } from "./helpers/protected-dispatch";
import { provisionPort } from "./helpers/provision-port";
import { testClock } from "./helpers/test-entropy";

const PROMOTE = { op: "contact_promote", args: { actorId: "contact:mallory" } } as const;
const MERGE = {
  op: "contact_merge",
  args: { endpointId: "ep:mallory", toActorId: "actor:alice" },
} as const;
const planeRef: { current: AppLedgerPlane | undefined } = { current: undefined };
const plane = (): AppLedgerPlane => {
  if (planeRef.current === undefined) throw new Error("test plane not open");
  return planeRef.current;
};
const actors = () => plane().stores.actors;
const provision = () => eraseTool(createProvisionTool(provisionPort(plane()), () => 1000));
/** The provisional contact's current standing in the actor registry. */
const malloryStanding = () => actors().getIdentity("contact:mallory")?.standing;

beforeEach(() => {
  planeRef.current = testPlane();
  actors().mintProvisional(
    { id: "contact:mallory", kind: "unknown", trustTier: "observer", standing: "provisional" },
    { id: "ep:mallory", channel: "whatsapp", externalId: "mallory" },
  );
  actors().registerIdentity({ id: "actor:alice", kind: "human", trustTier: "collaborator" });
  actors().registerIdentity({ id: "actor:bob", kind: "human", trustTier: "observer" });
});
afterEach(() => {
  planeRef.current?.close();
  planeRef.current = undefined;
});

it("consent is a require_approval policy row on the contact and bundle authority ops, nothing else", () => {
  expect(PROVISION_POLICY_ROWS.map((row) => [row.match.value, row.verdict.value])).toEqual([
    [
      { op: "provision", operation: "contact_promote" },
      { type: "require_approval", reason: "provision.contact_promote requires Owner consent" },
    ],
    [
      { op: "provision", operation: "contact_merge" },
      { type: "require_approval", reason: "provision.contact_merge requires Owner consent" },
    ],
    [
      { op: "provision", operation: "bundle_enable" },
      { type: "require_approval", reason: "provision.bundle_enable requires Owner consent" },
    ],
    [
      { op: "provision", operation: "bundle_disable" },
      { type: "require_approval", reason: "provision.bundle_disable requires Owner consent" },
    ],
    [
      { op: "provision", operation: "automation_add" },
      { type: "require_approval", reason: "provision.automation_add requires Owner consent" },
    ],
    [
      { op: "provision", operation: "automation_enable" },
      { type: "require_approval", reason: "provision.automation_enable requires Owner consent" },
    ],
  ]);
  expect(PROVISION_POLICY_ROWS.every((row) => row.kind === "tool" && row.phase === "pre")).toBe(
    true,
  );
});
it("the model cannot mint or decide Owner consent, and children cannot see provision", async () => {
  const dispatcher = dispatcherFixture([provision()], { executor });
  const forged: readonly PlainObject[] = [
    { op: "request", args: { actorId: "contact:mallory" } },
    { op: "decide", args: { approvalId: "invented", decision: "approved" } },
    { op: "contact_promote", args: { actorId: "contact:mallory", approvalId: "invented" } },
  ];
  for (const operation of forged) {
    expect(
      (
        await runEffect(dispatcher.execute(
          { id: "forged", tool: "provision", input: { operation } },
          { sessionId: "test", turnId: "turn" },
        ))
      ).errorKind,
    ).toBe("invalid_input");
  }
  expect(
    catalogDefinitions({ ...testToolPorts, provisioning: provisionPort() }).some(
      (tool: AnyToolDefinition) => tool.name === "provision" &&
        (tool.visibility.model.includes("child") || tool.visibility.cell.includes("child")),
    ),
  ).toBe(false);
  expect(malloryStanding()).toBe("provisional");
});
it("executes exactly the original promotion after authenticated consent", async () => {
  const f = protectedDispatch(provision(), { operation: PROMOTE }, undefined, { plane: plane() });
  try {
    const request = await bounded(f.opened);
    expect(malloryStanding()).toBe("provisional");
    expect(request.parsedInput).toEqual({ operation: PROMOTE });
    const registered = await f.answer();
    expect(registered.isError).toBeUndefined();
    expect(registered.content).toMatch(/^contact contact:mallory registered \(tier \w+\)$/);
    expect(malloryStanding()).toBe("registered");
    expect(f.kernel.requestById(request.requestId)?.state).toBe("resolved");
    expect(f.ledger.actionById?.(`${request.requestId}:application`)).toBeDefined();
  } finally {
    await f.close();
  }
});
it("Owner refusal never promotes a provisional contact", async () => {
  const f = protectedDispatch(provision(), { operation: PROMOTE }, undefined, { plane: plane() });
  try {
    expect((await f.answer("refuse")).isError).toBe(true);
    expect(malloryStanding()).toBe("provisional");
  } finally {
    await f.close();
  }
});
it("rejects an endpoint move after source or target changes, including same-clock edits", async () => {
  const f = protectedDispatch(provision(), { operation: MERGE }, undefined, { plane: plane() });
  try {
    await bounded(f.opened);
    actors().mergeEndpoint("ep:mallory", "actor:bob");
    await expect(f.answer()).rejects.toMatchObject({ code: "stale_approval" });
    expect(actors().getEndpoint("ep:mallory")?.actorId).toBe("actor:bob");
  } finally {
    await f.close();
  }
});
it("merges only the approved endpoint into the exact target", async () => {
  const f = protectedDispatch(provision(), { operation: MERGE }, undefined, { plane: plane() });
  try {
    const merged = await f.answer();
    expect(merged.isError).toBeUndefined();
    expect(merged.content).toBe("endpoint ep:mallory merged into actor:alice");
    expect(actors().getEndpoint("ep:mallory")?.actorId).toBe("actor:alice");
  } finally {
    await f.close();
  }
});
for (const [name, operation] of [
  ["an unknown endpoint", { endpointId: "ep:ghost", toActorId: "actor:alice" }],
  ["an unknown target", { endpointId: "ep:mallory", toActorId: "actor:ghost" }],
  [
    "an endpoint already bound to its target",
    { endpointId: "ep:mallory", toActorId: "contact:mallory" },
  ],
] as const) {
  it(`consent to merge ${name} is refused by the act itself, never applied`, async () => {
    const f = protectedDispatch(provision(), {
      operation: { op: "contact_merge", args: operation },
    }, undefined, { plane: plane() });
    try {
      const result = await f.answer();
      expect(result.isError).toBe(true);
      expect(result.content).toContain("endpoint or target is missing, or already bound");
      expect(actors().getEndpoint("ep:mallory")?.actorId).toBe("contact:mallory");
    } finally {
      await f.close();
    }
  });
}
it("invalidates a merge when the source identity changes without moving its endpoint", async () => {
  const f = protectedDispatch(provision(), { operation: MERGE }, undefined, { plane: plane() });
  try {
    await bounded(f.opened);
    const source = actors().getIdentity("contact:mallory");
    if (source === undefined) throw new Error("missing source identity");
    actors().registerIdentity({ ...source, trustTier: "manager" });
    await expect(f.answer()).rejects.toMatchObject({ code: "stale_approval" });
    expect(actors().getEndpoint("ep:mallory")?.actorId).toBe("contact:mallory");
  } finally {
    await f.close();
  }
});
it("refuses malformed output at the real dispatcher boundary", async () => {
  const result = await runEffect(dispatcherFixture(
    [{ ...provision(), execute: async () => ({ op: "contact_promote" }) }],
    { executor },
  ).execute(
    { id: "bad-output", tool: "provision", input: { operation: PROMOTE } },
    { sessionId: "test", turnId: "turn" },
  ));
  expect(result.errorKind).toBe("invalid_output");
});
it("bounds pending Owner requests across sessions without applying a ninth act", async () => {
  const pending: ReturnType<typeof protectedDispatch>[] = [];
  // W5.2: the approval budget counts open approvals visible to one kernel, so
  // every session in this wave shares the budget kernel's session file.
  const budgetKernel = plane().openKernel("provision-budget");
  try {
    for (let index = 0; index < 8; index += 1) {
      const f = protectedDispatch(provision(), { operation: PROMOTE }, undefined, { plane: plane(), kernel: budgetKernel });
      pending.push(f);
      await bounded(f.opened);
    }
    const ninth = protectedDispatch(provision(), { operation: PROMOTE }, undefined, { plane: plane(), kernel: budgetKernel });
    pending.push(ninth);
    const ninthResult = await bounded(ninth.outcome);
    expect(ninthResult._tag).toBe("Failure");
    expect(ninthResult._tag === "Failure" && ninthResult.failure).toMatchObject({ _tag: "ExecutionApprovalError", code: "stale_approval" });
    expect(
      budgetKernel.requestRows().filter((request) => request.state === "open"),
    ).toHaveLength(8);
    expect(malloryStanding()).toBe("provisional");
  } finally {
    await Promise.all(pending.map((f) => f.close()));
  }
});

function restartDispatcher(recording: RequestLedger, ready?: () => void) {
  return Effect.gen(function* () {
    const dispatcher: Effect.Success<ReturnType<typeof createTurnDispatcher>> = yield* createTurnDispatcher({
      ...recording.identity, actionId: recording.identity.parentActionId,
      ledger: {
        ...recording.ledger,
        requestById: (id: string) => {
          if ((dispatcher.executor.approvals?.pending().length ?? 0) > 0) ready?.();
          return recording.ledger.requestById?.(id);
        },
      },
    }, {
      approvalPolicy: APPROVAL_POLICY,
      authorizeApproval: () => Effect.succeed({ kind: "owner" as const, principalId: "owner", evidenceId: "authenticated" }),
    }).pipe(
      Effect.provide(catalogLayer([provision()])),
      Effect.provide(executorLayer({
        clock: recording.clock, entropy: recording.entropy, observations: { publish: () => undefined },
        policy: compiledPolicy(PROVISION_POLICY_ROWS.map((row: (typeof PROVISION_POLICY_ROWS)[number]) => ({ ...row, generation: 1 }))),
      })),
    );
    return dispatcher;
  });
}

for (const operation of [PROMOTE, MERGE]) {
  for (const decision of ["approve", "refuse"] as const) {
    it(`${operation.op} preserves Owner Wait across SQLite reopen and ${decision} settles exactly once`, async () => {
      const directory = mkdtempSync(join(tmpdir(), "provision-restart-"));
      const dbPath = join(directory, "ledger.sqlite");
      const catalogPath = join(directory, "catalog.sqlite");
      const open = () => {
        const session = openSessionStore(dbPath, { now: testClock() });
        const catalog = openCatalogStore(catalogPath, { now: testClock() });
        return {
          kernel: createSessionKernel(session, catalog),
          close: () => {
            session.close();
            catalog.close();
          },
          actions: session.actions,
        };
      };
      const first = open();
      const handleRef: { current: ReturnType<typeof open> } = { current: first };
      try {
        await runEffect(Effect.scoped(Effect.gen(function* () {
          const initial = yield* requestLedger({ kernel: first.kernel, domainRevisions: createRequestDomainRevisions(plane().stores) });
          const crashed = yield* restartDispatcher(crashAfterRequestOpen(initial, "provision.crash"));
          const call = { id: "original", tool: "provision", input: { operation } };
          expect(yield* Effect.result(crashed.executeWave([call], {
            sessionId: initial.identity.sessionId, turnId: initial.identity.turnId,
          }))).toMatchObject({ _tag: "Failure", failure: { _tag: "AgentFailure", operation: "provision.crash" } });
          const original = first.kernel.requestRows()[0];
          if (original === undefined) throw new Error("missing Owner request");
          expect(original).toMatchObject({ mode: "approval", state: "open", outcome: null,
            expectedResponders: ["owner"], parsedInput: call.input });
          expect(malloryStanding()).toBe("provisional");
          expect(actors().getEndpoint("ep:mallory")?.actorId).toBe("contact:mallory");
          // The restart: close the sqlite handles and reopen the same files.
          first.close();
          const reopened = open();
          handleRef.current = reopened;
          expect(reopened.kernel.requestById(original.requestId)).toEqual(original);
          const ready = Promise.withResolvers<void>();
          const recovered = yield* restartDispatcher(yield* requestLedger({
            id: initial.identity.sessionId,
            kernel: reopened.kernel,
            domainRevisions: createRequestDomainRevisions(plane().stores),
          }), ready.resolve);
          const recovery = recovered.executor.recover;
          if (recovery === undefined) throw new Error("missing recovery");
          const running = yield* Effect.forkScoped(recovery());
          yield* Effect.promise(() => bounded(ready.promise));
          const { approvals } = recovered.executor;
          if (approvals === undefined) throw new Error("missing recovered approvals");
          const pending = approvals.pending()[0];
          if (pending === undefined) throw new Error("missing recovered approval");
          expect(pending.durable).toEqual(original);
          yield* approvals.answer({ request: pending, decision, credential: "owner" });
          yield* Fiber.join(running);
          expect(yield* Effect.result(approvals.answer({ request: pending, decision, credential: "owner" })))
            .toMatchObject({ _tag: "Failure", failure: { _tag: "ExecutionApprovalError", code: "stale_approval" } });
          expect(reopened.kernel.requestById(original.requestId)?.state).toBe(decision === "approve" ? "resolved" : "refused");
          const settled = sessionTree(initial.identity.sessionId, reopened.actions);
          expect(settled.filter((action: LedgerAction.Node) => action.id === `${original.requestId}:application`))
            .toHaveLength(decision === "approve" ? 1 : 0);
          const result = settled.find((action: LedgerAction.Node) => {
            const value = action.effect.value;
            return action.kind === "tool" && value !== null && typeof value === "object" && !Array.isArray(value)
              && value.phase === "result" && value.callId === call.id;
          });
          expect(result?.effect.value).toMatchObject(decision === "approve"
            ? { terminal: "executed", toolResult: { toolCallId: call.id } }
            : { terminal: "blocked_pre", toolResult: { toolCallId: call.id, isError: true } });
          expect(malloryStanding()).toBe(decision === "approve" && operation.op === "contact_promote" ? "registered" : "provisional");
          expect(actors().getEndpoint("ep:mallory")?.actorId)
            .toBe(decision === "approve" && operation.op === "contact_merge" ? "actor:alice" : "contact:mallory");
          yield* recovery();
          expect(sessionTree(initial.identity.sessionId, reopened.actions)).toEqual(settled);
        })).pipe(Effect.provide(runnerTestLayer)));
      } finally {
        handleRef.current.close();
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
}
