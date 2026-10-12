/**
 * #1257 r6 H-1 — a pre-fork idempotency key must complete a REAL child turn.
 * The parent consumed input `msg-1` before the fork anchor, so its chain holds
 * the input row AND its deterministic delivery row `msg-1:delivery`
 * (core/commit.ts `deliveryActions`). The fork remaps BOTH into the
 * `fork:<parent>:` namespace; the child then re-admits the parent's old key
 * `msg-1` through the live entity's Deliver door and the turn runs to its
 * committed terminal — consumption re-mints `msg-1:delivery` for the child's
 * NEW input without colliding with the copied row.
 *
 * Determinism (#1254 pattern): the only wait is the committed-fact barrier —
 * an ObservationSink resolves on the child terminal's `ledger.action.committed`
 * event; the timeout is a failure guard, never a synchronizer.
 */
import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { Effect } from "effect";
import { z } from "zod";
import {
  type BusEvent,
  type Delivery,
  L0Observation,
  type ObservationSink,
} from "@openomni/protocol";
import { deliveryActions, receivedMessageAction, turnTerminalAction } from "../../src/core/commit";
import { forkSession } from "../../src/core/fork";
import { openCatalogStore } from "../../src/core/store/catalog";
import { openSessionStore, SESSION_FILE_SCHEMA_VERSION } from "../../src/core/store/session-file";
import * as SessionHandleStore from "../../src/core/store/fence";
import { clusterTempDir, runCluster, sendPrompt, sessionFileFor, verifyChain } from "../helpers/cluster-runtime";
import { runAgent } from "../helpers/executor";

const { dir, sessionsDir, catalogFile } = clusterTempDir("w52-fork-delivery-replay-");

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const PARENT_ID = "fork-replay-parent";
const CHILD_ID = "fork-replay-child";
const KEY = "msg-1";

const DeliveryEffect = z.looseObject({ phase: z.literal("delivery"), deliveryId: z.string() });
const TerminalEffect = z.looseObject({ phase: z.literal("terminal") });
const InputEffect = z.looseObject({ deliveryKind: z.string() });

function parentDeliveryRow(content: string, createdAt: number): Delivery.Row {
  return {
    id: KEY,
    sessionId: PARENT_ID,
    kind: "prompt",
    content,
    origin: { encodingVersion: 1, value: { source: "test" } },
    status: "pending",
    consumedBy: null,
    consumedAt: null,
    createdAt,
    ordinal: 1,
  };
}

test("a pre-fork key re-admits AND completes a real child turn; msg-1:delivery belongs to the child's new input", async () => {
  // Seed the parent: one consumed input (`msg-1` + its `msg-1:delivery`
  // record) sealed by the boundary terminal the fork anchors at.
  const seeded = await runAgent(
    Effect.gen(function* () {
      const catalog = openCatalogStore(catalogFile, { now: () => 1 });
      const store = openSessionStore(sessionFileFor(sessionsDir, PARENT_ID), { now: () => 1 });
      const kernel = SessionHandleStore.createSessionKernel(store, catalog);
      yield* kernel.materialize({
        id: PARENT_ID,
        parentId: null,
        role: "resident",
        tools: [],
        system: { preset: "", blocks: [] },
        policyGeneration: 1,
        actionId: `${PARENT_ID}:materialize`,
        at: 1,
      });
      catalog.indexSession({ id: PARENT_ID, parentId: null, role: "resident", createdAt: 1 });
      const fence = catalog.rotateFence(PARENT_ID);
      yield* kernel.adoptFence({ sessionId: PARENT_ID, owner: "seeder", fence });
      const row = kernel.row(PARENT_ID);
      const input = receivedMessageAction({
        id: KEY,
        sessionId: PARENT_ID,
        kind: "prompt",
        content: "first",
        origin: { encodingVersion: 1, value: { source: "test" } },
        parentActionId: `${PARENT_ID}:materialize`,
        at: 2,
      });
      const [delivery] = deliveryActions(
        [parentDeliveryRow("first", 2)],
        { kind: "turn", turnId: "turn-1" },
        "before_llm",
        input.id,
      );
      if (delivery === undefined) throw new Error("delivery action missing");
      const terminal = turnTerminalAction({
        id: "turn-1:terminal",
        parentId: delivery.id,
        sessionId: PARENT_ID,
        turnId: "turn-1",
        result: { kind: "result", text: "done" },
        resumeCount: 0,
        boundaryActionId: null,
        at: 3,
      });
      yield* kernel.commit({
        sessionId: PARENT_ID,
        owner: "seeder",
        fence,
        now: 3,
        expectedRevision: row.revision,
        actions: [input, delivery, terminal],
        state: row.state,
      });
      const anchor = kernel
        .historyPage(PARENT_ID, { afterRevision: 0, limit: 50 })
        .actions.find((action) => action.id === "turn-1:terminal");
      if (anchor === undefined) throw new Error("terminal anchor missing");
      const child = openSessionStore(sessionFileFor(sessionsDir, CHILD_ID), { now: () => 1 });
      const receipt = yield* forkSession(
        {
          parent: kernel,
          parentSchemaVersion: SESSION_FILE_SCHEMA_VERSION,
          openChild: () => child,
          catalog,
        },
        {
          from: PARENT_ID,
          at: anchor.actionHash,
          childId: CHILD_ID,
          genesisActionId: `${CHILD_ID}:genesis`,
          now: 10,
        },
      );
      child.close();
      store.close();
      catalog.close();
      return { receipt };
    }),
  );
  expect(seeded.receipt.forkedFrom.copied).toBe(4);

  // Committed-fact barrier: the test cluster's turn port seals the child's
  // turn as `<key>:turn:result`; resolve on exactly that committed row.
  const childTerminalId = `${KEY}:turn:result`;
  let resolveTerminal: () => void = () => undefined;
  const terminalCommitted = new Promise<void>((resolve) => {
    resolveTerminal = resolve;
  });
  const sink: ObservationSink = {
    publish<T>(event: BusEvent.Descriptor<T>, data: T): void {
      if (event.name !== L0Observation.ActionCommittedEvent.name) return;
      const committed = L0Observation.ActionCommitted.parse(data);
      if (committed.sessionId === CHILD_ID && committed.id === childTerminalId) resolveTerminal();
    },
  };

  // Real plane: the parent's old key goes through the live Deliver door.
  const receipt = await runCluster(
    { sessionsDir, catalogFile, observationSink: sink },
    Effect.gen(function* () {
      const delivered = yield* sendPrompt(CHILD_ID, KEY, "replayed");
      yield* Effect.promise(() => terminalCommitted).pipe(Effect.timeout("15 seconds"), Effect.orDie);
      return delivered;
    }),
  );
  // Admission was fresh, never an idempotent replay of the copied parent row.
  expect(receipt.existed).toBeFalse();

  // Durable facts: the copied rows live in the fork namespace; the parent's
  // old key now names the child's OWN input, delivery and sealed turn.
  const after = await runAgent(
    Effect.sync(() => {
      const catalog = openCatalogStore(catalogFile, { now: () => 1 });
      const childStore = openSessionStore(sessionFileFor(sessionsDir, CHILD_ID), { now: () => 1 });
      try {
        const kernel = SessionHandleStore.createSessionKernel(childStore, catalog);
        const byId = (id: string) => kernel.actionById(id);
        return {
          state: kernel.row(CHILD_ID).state,
          copiedInput: byId(`fork:${PARENT_ID}:${KEY}`),
          copiedDelivery: byId(`fork:${PARENT_ID}:${KEY}:delivery`),
          newInput: byId(KEY),
          newDelivery: byId(`${KEY}:delivery`),
          terminal: byId(childTerminalId),
          chainLength: verifyChain(sessionFileFor(sessionsDir, CHILD_ID), CHILD_ID),
        };
      } finally {
        childStore.close();
        catalog.close();
      }
    }),
  );
  // The turn completed: a committed terminal, and the session settled idle.
  expect(after.terminal?.kind).toBe("turn");
  expect(TerminalEffect.safeParse(after.terminal?.effect.value).success).toBeTrue();
  expect(after.state).toBe("idle");
  // `msg-1:delivery` belongs to the child's new input...
  expect(DeliveryEffect.parse(after.newDelivery?.effect.value).deliveryId).toBe(KEY);
  expect(InputEffect.parse(after.newInput?.effect.value).deliveryKind).toBe("prompt");
  // ...with the copied one at its remapped id, its input link remapped too.
  expect(DeliveryEffect.parse(after.copiedDelivery?.effect.value).deliveryId).toBe(
    `fork:${PARENT_ID}:${KEY}`,
  );
  expect(after.copiedInput?.sessionId).toBe(CHILD_ID);
  // The full child chain (copies + replayed turn) re-verifies hash by hash.
  expect(after.chainLength).toBeGreaterThanOrEqual(8);
}, 30_000);
