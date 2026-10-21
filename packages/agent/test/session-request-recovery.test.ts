import { sessionTree } from "./helpers/session-tree";
import { allowConfigure, isolatedRuntime, kernelRuntime, type SessionFixture, withSessionServices } from "./helpers/session-services";
import { Effect, Fiber } from "effect";
import { isolated, isolatedLedger, type IsolatedLedgerHandle } from "./helpers/isolated";
import { AgentFailure } from "../src/core/ports/failure";
import { expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { LedgerAction, PlainValue, SessionTransition } from "@oni/protocol";
import { z } from "zod";
import { defineTool, eraseTool } from "../src/core/loop/tool";
import { createTurnDispatcher } from "../src/plugins/tool";
import { createSessionRequests } from "../src/core/session/request";
import { compiledPolicy } from "./helpers/compiled-policy";
import { requestLedger, crashAfterRequestOpen, failure, type RequestLedger } from "./helpers/effect-g1";
import { bounded } from "./helpers/bounded";
import { catalogLayer, executorLayer } from "./helpers/service-layers";
import { openCrashStores } from "./helpers/crash-stores";
import { fileRequest, planeAnswer, requestPlane } from "./helpers/session-request-plane";
import type { RunnerServices } from "../src/core/ports/ports";
import { TEST_APPROVAL_POLICY } from "./helpers/approval-policy";

/**
 * File-backed isolation with a process-crash restart (W5.2): the Storage
 * singleton is gone, so "reopen" is closing the store handles and opening
 * fresh ones over the same SQLite files behind the lazy `isolatedLedger()`.
 */
function persisted<A, E>(program: (reopen: () => void) => Effect.Effect<A, E, import("effect").Scope.Scope | RunnerServices>) {
  const directory = mkdtempSync(join(tmpdir(), "request-recovery-"));
  const dbPath = join(directory, "ledger.sqlite");
  let current = openCrashStores(dbPath);
  const ledger: IsolatedLedgerHandle = {
    get kernel() { return current.kernel; },
    openKernel: () => current.kernel,
    listSessions: () => current.kernel.listRows(),
    get session() { return current.session; },
    get catalog() { return current.catalog; },
    get bus() { return current.bus; },
    close: () => {
      current.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
  const reopen = () => {
    current.close();
    current = openCrashStores(dbPath);
  };
  return isolated(Effect.scoped(program(reopen)), () => ledger);
}
const proof = { kind: "owner", principalId: "owner", evidenceId: "authenticated" } as const;
function definitions(bodies: string[]) {
  return ["read", "write", "last"].map((name: string) =>
    eraseTool(
      defineTool(
        {
          name,
          category: "mutation",
          description: name,
          input: z.object({ text: z.string() }).strict(),
          output: z.object({ value: z.string() }).strict(),
          visibility: { model: ["resident"], cell: ["resident"] },
          ...(name === "last" ? { sequential: true as const } : {}),
          execute: async (input: { text: string }) => {
            bodies.push(`${name}:${input.text}`);
            return { value: input.text };
          },
          render: (_input: { text: string }, result: { value: string }) => result.value,
        },
        () => ({ required: name === "write", domainRevisions: {} }),
      ),
    ),
  );
}
const calls = ["read", "write", "last"].map((tool: string) => ({
  id: `call:${tool}`,
  tool,
  input: { text: `original:${tool}` },
}));
function dispatcher(
  recording: RequestLedger,
  bodies: string[],
  ready?: () => void,
) {
  return Effect.gen(function* () {
  const result: Effect.Success<ReturnType<typeof createTurnDispatcher>> = yield* createTurnDispatcher(
    {
      ...recording.identity,
      ledger: {
        ...recording.ledger,
        requestById: (id) => {
          if ((result.executor.approvals?.pending().length ?? 0) > 0) ready?.();
          return recording.ledger.requestById?.(id);
        },
      },
      actionId: recording.identity.parentActionId,
    },
    {
      authorizeApproval: () => Effect.succeed(proof),
      approvalPolicy: TEST_APPROVAL_POLICY,
    },
  ).pipe(Effect.provide(catalogLayer(definitions(bodies))), Effect.provide(executorLayer({
    clock: recording.clock, entropy: recording.entropy, observations: { publish: () => undefined }, policy: compiledPolicy(),
  })));
  return result;
  });
}
function currentRequest(): SessionTransition.Request {
  const request = isolatedLedger().kernel.requestRows()[0];
  if (request === undefined) throw new Error("missing durable request");
  return request;
}
function ownerAnswer(request: SessionTransition.Request): SessionTransition.Answer {
  return {
    inputId: "answer",
    requestId: request.requestId,
    sessionId: request.sessionId,
    receivedAt: 200,
    principal: proof,
    bindingDigest: request.bindingDigest,
    inputHash: request.inputHash,
    effectHash: request.effectHash,
    generation: request.generation,
    toolsHash: request.toolsHash,
    domainRevisions: request.domainRevisions,
    decision: "approve",
    allowedAction: "report_result",
    content: "approve",
  };
}
it("reopens SQLite and resumes the exact original wave without a model reconstruction", () => persisted((reopen) => Effect.gen(function* () {
  const bodies: string[] = [];
  const initial = yield* requestLedger();
  const crashed = yield* dispatcher(
    crashAfterRequestOpen(initial, "process lost after durable suspension"),
    bodies,
  );
  expect(yield* Effect.flip(
    crashed.executeWave(calls, { sessionId: initial.identity.sessionId, turnId: "turn" }),
  )).toMatchObject({ _tag: "AgentFailure", operation: "process lost after durable suspension" });
  const originalId = currentRequest().requestId;
  expect(bodies).toEqual([]);
  reopen();
  const ready = Promise.withResolvers<void>();
  const recovered = yield* dispatcher(yield* requestLedger(), bodies, ready.resolve);
  const recovery = recovered.executor.recover?.();
  if (recovery === undefined) throw new Error("missing recovery");
  const recovering = yield* Effect.forkScoped(recovery);
  yield* Effect.promise(() => bounded(ready.promise));
  const approvals = recovered.executor.approvals;
  const pending = approvals?.pending()[0];
  if (approvals === undefined || pending === undefined) throw new Error("missing recovered approval");
  expect(pending.id).toBe(originalId);
  expect(pending.durable.parsedInput).toEqual({ text: "original:write" });
  yield* approvals.answer({
    request: pending,
    credential: "proof",
    decision: "approve",
  });
  yield* Fiber.join(recovering);
  expect(bodies).toEqual(["read:original:read", "write:original:write", "last:original:last"]);
  yield* recovered.executor.recover();
  expect(bodies).toHaveLength(3);
  expect(
    sessionTree(isolatedLedger().kernel, initial.identity.sessionId).filter(
      (action: LedgerAction.Node) => action.id === `${originalId}:application`,
    ),
  ).toHaveLength(1);
})));
it("a committed application claim prevents replay after result persistence fails", () => persisted((reopen) => Effect.gen(function* () {
  const bodies: string[] = [];
  const ready = Promise.withResolvers<void>();
  const initial = yield* requestLedger();
  const commit = initial.ledger.commit;
  const crashed = yield* dispatcher(
    {
      ...initial,
      ledger: {
        ...initial.ledger,
        commit(action: LedgerAction.Append) {
          const effect = action.effect.value;
          if (
            action.kind === "tool" &&
            effect !== null &&
            typeof effect === "object" &&
            !Array.isArray(effect) &&
            effect.phase === "result"
          )
            return Effect.die(new AgentFailure({ operation: "result.persist", cause: "crash" }));
          return commit(action);
        },
      },
    },
    bodies,
    ready.resolve,
  );
  const running = crashed.executeWave(calls, {
    sessionId: initial.identity.sessionId,
    turnId: "turn",
  });
  const settled = yield* Effect.forkScoped(failure(running));
  yield* Effect.promise(() => bounded(ready.promise));
  const approvals = crashed.executor.approvals;
  const pending = approvals?.pending()[0];
  if (approvals === undefined || pending === undefined) throw new Error("missing approval");
  yield* approvals.answer({
    request: pending,
    credential: "proof",
    decision: "approve",
  });
  expect(yield* Fiber.join(settled)).toMatchObject({ _tag: "AgentFailure", operation: "result.persist" });
  expect(bodies).toHaveLength(3);
  reopen();
  const recovered = yield* dispatcher(yield* requestLedger(), bodies);
  yield* recovered.executor.recover();
  expect(bodies).toHaveLength(3);
  const effects = sessionTree(isolatedLedger().kernel, initial.identity.sessionId).map(
    (action: LedgerAction.Node) => action.effect.value,
  );
  expect(
    effects.filter(
      (effect: PlainValue) =>
        effect !== null &&
        typeof effect === "object" &&
        !Array.isArray(effect) &&
        effect.terminal === "outcome_unknown",
    ),
  ).toHaveLength(3);
})));
// W5.2: the TTL "held lease" refusal is the deleted lease plane. With no live
// handle, an out-of-turn gateway transition adopts a strictly newer fence and
// resolves; a still-live in-process writer is covered by the live-handle fence
// pin in session-request-controller and session-failure-boundaries.
it("a gateway answer adopts a strictly newer fence over a crashed writer and resolves", () => persisted(() => Effect.gen(function* () {
  const initial = yield* requestLedger();
  const crashed = yield* dispatcher(crashAfterRequestOpen(initial, "lost"), []);
  expect(yield* Effect.flip(
    crashed.executeWave(calls, { sessionId: initial.identity.sessionId, turnId: "turn" }),
  )).toMatchObject({ _tag: "AgentFailure", operation: "lost" });
  const request = currentRequest();
  const before = isolatedLedger().kernel.row(request.sessionId);
  const gateway = (yield* Effect.gen(function* () { const fixture: SessionFixture = {
    clock: () => 200,
    observations: { publish: () => undefined },
    authorizeConfigure: allowConfigure,
    ...isolatedRuntime(),
  }; return yield* withSessionServices(createSessionRequests(fixture), fixture); }));
  expect(yield* gateway.answer(ownerAnswer(request))).toBe("resolved");
  expect(currentRequest().state).toBe("resolved");
  const after = isolatedLedger().kernel.row(request.sessionId);
  expect(after.fence).toBe(before.fence + 1);
  expect(after.fenceOwner).not.toBe(before.fenceOwner);
})));

it.each(["answer", "timeout", "cancel"] as const)("%s wins once across a request-port restart", (winner: "answer" | "timeout" | "cancel") => fileRequest((dbPath) => Effect.gen(function* () {
  let now = 100;
  const { port, runtime, opening } = yield* requestPlane(() => now);
  const opened = yield* port.open(opening);
  const answer = planeAnswer(opened);
  const cancel = {
    requestId: opened.requestId, sessionId: opened.sessionId, inputId: "cancel",
    principal: { kind: "session" as const, principalId: opened.sessionId, evidenceId: "original-owner" }, at: 100,
  };
  expect(yield* port.cancel({ ...cancel, inputId: "foreign-cancel", principal: { ...cancel.principal, principalId: "stranger" } })).toBe("rejected");
  if (winner === "answer") expect(yield* port.answer(answer)).toBe("resolved");
  if (winner === "cancel") expect(yield* port.cancel(cancel)).toBe("cancelled");
  if (winner === "timeout") { now = 200; yield* port.timeout(opened.requestId, now); }
  const terminal = isolatedLedger().kernel.actionById("invocation:resolution");
  // Process restart: a fresh store handle over the same files, a fresh port.
  const second = openCrashStores(dbPath);
  yield* Effect.addFinalizer(() => Effect.sync(() => second.close()));
  const restarted = { ...runtime, ...kernelRuntime(() => second.kernel) };
  const reopened = yield* withSessionServices(createSessionRequests(restarted), restarted);
  expect(yield* reopened.cancel({ ...cancel, inputId: "cancel-after-reopen" })).toBe("duplicate");
  now = 200;
  yield* reopened.timeout(opened.requestId, now);
  expect(yield* reopened.answer({ ...answer, inputId: "late-answer", receivedAt: 199 })).toBe("late_unknown");
  expect(second.kernel.actionById("invocation:resolution")).toEqual(terminal);
  expect(second.kernel.requestById(opened.requestId)?.state).toBe(({ answer: "resolved", timeout: "expired", cancel: "cancelled" } as const)[winner]);
  expect(second.kernel.pendingMessages("parent")).toHaveLength(winner === "answer" ? 1 : 0);
  // W5.2: the alarms table is deleted; request deadlines live on the entity
  // timer plane, so there is no "invocation:deadline" row to assert here.
})));
