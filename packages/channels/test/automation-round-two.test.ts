import { beforeEach, expect, test } from "bun:test";
import { Deferred, Effect, Fiber } from "effect";
import { Ingress } from "@oni/protocol";
import { ChannelsFailure } from "../src/errors.js";
import { ledger } from "./helpers/ledger.js";
import { runEffect } from "./helpers/effect.js";
import { commits, makeRouter, ownerFacts, ownerSender, registerOwnerDm, resetRouterState, routingDecisions } from "./router/_router-fixture.js";

beforeEach(() => {
  resetRouterState();
  registerOwnerDm();
});

const facts = { ...ownerFacts, dm: false };
const inboundId = "discord:owner-workspace:owner-dm:inbound-owner-dm";

function add(record: Partial<Ingress.Automation> = {}) {
  ledger().stores.automations.add(Ingress.Automation.parse({
    id: "trigger", name: "Trigger", enabled: true, createdBy: "owner",
    triggers: [{ type: "message", surface: facts.surface, event: "message" }],
    target: "session:worker", ...record,
  }));
}

test.each(["failure", "defect"] as const)("a group dispatch %s closes once without blocking unrelated ingress or later groups", async (mode) => {
  add({ conditions: { contains: ["broken"] }, grouping: { by: "channel", windowSeconds: 10 } });
  add({ id: "healthy", target: "session:healthy", conditions: { contains: ["healthy"] },
    grouping: { by: "channel", windowSeconds: 10 } });
  const clock = { now: 0 };
  let failures = 0;
  const router = makeRouter({
    now: () => clock.now,
    prepare: (_sender, _send, target) => {
      if (target === "worker") {
        failures++;
        const failure = new ChannelsFailure({ operation: "prepare", cause: "broken target" });
        return mode === "failure" ? Effect.fail(failure) : Effect.die(failure);
      }
      return Effect.succeed({ target, message: { sender: "external", eventIdUnique: true } });
    },
  });
  await runEffect(router.ingest(ownerSender, { ...facts, render: "broken" }));
  await runEffect(router.ingest(ownerSender, { ...facts, eventId: "healthy", render: "healthy" }));
  clock.now = 10_000;
  expect(await runEffect(router.ingest(ownerSender, { ...ownerFacts, eventId: "unrelated" })))
    .toMatchObject({ status: "executed" });
  await runEffect(router.advance());
  expect(ledger().stores.automations.groups()).toEqual([]);
  expect(commits).toHaveLength(2);
  expect(commits.some((row) => row.sessionId === "healthy")).toBe(true);
  expect(commits.some((row) => row.sessionId === "worker")).toBe(false);
  expect(ledger().stores.automations.decisions(inboundId)).toEqual([
    expect.objectContaining({ decision: "grouped" }),
    expect.objectContaining({ decision: "refused", reason: expect.stringContaining("broken target") }),
  ]);
  await runEffect(router.advance(20_000));
  expect(failures).toBe(1);
});

test("interrupted group closure remains recoverable rather than recording a refusal", async () => {
  add({ grouping: { by: "channel", windowSeconds: 10 } });
  await runEffect(makeRouter({ now: () => 0 }).ingest(ownerSender, facts));
  await runEffect(Effect.scoped(Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const router = makeRouter({
      prepare: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
    });
    const closing = yield* router.advance(10_000).pipe(Effect.forkScoped);
    yield* Deferred.await(started);
    yield* Fiber.interrupt(closing);
    expect(ledger().stores.automations.groups()).toHaveLength(1);
    expect(ledger().stores.automations.decisions(inboundId)).toEqual([
      expect.objectContaining({ decision: "grouped", reason: "grouped" }),
    ]);
  })));
  await runEffect(makeRouter().advance(10_000));
  expect(commits).toHaveLength(1);
  expect(ledger().stores.automations.decisions(inboundId).at(-1)).toMatchObject({ decision: "matched" });
});

test("clock-only closure keeps full and expired windows separate without losing members", async () => {
  add({ target: "new", grouping: { by: "channel", windowSeconds: 10 } });
  const clock = { now: 0 };
  const router = makeRouter({ now: () => clock.now });
  for (let index = 0; index < 65; index++)
    await runEffect(router.ingest(ownerSender, { ...facts, eventId: `burst-${index}` }));
  clock.now = 10_000;
  await runEffect(router.ingest(ownerSender, { ...facts, eventId: "next-window" }));
  expect(commits).toEqual([]);
  expect(ledger().stores.automations.groups().map((group) => group.pending.inputs.length).sort((a, b) => a - b))
    .toEqual([1, 1, 64]);
  await runEffect(router.advance());
  expect(commits).toHaveLength(2);
  expect(ledger().stores.automations.groups()).toHaveLength(1);
  await runEffect(router.advance(20_000));
  expect(commits).toHaveLength(3);
  const bodies = commits.map((row) => Ingress.TriggerContext.parse(JSON.parse(row.content)));
  expect(bodies.flatMap((body) => body.event.messages)).toHaveLength(66);
  expect(new Set(commits.map((row) => row.sessionId)).size).toBe(3);
});

test("fired group members retain durable close decisions and the firing row pointer", async () => {
  add({ grouping: { by: "channel", windowSeconds: 10 } });
  const router = makeRouter({ now: () => 0 });
  await runEffect(router.ingest(ownerSender, facts));
  await runEffect(router.ingest(ownerSender, { ...facts, eventId: "second" }));
  await runEffect(router.advance(10_000));
  const firing = commits[0];
  if (firing === undefined) throw new Error("group did not fire");
  const store = ledger().stores.automations;
  const first = store.decisions(inboundId);
  const second = store.decisions("discord:owner-workspace:owner-dm:second");
  expect(first).toEqual([
    expect.objectContaining({ decision: "grouped", reason: "grouped" }),
    expect.objectContaining({ decision: "grouped", reason: `firing:${firing.id}` }),
  ]);
  expect(second).toEqual([
    expect.objectContaining({ decision: "grouped" }),
    expect.objectContaining({ decision: "matched", target: "session:worker" }),
  ]);
  expect(routingDecisions().filter((row) => row.stage === "automation")).toHaveLength(4);
  await runEffect(router.advance(20_000));
  await runEffect(router.ingest(ownerSender, facts));
  expect(store.decisions(inboundId)).toEqual(first);
  expect(store.decisions("discord:owner-workspace:owner-dm:second")).toEqual(second);
  expect(store.matchedToday("trigger", 20_000)).toBe(1);
});
