/**
 * #1253 boundary consumption rule: control signals drain at every boundary,
 * `steer` rows at tool.post boundaries and turn end, `followUp` rows only at
 * turn end, with per-mode `all|one` widths read from the latest
 * `session.configure` row's `settings` — data, not code.
 */
import { describe, expect, test } from "bun:test";
import { Deferred, Effect, Fiber } from "effect";
import type { Delivery, LedgerAction } from "@openomni/protocol";
import {
  DEFAULT_CONSUMPTION,
  boundaryConsumption,
  consumptionSettings,
} from "../src/core/commit";
import { configureAction } from "../src/core/store/fence";
import type { SessionRunner } from "../src/core/run";
import { session } from "../src/testing/registry";
import { isolated, isolatedLedger } from "./helpers/isolated";
import { queuePromptOnS } from "./helpers/ingress";
import { seedPolicy } from "./helpers/seed-policy";
import { sessionTree } from "./helpers/session-tree";
import { boundedBy2s, silentRuntime, withSessionServices, type SessionFixture } from "./helpers/session-services";

function deliveryRow(input: {
  readonly ordinal: number;
  readonly kind: Delivery.Kind;
  readonly delivery?: "steer" | "followUp";
}): Delivery.Row {
  return {
    id: `I${input.ordinal}`,
    sessionId: "S",
    kind: input.kind,
    content: input.kind,
    ordinal: input.ordinal,
    createdAt: input.ordinal,
    status: "pending",
    consumedBy: null,
    consumedAt: null,
    origin: { encodingVersion: 1, value: {} },
    ...(input.delivery === undefined ? {} : { delivery: input.delivery }),
  };
}

describe("boundaryConsumption rule", () => {
  const backlog: Delivery.Row[] = [
    deliveryRow({ ordinal: 1, kind: "interrupt" }),
    deliveryRow({ ordinal: 2, kind: "prompt", delivery: "steer" }),
    deliveryRow({ ordinal: 3, kind: "prompt", delivery: "steer" }),
    deliveryRow({ ordinal: 4, kind: "prompt" }),
    deliveryRow({ ordinal: 5, kind: "prompt", delivery: "followUp" }),
  ];
  const ids = (rows: readonly Delivery.Row[]) => rows.map((row) => row.id);

  test("controls drain at every boundary; steer and followUp wait for their consumption points", () => {
    expect(ids(boundaryConsumption(backlog, "before_llm", DEFAULT_CONSUMPTION, 0).consumed)).toEqual(["I1"]);
    expect(ids(boundaryConsumption(backlog, "after_llm", DEFAULT_CONSUMPTION, 0).consumed)).toEqual(["I1"]);
    expect(ids(boundaryConsumption(backlog, "after_tools", DEFAULT_CONSUMPTION, 0).consumed)).toEqual([
      "I1",
      "I2",
      "I3",
    ]);
    expect(ids(boundaryConsumption(backlog, "turn_end", DEFAULT_CONSUMPTION, 0).consumed)).toEqual([
      "I1",
      "I2",
      "I3",
      "I4",
      "I5",
    ]);
  });

  test("width one caps each delivery mode independently in backlog order", () => {
    expect(
      ids(boundaryConsumption(backlog, "after_tools", { steering: "one", followUp: "one" }, 0).consumed),
    ).toEqual(["I1", "I2"]);
    expect(
      ids(boundaryConsumption(backlog, "turn_end", { steering: "one", followUp: "one" }, 0).consumed),
    ).toEqual(["I1", "I2", "I4"]);
    expect(
      ids(boundaryConsumption(backlog, "turn_end", { steering: "all", followUp: "one" }, 0).consumed),
    ).toEqual(["I1", "I2", "I3", "I4"]);
  });

  test("a row without a delivery mark folds to followUp", () => {
    expect(ids(boundaryConsumption([deliveryRow({ ordinal: 9, kind: "prompt" })], "after_tools", DEFAULT_CONSUMPTION, 0).consumed)).toEqual([]);
    expect(ids(boundaryConsumption([deliveryRow({ ordinal: 9, kind: "prompt" })], "turn_end", DEFAULT_CONSUMPTION, 0).consumed)).toEqual(["I9"]);
  });
});

// ---------------------------------------------------------------------------
// Integrated: a real session turn obeys the rule and records turn.consumed.
// ---------------------------------------------------------------------------

const bounded = boundedBy2s;

const fixture = () => silentRuntime("bc", "bc");

function declare(runtime: SessionFixture, runner: SessionRunner) {
  return withSessionServices(session({ id: "S", role: "resident", runner }, runtime), runtime);
}

/** Commit a `session.configure` row pinning the consumption widths. */
function commitSettings(
  settings: { steering: "all" | "one"; followUp: "all" | "one" },
  id = "configure-settings",
) {
  return Effect.suspend(() => {
    const kernel = isolatedLedger().kernel;
    const current = kernel.row("S");
    const snapshot = kernel.latestGenerationFor("S");
    return kernel.commit({
      sessionId: "S",
      owner: current.fenceOwner ?? "settings",
      fence: current.fence,
      now: 10,
      expectedRevision: current.revision,
      actions: [
        configureAction({
          id,
          sessionId: "S",
          parentId: kernel.latestAction("S")?.id ?? null,
          operation: "tools.add",
          snapshot,
          settings,
          at: 10,
        }),
      ],
      state: current.state,
    });
  });
}

const queue = (ordinal: number, content: string, delivery: "steer" | "followUp") =>
  queuePromptOnS(isolatedLedger().kernel, ordinal, content, delivery);

describe("integrated boundary consumption", () => {
  test("consumptionSettings folds the latest configure settings row", () =>
    isolated(
      Effect.gen(function* () {
        seedPolicy();
        const runtime = fixture();
        yield* declare(runtime, () => Effect.succeed({ kind: "result", text: "done" }));
        expect(consumptionSettings(isolatedLedger().kernel, "S")).toEqual(DEFAULT_CONSUMPTION);
        yield* commitSettings({ steering: "one", followUp: "one" });
        expect(consumptionSettings(isolatedLedger().kernel, "S")).toEqual({
          steering: "one",
          followUp: "one",
        });
        // The fold pages in 256-action windows: a settings row committed past
        // the first window still wins over every earlier one.
        yield* Effect.forEach(
          Array.from({ length: 256 }, (_, index) => index),
          (index) => commitSettings({ steering: "all", followUp: "all" }, `configure-page-${index}`),
          { discard: true },
        );
        yield* commitSettings({ steering: "one", followUp: "all" }, "configure-final");
        expect(consumptionSettings(isolatedLedger().kernel, "S")).toEqual({
          steering: "one",
          followUp: "all",
        });
      }),
    ));

  test("width one drains one steer row at tool.post and records it in turn.consumed", () =>
    isolated(
      Effect.gen(function* () {
        seedPolicy();
        const runtime = fixture();
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const drained: string[][] = [];
        const handle = yield* declare(runtime, (input) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            const batch = yield* input.boundary("after_tools");
            drained.push(batch.messages.map((message) => message.text));
            return { kind: "result", text: "done" };
          }),
        );
        yield* commitSettings({ steering: "one", followUp: "one" });
        const running = yield* Effect.forkScoped(handle.prompt("start"));
        yield* bounded(Deferred.await(entered));
        yield* queue(0, "steer-a", "steer");
        yield* queue(1, "steer-b", "steer");
        yield* queue(2, "follow-c", "followUp");
        yield* Deferred.succeed(release, undefined);
        yield* bounded(Fiber.join(running));
        // Width one: the after_tools boundary drained exactly the first steer
        // row; turn end then consumed one steer and one followUp per turn
        // until the backlog emptied.
        expect(drained[0]).toEqual(["steer-a"]);
        expect(isolatedLedger().kernel.pendingMessages("S")).toEqual([]);
        const actions = sessionTree(isolatedLedger().kernel, "S");
        const checkpointConsumed = actions
          .filter(
            (action: LedgerAction.Node) =>
              action.kind === "turn" &&
              (action.intent.value as { phase?: string }).phase === "checkpoint",
          )
          .map((action) => (action.intent.value as { deliveryIds?: string[] }).deliveryIds);
        // Every checkpoint records its consumed seqs: the first turn's
        // tool.post boundary consumed queued-0.
        expect(checkpointConsumed[0]).toEqual(["queued-0"]);
        // All queued rows were delivered exactly once, in order.
        const deliveries = actions.filter(
          (action: LedgerAction.Node) =>
            action.kind === "prompt" &&
            (action.effect.value as { phase?: string } | null)?.phase === "delivery" &&
            String((action.intent.value as { deliveryId?: string }).deliveryId).startsWith("queued-"),
        );
        expect(deliveries.map((action) => (action.intent.value as { deliveryId: string }).deliveryId)).toEqual([
          "queued-0",
          "queued-1",
          "queued-2",
        ]);
      }),
    ));
});
