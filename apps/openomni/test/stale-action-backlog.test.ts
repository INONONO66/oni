import { beforeEach, expect, test } from "bun:test";
import { Delivery, type LedgerAction, type PlainValue, SessionGeneration } from "@openomni/protocol";
import { staleActionBacklog, turnIntentAction } from "../../../packages/agent/src/core/commit";
import type * as SessionHandleStore from "../../../packages/agent/src/core/store/fence";
import { materializeSession } from "../../../packages/agent/test/store/helpers/session";
import { useMemoryStores } from "../../../packages/agent/test/store/helpers/storage";
import { TEST_APPROVAL_POLICY } from "../../../packages/agent/test/helpers/approval-policy";

/**
 * #1256 H-3: a deferred `action` input carries the journal ordinal (`after`)
 * its payload was computed against. One pointing BEFORE the latest executed
 * compaction reasons about a context that no longer exists: it is never
 * consumed — the next turn closes it durably via `turn.consumed.stale` — and
 * the pending fold drops it from every later backlog.
 */

function row(id: string, kind: Delivery.Kind, after?: number): Delivery.Row {
  return Delivery.Row.parse({
    id,
    sessionId: "s",
    kind,
    content: "{}",
    origin: { encodingVersion: 1, value: { kind: "hook.late" } },
    ...(after === undefined ? {} : { after }),
    status: "pending",
    consumedBy: null,
    consumedAt: null,
    createdAt: 1,
    ordinal: 1,
  });
}

test("staleActionBacklog: only action inputs with after < compaction head fold stale", () => {
  const prompt = row("p1", "prompt");
  const oldAction = row("a1", "action", 3);
  const boundaryAction = row("a2", "action", 5);
  const freshAction = row("a3", "action", 9);
  const cursorless = row("a4", "action");
  const { live, stale } = staleActionBacklog([prompt, oldAction, boundaryAction, freshAction, cursorless], 5);
  expect(stale.map((item) => item.id)).toEqual(["a1"]);
  expect(live.map((item) => item.id)).toEqual(["p1", "a2", "a3", "a4"]);
  // No compaction yet (head 0): nothing is stale.
  expect(staleActionBacklog([oldAction], 0).stale).toEqual([]);
});

test("turnIntentAction journals consumedStale on the turn intent; an empty list stays absent", () => {
  const generation = SessionGeneration.Snapshot.parse({
    generation: 1,
    revertTo: 0,
    tools: [],
    toolsHash: "t",
    systemPreset: "",
    systemBlocks: [],
    systemValue: "",
    systemHash: "s",
    policyGeneration: 1,
  });
  const base = {
    id: "turn-1",
    parentId: null,
    sessionId: "s",
    resultId: "r1",
    deliveryIds: ["p1"],
    generation,
    resumeCount: 0,
    boundaryActionId: null,
    at: 1,
  };
  const closed = turnIntentAction({ ...base, consumedStale: ["a1", "a2"] });
  expect((closed.intent.value as { consumedStale?: string[] }).consumedStale).toEqual(["a1", "a2"]);
  const clean = turnIntentAction({ ...base, consumedStale: [] });
  expect("consumedStale" in (clean.intent.value as object)).toBe(false);
});

const stores = useMemoryStores();
let kernel: SessionHandleStore.SessionKernel;
beforeEach(() => {
  kernel = stores.kernel;
  materializeSession(kernel, "stale");
});

function append(id: string, kind: LedgerAction.Kind, intent: PlainValue, effect: PlainValue) {
  const receipt = stores.session.actions.append(
    {
      id,
      kind,
      intent: { encodingVersion: 1, value: intent },
      effect: { encodingVersion: 1, value: effect },
      sessionId: "stale",
      parentId: null,
      irreversible: true,
      ts: 2,
    },
    kernel.row("stale").revision,
  );
  if (receipt === undefined) throw new Error(`append refused: ${id}`);
  return receipt.action;
}

test("the chain fold: after rides the pending row, compactionHead is the executed compaction, turn.consumedStale closes", () => {
  append("p1", "prompt", { kind: "message" }, { deliveryKind: "prompt", content: "hi" });
  append("a1", "action", { kind: "hook.late", after: 1 }, { deliveryKind: "action", content: "{}" });
  // No executed compaction yet: head is 0, nothing can be stale.
  expect(kernel.compactionHead("stale")).toBe(0);
  const compaction = append(
    "c1",
    "compaction",
    { reason: "threshold" },
    { phase: "result", terminal: "executed", result: { projection: [] } },
  );
  expect(kernel.compactionHead("stale")).toBe(compaction.ordinal);
  append("a2", "action", { kind: "hook.late", after: compaction.ordinal }, { deliveryKind: "action", content: "{}" });

  const pending = kernel.pendingMessages("stale");
  expect(pending.map((item) => [item.id, item.after ?? null])).toEqual([
    ["p1", null],
    ["a1", 1],
    ["a2", compaction.ordinal],
  ]);
  const { live, stale } = staleActionBacklog(pending, kernel.compactionHead("stale"));
  expect(stale.map((item) => item.id)).toEqual(["a1"]);
  expect(live.map((item) => item.id)).toEqual(["p1", "a2"]);

  // The turn closes the stale input via its intent's consumedStale list: the
  // pending fold (SQL projection) never surfaces it again.
  append(
    "t1",
    "turn",
    { phase: "intent", deliveryIds: [], consumedStale: ["a1"] },
    { phase: "pending" },
  );
  expect(kernel.pendingMessages("stale").map((item) => item.id)).toEqual(["p1", "a2"]);
});

// ---------------------------------------------------------------------------
// #1256 H-1 (r3): a LIVE boundary (after_tools, mid-turn) closes a stale
// action instead of delivering it — the split runs inside the one
// boundary-consumption function, not only at turn start.
// ---------------------------------------------------------------------------

import { Deferred, Effect, Fiber } from "effect";
import { boundaryConsumption, DEFAULT_CONSUMPTION } from "../../../packages/agent/src/core/commit";
import { session } from "../../../packages/agent/src/testing/registry";
import { isolated, isolatedLedger } from "../../../packages/agent/test/helpers/isolated";
import { commitReceivedMessage } from "../../../packages/agent/test/helpers/ingress";
import { seedPolicy } from "../../../packages/agent/test/helpers/seed-policy";
import { sessionTree } from "../../../packages/agent/test/helpers/session-tree";
import {
  allowConfigure,
  isolatedRuntime,
  withSessionServices,
  type SessionFixture,
} from "../../../packages/agent/test/helpers/session-services";
import type { SessionRunner } from "../../../packages/agent/src/core/run";

test("boundaryConsumption applies the stale split at every boundary", () => {
  const staleSteer = { ...row("a1", "action", 3), delivery: "steer" as const };
  const liveSteer = { ...row("a2", "action", 9), delivery: "steer" as const };
  const out = boundaryConsumption([staleSteer, liveSteer], "after_tools", DEFAULT_CONSUMPTION, 5);
  expect(out.consumed.map((item) => item.id)).toEqual(["a2"]);
  expect(out.stale.map((item) => item.id)).toEqual(["a1"]);
});

function fixture(): SessionFixture {
  let sequence = 0;
  return {
    authorizeConfigure: allowConfigure,
    observations: { publish: () => undefined, subscribe: () => () => undefined },
    clock: () => 30,
    entropy: () => `sb-${++sequence}`,
    processId: "sb",
    ...isolatedRuntime(),
  };
}

/** A held turn that records only messages delivered at its live boundary. */
function staleBoundaryRunner(
  entered: Deferred.Deferred<void>,
  release: Deferred.Deferred<void>,
  drained: string[][],
): SessionRunner {
  return (input) =>
    Effect.gen(function* () {
      yield* Deferred.succeed(entered, undefined);
      yield* Deferred.await(release);
      drained.push((yield* input.boundary("after_tools")).messages.map((message) => message.text));
      return { kind: "result", text: "done" };
    });
}

function executedCompaction(sessionId: string, parentId: string | null, at: number) {
  return {
    id: "compaction-1",
    parentId,
    sessionId,
    kind: "compaction" as const,
    intent: { encodingVersion: 1 as const, value: { reason: "threshold" } },
    effect: {
      encodingVersion: 1 as const,
      value: { phase: "result", terminal: "executed", result: { projection: [] } },
    },
    irreversible: true as const,
    ts: at,
  };
}

const bounded = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.timeout("2 seconds"));

test("a stale action delivered DURING a turn closes via turn.consumed.stale at the live boundary; zero delivery", () =>
  isolated(
    Effect.gen(function* () {
      seedPolicy();
      const runtime = fixture();
      const drained: string[][] = [];
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const handle = yield* withSessionServices(
        session({ id: "S", role: "resident", runner: staleBoundaryRunner(entered, release, drained) }, runtime),
        runtime,
      );
      const kernel = isolatedLedger().kernel;
      // An EXECUTED compaction before the turn: the head every later cursor
      // is measured against.
      const current = kernel.row("S");
      const writer =
        current.fenceOwner === null
          ? kernel
              .adoptFence({ sessionId: "S", owner: "compactor", fence: current.fence + 1 })
              .pipe(Effect.map((adopted) => ({ owner: "compactor", fence: adopted.fence })))
          : Effect.succeed({ owner: current.fenceOwner, fence: current.fence });
      yield* writer.pipe(
          Effect.flatMap(({ owner, fence }) =>
            kernel.commit({
              sessionId: "S",
              owner,
              fence,
              now: 29,
              expectedRevision: current.revision,
              actions: [executedCompaction("S", kernel.latestAction("S")?.id ?? null, 29)],
              state: current.state,
            }),
          ),
        );
      expect(kernel.compactionHead("S")).toBeGreaterThan(1);
      const running = yield* Effect.forkScoped(handle.prompt("start"));
      yield* bounded(Deferred.await(entered));
      // Mid-turn, a late hook result arrives through the deliver door as a
      // steer action whose after cursor points BEFORE the compaction head.
      yield* commitReceivedMessage(kernel, {
        id: "stale-action",
        sessionId: "S",
        kind: "action",
        content: "{}",
        origin: { encodingVersion: 1, value: { kind: "hook.late", after: 1 } },
        createdAt: 31,
        parentActionId: kernel.latestAction("S")?.id ?? null,
        delivery: "steer",
      });
      yield* Deferred.succeed(release, undefined);
      yield* bounded(Fiber.join(running));
      // The live after_tools boundary did NOT deliver the stale action...
      expect(drained[0]).toEqual([]);
      const actions = sessionTree(kernel, "S");
      const deliveries = actions.filter(
        (action) =>
          (action.intent.value as { deliveryId?: string } | null)?.deliveryId === "stale-action",
      );
      expect(deliveries).toEqual([]);
      // ...it closed it durably via the checkpoint's turn.consumed.stale...
      const checkpoints = actions.filter(
        (action) =>
          action.kind === "turn" &&
          (action.intent.value as { phase?: string }).phase === "checkpoint",
      );
      expect(
        checkpoints.map((action) => (action.intent.value as { consumedStale?: string[] }).consumedStale),
      ).toContainEqual(["stale-action"]);
      // ...and the pending fold never surfaces it again.
      expect(kernel.pendingMessages("S").map((item) => item.id)).toEqual([]);
    }),
  ));

// ---------------------------------------------------------------------------
// #1256 H-3(a) (r4): the SAME closure, but the stale action travels the REAL
// entity `deliver{kind: "action"}` door (the late hook re-entry path) into the
// production run loop — entity Deliver RPC → run boundary → turn.consumed.stale.
// ---------------------------------------------------------------------------

import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { afterAll } from "bun:test";
import { createSessionEntityRunTurn, type SessionKernel } from "../../../packages/agent/src/core/entity";
import { resolveSessionRuntime, type SessionRuntime } from "../../../packages/agent/src/core/run";
import type { SessionEntityPorts } from "../../../packages/agent/src/core/run";
import { openCatalogStore } from "../../../packages/agent/src/core/store/catalog";
import { openSessionStore } from "../../../packages/agent/src/core/store/session-file/index";
import * as FenceStore from "../../../packages/agent/src/core/store/fence";
import {
  clusterTempDir,
  runCluster,
  sendDeliver,
  sendPrompt,
  sessionFileFor,
} from "../../../packages/agent/test/helpers/cluster-runtime";
import { runAgent } from "../../../packages/agent/test/helpers/executor";
import { settleChild } from "../src/bundles/delegation-policy/index";

const cluster = clusterTempDir("stale-entity-deliver-");
afterAll(() => rmSync(cluster.dir, { recursive: true, force: true }));

function materializeEntitySession(kernel: SessionKernel, sessionId: string, at: number) {
  return kernel.materialize({
    id: sessionId,
    parentId: null,
    role: "resident",
    tools: [],
    system: { preset: "", blocks: [] },
    policyGeneration: 1,
    actionId: `${sessionId}:materialize`,
    at,
  });
}

test("H-3(a): a stale late-hook action through the REAL entity deliver door closes via turn.consumed.stale at the run boundary", async () => {
  const sessionId = "stale-entity";
  const file = sessionFileFor(cluster.sessionsDir, sessionId);
  const now = () => Date.now();
  // Provision BEFORE the cluster boots: materialize, seed policy rows, and
  // commit the EXECUTED compaction every later `after` cursor is measured
  // against (head > 1, so after:1 is stale by construction).
  await runAgent(
    Effect.gen(function* () {
      const catalog = openCatalogStore(cluster.catalogFile, { now });
      const store = openSessionStore(file, { now });
      const kernel = FenceStore.createSessionKernel(store, catalog);
      seedPolicy([], catalog.policies);
      yield* materializeEntitySession(kernel, sessionId, now());
      catalog.indexSession({ id: sessionId, parentId: null, role: "resident", createdAt: now() });
      // Rotate THROUGH the catalog so the entity's own activation rotation
      // (file fence CAS accepts only strictly newer) still wins later.
      const fence = catalog.rotateFence(sessionId);
      yield* kernel.adoptFence({ sessionId, owner: "provisioner", fence });
      yield* kernel.commit({
        sessionId,
        owner: "provisioner",
        fence,
        now: now(),
        expectedRevision: kernel.row(sessionId).revision,
        actions: [executedCompaction(sessionId, kernel.latestAction(sessionId)?.id ?? null, now())],
        state: kernel.row(sessionId).state,
      });
      expect(kernel.compactionHead(sessionId)).toBeGreaterThan(1);
      store.close();
      catalog.close();
    }),
  );
  // The committed-terminal barrier: the activation's OUTER commit transaction
  // is wrapped (wrapStore below); after each committed batch the wrapper reads
  // the file and resolves once the turn TERMINAL row is durable. A push on the
  // exact committed fact — no polling, no sleeps.
  const terminal = Promise.withResolvers<void>();
  const resolveOnTerminal = () => {
    const db = new Database(file, { readonly: true });
    try {
      const committed = db
        .query<{ id: string }, []>(
          "SELECT id FROM action WHERE kind = 'turn' AND json_extract(intent, '$.phase') = 'terminal' LIMIT 1",
        )
        .get();
      if (committed !== null) terminal.resolve();
    } finally {
      db.close();
    }
  };
  // The production turn port is built INSIDE the scoped program (it needs the
  // resolved session services); the entity reaches it through this cell.
  const port: { current?: SessionEntityPorts["runTurn"] } = {};
  const drained: string[][] = [];
  await runCluster(
    {
      sessionsDir: cluster.sessionsDir,
      catalogFile: cluster.catalogFile,
      inputRegistrations: ["prompt", "signal", "action"],
      capabilityKinds: ["tool", "compaction", "action"],
      wrapStore: (id, store) => {
        if (id !== sessionId) return store;
        const sessions: typeof store.sessions = {
          ...store.sessions,
          commit: (input) =>
            store.sessions.commit(input).pipe(Effect.tap(() => Effect.sync(resolveOnTerminal))),
        };
        // SessionStore is a class handle: proxy the one adapter, delegate the rest.
        return new Proxy(store, {
          get: (target, prop) => {
            if (prop === "sessions") return sessions;
            const value: typeof store[keyof typeof store] = Reflect.get(target, prop, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
      runTurnPort: (input) =>
        Effect.suspend(() => {
          const live = port.current;
          if (live === undefined) return Effect.die(new Error("turn port not installed"));
          return live(input);
        }),
    },
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const runner = staleBoundaryRunner(entered, release, drained);
      // A read-plane kernel per session over the SAME files the entity owns:
      // services (policy compiler, generation capture) read through it; every
      // turn COMMIT rides the activation's own kernel and fence.
      const catalog = openCatalogStore(cluster.catalogFile, { now });
      yield* Effect.addFinalizer(() => Effect.sync(() => catalog.close()));
      const kernels = new Map<string, SessionKernel>();
      const openKernel = (id: string): SessionKernel => {
        let kernel = kernels.get(id);
        if (kernel === undefined) {
          kernel = FenceStore.createSessionKernel(
            openSessionStore(sessionFileFor(cluster.sessionsDir, id), { now }),
            catalog,
          );
          kernels.set(id, kernel);
        }
        return kernel;
      };
      const runtime: SessionRuntime = {
        approvalPolicy: TEST_APPROVAL_POLICY,
        authorizeConfigure: allowConfigure,
        openKernel,
        listSessions: () => [],
        settleChild,
      };
      const fixture = {
        ...runtime,
        observations: { publish: () => undefined, subscribe: () => () => undefined },
      };
      const resolved = yield* withSessionServices(resolveSessionRuntime(runtime), fixture);
      port.current = createSessionEntityRunTurn(runner, resolved, scope);
      // Turn start through the entity's own deliver door.
      yield* sendPrompt(sessionId, "p-start", "start");
      yield* bounded(Deferred.await(entered));
      // Mid-turn, the late hook reply re-enters through deliver{kind:action}
      // with its CALL-time after cursor pointing BEFORE the compaction head.
      const receipt = yield* sendDeliver(sessionId, {
        kind: "action",
        idempotencyKey: "stale-action",
        content: "{}",
        delivery: "steer",
        after: 1,
        // The cursor rides the BODY only (#1256 r5 H-3): the committed row's
        // origin.after must come from the entity's body->intent merge, so a
        // regression there fails this test instead of hiding behind a copy.
        source: JSON.stringify({ kind: "hook.late" }),
      });
      expect(receipt.existed).toBe(false);
      yield* Deferred.succeed(release, undefined);
      yield* Effect.promise(() => terminal.promise).pipe(Effect.timeout("10 seconds"));
    }),
  );
  // The live boundary did NOT deliver the stale action...
  expect(drained[0]).toEqual([]);
  const db = new Database(file, { readonly: true });
  try {
    const actions = db
      .query<{ id: string; kind: string; intent: string }, []>(
        "SELECT id, kind, intent FROM action ORDER BY ordinal ASC",
      )
      .all();
    expect(actions.some((action) =>
      (JSON.parse(action.intent) as { deliveryId?: string }).deliveryId === "stale-action",
    )).toBe(false);
    // ...it closed durably via the turn chain's consumedStale list...
    expect(actions.filter((action) => action.kind === "turn").map((action) =>
      (JSON.parse(action.intent) as { consumedStale?: string[] }).consumedStale,
    )).toContainEqual(["stale-action"]);
  } finally {
    db.close();
  }
  // ...and the pending fold never surfaces it again.
  await runAgent(
    Effect.sync(() => {
      const catalog = openCatalogStore(cluster.catalogFile, { now });
      const store = openSessionStore(file, { now });
      const kernel = FenceStore.createSessionKernel(store, catalog);
      expect(kernel.pendingMessages(sessionId)).toEqual([]);
      store.close();
      catalog.close();
    }),
  );
});
