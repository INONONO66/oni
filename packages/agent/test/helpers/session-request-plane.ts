import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { canonicalDigest, type SessionTransition } from "@openomni/protocol";
import { createSessionRequests } from "../../src/core/session/request";
import type { RunnerServices } from "../../src/core/ports/ports";
import { openCrashStores } from "./crash-stores";
import { isolated, isolatedLedger } from "./isolated";
import { allowConfigure, isolatedRuntime, withSessionServices } from "./session-services";

/** A file-backed isolation: same helper defaults, stores on disk at `dbPath`. */
export function fileRequest<A, E>(program: (dbPath: string) => Effect.Effect<A, E, import("effect").Scope.Scope | RunnerServices>) {
  const directory = mkdtempSync(join(tmpdir(), "request-plane-"));
  const dbPath = join(directory, "ledger.sqlite");
  // The directory outlives the isolation: the stores' close (WAL checkpoint)
  // must land before the files are removed.
  return isolated(Effect.scoped(program(dbPath)), () => {
    const stores = openCrashStores(dbPath);
    return {
      ...stores,
      close: () => {
        stores.close();
        rmSync(directory, { recursive: true, force: true });
      },
    };
  });
}

export const requestPlane = (clock = () => 100) => Effect.gen(function* () {
  const kernel = isolatedLedger().kernel;
  yield* kernel.materialize({
    id: "parent", parentId: null, role: "resident", tools: [],
    system: { preset: "", blocks: [] }, policyGeneration: 0, actionId: "configure", at: 1,
  });
  const adopted = yield* kernel.adoptFence({ sessionId: "parent", owner: "fixture", fence: 1 });
  yield* kernel.commit({
    sessionId: "parent", owner: "fixture", fence: adopted.fence, now: 1, expectedRevision: 1,
    actions: [{
      id: "invocation", sessionId: "parent", parentId: "configure", kind: "message", ts: 1, irreversible: true,
      intent: { encodingVersion: 1, value: {
        phase: "intent", callId: "original-call", value: { text: "parsed" },
        originalArgs: { text: "captured" }, effectHash: canonicalDigest({ route: "children" }),
      } },
      effect: { encodingVersion: 1, value: { phase: "pending" } },
    }],
    state: "idle",
  });
  const runtime = {
    authorizeConfigure: allowConfigure, observations: { publish: () => undefined }, clock,
    processId: "plane", entropy: () => "request",
    ...isolatedRuntime(),
  };
  const port = yield* withSessionServices(createSessionRequests(runtime), runtime);
  const opening = {
    requestId: "invocation", sessionId: "parent", expectedResponders: ["child"], correlation: {},
    allowedActions: ["report_result" as const], resolution: "first" as const, threshold: 1, deadline: 200, at: 100,
  };
  return { runtime, port, opening };
});

export function planeAnswer(request: SessionTransition.Request, responder = "child", id = `${responder}:answer`): SessionTransition.Answer {
  return {
    inputId: id, requestId: request.requestId, sessionId: request.sessionId, receivedAt: 100,
    principal: { kind: "session", principalId: responder, evidenceId: id },
    bindingDigest: request.bindingDigest, inputHash: request.inputHash, effectHash: request.effectHash,
    generation: request.generation, toolsHash: request.toolsHash, domainRevisions: request.domainRevisions,
    decision: "answer", allowedAction: "report_result", content: responder,
  };
}
