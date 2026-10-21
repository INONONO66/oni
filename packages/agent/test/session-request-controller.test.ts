import { sessionTree } from "./helpers/session-tree";
import { turnTestLayer, catalogLayer } from "./helpers/service-layers";
import { allowConfigure, isolatedRuntime, type SessionFixture as SessionRuntime, type SessionFixture, withSessionServices } from "./helpers/session-services";
import { Effect, Fiber } from "effect";
import type { ResolvedExecutorOptions } from "../src/core/loop/executor";
import { isolated, isolatedLedger } from "./helpers/isolated";
import { expect, it } from "bun:test";
import { seedPolicy } from "./helpers/seed-policy";
import { L0Observation, type SessionTransition } from "@oni/protocol";
import { closeSessions } from "../src/core/session/run";
import { session } from "../src/testing/registry";
import { eraseTool, projectTools } from "../src/core/loop/tool";
import { createTurnDispatcher } from "../src/plugins/tool";
import { valueTool } from "./helpers/query-tool";
import { createSessionRequests } from "../src/core/session/request";
import { suspendedRequest, } from "./helpers/effect-g2";

// W5.2: the TTL-expiry test ("does not reacquire an expired lease under a still-live
// suspended runner") is deleted with the lease plane — takeover is a fence adoption now,
// covered by the crash-matrix takeover cells and the kernel adoptFence CAS tests.
let runtime: SessionRuntime;
function setup() {
  return Effect.gen(function* () {
    let now = 100;
    const suspended = Promise.withResolvers<void>();
    const effects: string[] = [];
    const ledger = isolatedLedger();
    runtime = {
      authorizeConfigure: allowConfigure,
      clock: () => now,
      entropy: () => crypto.randomUUID(),
      observations: { publish: () => undefined },
      closeGraceMs: 0,
      ...isolatedRuntime(),
    };
    // The commit sink is the isolation bus now: watch it for the opened request row.
    ledger.bus.subscribe(L0Observation.ActionCommittedEvent, () => {
      if (ledger.kernel.requestRows("controller").some((request: SessionTransition.Request) => request.state === "open"))
        suspended.resolve();
    });
    const tool = eraseTool(
      valueTool({
        name: "protected",
        category: "mutation",
        execute: async (value: string) => {
          effects.push(value);
          return value;
        },
        approval: () => ({ required: true, domainRevisions: {} }),
      }),
    );
    seedPolicy();
    yield* Effect.addFinalizer(() => closeSessions(runtime).pipe(Effect.orDie));
    const handle = yield* Effect.gen(function* () { const fixture: SessionFixture = runtime; return yield* withSessionServices(session({
        id: "controller",
        role: "resident",
        tools: projectTools([tool]).session,
        runner: (input: import("../src/core/session/run").SessionRunnerInput) =>
          Effect.gen(function* () {
            const dispatcher = (yield* Effect.gen(function* () { const turnInput: Parameters<typeof createTurnDispatcher>[0] & { readonly policy?: ResolvedExecutorOptions["policy"] } = input; const turnRuntime: Parameters<typeof createTurnDispatcher>[1] & Partial<Pick<ResolvedExecutorOptions, "clock" | "entropy" | "observations">> = runtime; return yield* createTurnDispatcher(turnInput, turnRuntime).pipe(Effect.provide(catalogLayer([tool])), Effect.provide(turnTestLayer(turnInput, turnRuntime))); }));
            yield* dispatcher.execute(
              { id: "original", tool: tool.name, input: { value: "original" } },
              { sessionId: input.sessionId, turnId: input.turnId, signal: input.signal },
            );
            return { kind: "result", text: "done" };
          }),
      }, fixture), fixture); });
    return {
      handle,
      effects,
      suspended: suspended.promise,
      setClock(at: number) {
        now = at;
      },
    };
  });
}
function answer(request: SessionTransition.Request): SessionTransition.Answer {
  return {
    inputId: "authenticated-answer",
    requestId: request.requestId,
    sessionId: request.sessionId,
    receivedAt: 100,
    principal: { kind: "owner", principalId: "owner", evidenceId: "auth" },
    bindingDigest: request.bindingDigest,
    inputHash: request.inputHash,
    effectHash: request.effectHash,
    generation: request.generation,
    toolsHash: request.toolsHash,
    domainRevisions: request.domainRevisions,
    decision: "approve",
    allowedAction: "report_result",
    content: "yes",
  };
}
it("the injected gateway port uses the live controller's fence and releases the original call", () =>
  isolated(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* setup();
        const { running, request, fence } = yield* suspendedRequest(f.handle, f.suspended);
        expect(f.effects).toEqual([]);
        expect(yield* (yield* Effect.gen(function* () { const fixture: SessionFixture = runtime; return yield* withSessionServices(createSessionRequests(fixture), fixture); })).answer(answer(request))).toBe("resolved");
        yield* Fiber.join(running);
        expect(f.effects).toEqual(["original"]);
        expect(isolatedLedger().kernel.row(f.handle.id).fence).toBe(fence);
        expect(isolatedLedger().kernel.requestById(request.requestId)?.state).toBe("resolved");
      }),
    ),
  ));
it("configuration drift refuses consent while interruption cancels the whole suspended call", () =>
  isolated(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* setup();
        const { running, request } = yield* suspendedRequest(f.handle, f.suspended);
        yield* f.handle.system.blocks.set([{ id: "new", source: "owner", content: "changed" }]);
        expect(yield* (yield* Effect.gen(function* () { const fixture: SessionFixture = runtime; return yield* withSessionServices(createSessionRequests(fixture), fixture); })).answer(answer(request))).toBe("rejected");
        expect(f.effects).toEqual([]);
        yield* f.handle.interrupt();
        yield* Fiber.join(running);
        expect(isolatedLedger().kernel.requestById(request.requestId)?.state).toBe("cancelled");
        expect(
          sessionTree(isolatedLedger().kernel, f.handle.id).some(
            (action: import("@oni/protocol").LedgerAction.Node) => {
              const effect = action.effect.value;
              return (
                action.kind === "tool" &&
                action.parentId === request.requestId &&
                effect !== null &&
                typeof effect === "object" &&
                !Array.isArray(effect) &&
                effect.terminal === "blocked_pre" &&
                effect.reason === "approval_refused"
              );
            },
          ),
        ).toBe(true);
        expect(f.effects).toEqual([]);
      }),
    ),
  ));
