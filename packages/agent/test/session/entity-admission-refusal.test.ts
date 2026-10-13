import { expect, test } from "bun:test";
import { Effect } from "effect";
import type { DeliverRefused } from "../../src/core/journal/messages";
import * as SessionHandleStore from "../../src/core/store/fence";
import { openCatalogStore } from "../../src/core/store/catalog";
import { openSessionStore } from "../../src/core/store/session-file";
import { receivedMessageAction, turnIntentAction } from "../../src/core/journal/commit";
import { CommitRefused } from "../../src/core/store/errors";
import { createController } from "../../src/testing/controller";
import { resolveSessionRuntime } from "../../src/core/session/run";
import { allowConfigure, kernelRuntime, withSessionServices } from "../helpers/session-services";
import { runAgent } from "../helpers/executor";
import { clusterTempDir, readChain, runCluster, sendDeliver, sendPrompt, sessionFileFor } from "../helpers/cluster-runtime";

const seedClock = () => 1_000;

/** One durably inconsistent session: state `running` with no open turn (admission -> refused). */
function seedWedgedSession(sessionsDir: string, catalogFile: string) {
  return Effect.gen(function* () {
    const catalog = openCatalogStore(catalogFile, { now: seedClock });
    const store = openSessionStore(sessionFileFor(sessionsDir, "wedged"), { now: seedClock });
    const kernel = SessionHandleStore.createSessionKernel(store, catalog);
    yield* kernel.materialize({
      id: "wedged", parentId: null, role: "resident", tools: [],
      system: { preset: "", blocks: [] }, policyGeneration: 1,
      actionId: "wedged:materialize", at: seedClock(),
    });
    catalog.indexSession({ id: "wedged", parentId: null, role: "resident", createdAt: seedClock() });
    const fence = catalog.rotateFence("wedged");
    yield* kernel.adoptFence({ sessionId: "wedged", owner: "seed", fence });
    yield* kernel.commit({
      sessionId: "wedged", owner: "seed", fence, now: seedClock(),
      expectedRevision: kernel.row("wedged").revision,
      actions: [
        receivedMessageAction({
          id: "wedged:seed", sessionId: "wedged", kind: "prompt", content: "seed",
          origin: { encodingVersion: 1, value: { kind: "session", id: "wedged" } },
          parentActionId: null, at: seedClock(),
        }),
      ],
      state: "running",
    });
    store.close();
    catalog.close();
  });
}

// A refused admission is a typed `deliver` rejection,
// never a success ack, and it appends zero new journal facts; RPC callers
// distinguish it from an admitted turn and from a consumed signal.
test("deliver distinguishes an admitted turn, a consumed signal and a typed denial", async () => {
  const { sessionsDir, catalogFile } = clusterTempDir("1245-admission-refusal-");
  await runAgent(seedWedgedSession(sessionsDir, catalogFile));
  await runCluster({ sessionsDir, catalogFile }, Effect.gen(function* () {
    // A healthy prompt is admitted and runs a turn.
    const turn = yield* sendPrompt("healthy", "m1", "hello");
    expect(turn.existed).toBe(false);
    expect(readChain(sessionFileFor(sessionsDir, "healthy"), "healthy").some(
      (row) => row.kind === "turn",
    )).toBe(true);

    // An interrupt signal on the now-idle session is appended and consumed by
    // the drain: its delivery record lands on the chain.
    const stop = yield* sendDeliver("healthy", {
      kind: "signal", idempotencyKey: "m2", content: "", control: "interrupt",
    });
    expect(stop.existed).toBe(false);
    expect(readChain(sessionFileFor(sessionsDir, "healthy"), "healthy").some(
      (row) => row.id === "m2:delivery",
    )).toBe(true);

    // The wedged session's admission is refused: a typed `denied` rejection
    // with zero new facts — the message is NOT appended.
    const before = readChain(sessionFileFor(sessionsDir, "wedged"), "wedged").length;
    const refused = yield* sendPrompt("wedged", "m3", "are you there?").pipe(Effect.flip);
    expect((refused as DeliverRefused).code).toBe("denied");
    expect(readChain(sessionFileFor(sessionsDir, "wedged"), "wedged").length).toBe(before);
  }));
});

// The controller's shutdown seal reuses the entity's bounded
// `retryRevision` — a writer that conflicts on every attempt gets exactly
// three CAS attempts and then the typed `AdmissionFailure{code: revision}`,
// never an unbounded in-process spin.
test("the shutdown seal retries a revision conflict exactly three times, then fails typed `revision`", async () => {
  const { sessionsDir, catalogFile } = clusterTempDir("1344-seal-revision-");
  const catalog = openCatalogStore(catalogFile, { now: seedClock });
  const store = openSessionStore(sessionFileFor(sessionsDir, "spin"), { now: seedClock });
  const kernel = SessionHandleStore.createSessionKernel(store, catalog);
  await runAgent(Effect.gen(function* () {
    yield* kernel.materialize({
      id: "spin", parentId: null, role: "resident", tools: [],
      system: { preset: "", blocks: [] }, policyGeneration: 1,
      actionId: "spin:materialize", at: seedClock(),
    });
    catalog.indexSession({ id: "spin", parentId: null, role: "resident", createdAt: seedClock() });
    const fence = catalog.rotateFence("spin");
    yield* kernel.adoptFence({ sessionId: "spin", owner: "seed", fence });
    // One open turn so the seal has a terminal to commit.
    yield* kernel.commit({
      sessionId: "spin", owner: "seed", fence, now: seedClock(),
      expectedRevision: kernel.row("spin").revision,
      actions: [
        receivedMessageAction({
          id: "spin:seed", sessionId: "spin", kind: "prompt", content: "seed",
          origin: { encodingVersion: 1, value: { kind: "session", id: "spin" } },
          parentActionId: null, at: seedClock(),
        }),
        turnIntentAction({
          id: "spin:turn", parentId: "spin:seed", sessionId: "spin",
          resultId: "spin:turn:result", deliveryIds: ["spin:seed"],
          generation: kernel.latestGenerationFor("spin"),
          resumeCount: 0, boundaryActionId: null, at: seedClock(),
        }),
      ],
      state: "running",
    });
  }));
  let conflicts = 0;
  const proxy: typeof kernel = {
    ...kernel,
    commit: (input) =>
      input.actions.some((action) => action.kind === "turn")
        ? Effect.suspend(() => {
          conflicts += 1;
          const row = kernel.row("spin");
          return Effect.fail(new CommitRefused({
            sessionId: "spin", reason: "revision", expectedRevision: input.expectedRevision,
            currentRevision: row.revision, fence: input.fence, currentFence: row.fence,
          }));
        })
        : kernel.commit(input),
  };
  const runtime = {
    observations: { publish: () => undefined },
    clock: seedClock,
    authorizeConfigure: allowConfigure,
    closeGraceMs: 0,
    ...kernelRuntime(() => proxy),
  };
  const failure = await runAgent(Effect.scoped(withSessionServices(Effect.gen(function* () {
    const resolved = yield* resolveSessionRuntime(runtime);
    const scope = yield* Effect.scope;
    const controller = yield* createController(
      proxy, "spin",
      () => Effect.die("the seal test never runs a turn"),
      resolved,
      { reactivate: () => Effect.die("the seal test never reactivates"), release: () => undefined },
      scope,
    );
    return yield* controller.handle.close().pipe(Effect.flip);
  }), runtime)));
  store.close();
  catalog.close();
  expect(conflicts).toBe(3);
  expect(failure._tag).toBe("AdmissionFailure");
  expect(failure._tag === "AdmissionFailure" ? failure.code : undefined).toBe("revision");
});
