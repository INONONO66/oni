/**
 * A pre-fork idempotency key must complete a REAL child turn. The parent consumed input `msg-1` before the fork
 * anchor, so its chain holds the input row AND its deterministic delivery row `msg-1:delivery`; the fork remaps
 * BOTH into the `fork:<parent>:` namespace, so the child can re-admit `msg-1` and the turn re-mints `msg-1:delivery`
 * without colliding with the copied row. The only wait is an ObservationSink on the child terminal's committed event.
 */
import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { Effect } from "effect";
import { z } from "zod";
import { type BusEvent, L0Observation, type ObservationSink } from "@oni/protocol";
import { deliveryActions, receivedMessageAction } from "../../src/core/journal/delivery";
import { clusterTempDir, runCluster, sendPrompt, sessionFileFor, verifyChain } from "../helpers/cluster-runtime";
import { runAgent } from "../helpers/executor";
import { boundaryTerminal, forkAtAction, pendingPromptRow } from "../helpers/fork-seed";
import { fencedSession, withSessionHandles } from "../helpers/seeded-session";

const home = clusterTempDir("w52-fork-delivery-replay-");
const { dir, sessionsDir, catalogFile } = home;

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const PARENT_ID = "fork-replay-parent";
const CHILD_ID = "fork-replay-child";
const KEY = "msg-1";

const DeliveryEffect = z.looseObject({ phase: z.literal("delivery"), deliveryId: z.string() });
const TerminalEffect = z.looseObject({ phase: z.literal("terminal") });
const InputEffect = z.looseObject({ deliveryKind: z.string() });

test("a pre-fork key re-admits AND completes a real child turn; msg-1:delivery belongs to the child's new input", async () => {
  // Seed the parent: one consumed input (`msg-1` + its `msg-1:delivery`
  // record) sealed by the boundary terminal the fork anchors at.
  const seeded = await runAgent(
    Effect.scoped(
      Effect.gen(function* () {
        const parent = yield* fencedSession(home, PARENT_ID);
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
          [pendingPromptRow(PARENT_ID, KEY, "first", 2)],
          { kind: "turn", turnId: "turn-1" },
          "before_llm",
          input.id,
        );
        if (delivery === undefined) throw new Error("delivery action missing");
        yield* parent.commit([input, delivery, boundaryTerminal(PARENT_ID, delivery.id)], 3);
        const { receipt } = yield* forkAtAction(home, parent, { childId: CHILD_ID, anchorId: "turn-1:terminal" });
        return { receipt };
      }),
    ),
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
  const after = withSessionHandles(home, CHILD_ID, ({ kernel }) => {
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
  });
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
