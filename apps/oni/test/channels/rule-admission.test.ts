import { beforeEach, expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Delivery, type Gateway, Ingress } from "@oni/protocol";
import { ledger, resetLedger } from "./helpers/ledger.js";
import { openRequest } from "./helpers/requests.js";
import { runEffect } from "../../../../packages/channels/test/helpers/effect.js";
import { commits, makeRouter, ownerFacts, ownerSender, registerOwnerDm, resetRouterState, routingDecisions } from "./router/_router-fixture.js";

beforeEach(resetRouterState);

function trigger(extras: Partial<Ingress.Rule> = {}) {
  ledger().stores.rules.add(Ingress.Rule.parse({
    id: "admission", position: 0, enabled: true, createdBy: "owner",
    when: { instance: "discord" },
    outcome: { kind: "deliver", target: "session:worker", deliveryKind: "action", reply: "none" }, ...extras,
  }), true);
}
const facts = { ...ownerFacts, dm: false, reply: { chain: [], threadId: "root" } };
const id = "discord:owner-workspace:owner-dm:inbound-owner-dm";

test.each([0, 10] as const)("blocked routing cannot enter a %s-second automation", async (windowSeconds) => {
  trigger({ enabled: false, group: { by: "thread", windowSeconds } });
  const router = makeRouter();
  expect(await runEffect(router.ingest(ownerSender, facts))).toMatchObject({ status: "blocked_pre" });
  await runEffect(router.advance(10_001));
  expect(commits).toEqual([]);
  expect(ledger().stores.rules.decisions(id)).toEqual([expect.objectContaining({ by: "rule/none" })]);
  expect(ledger().stores.rules.groups()).toEqual([]);
  expect(ledger().stores.rules.matchedToday("admission", 10_001)).toBe(0);
});

test.each(["matched", "filtered", "refused", "grouped"] as const)(
  "%s replay preserves original facts and records delivered duplicates", async (decision) => {
    registerOwnerDm();
    trigger(decision === "filtered" ? { when: { instance: "other" } }
      : decision === "refused" ? { outcome: { kind: "deliver", target: "session:worker", deliveryKind: "action", reply: "none", maxRunsPerDay: 1 } }
      : decision === "grouped" ? { group: { by: "thread", windowSeconds: 10 } } : {});
    if (decision === "refused") {
      ledger().stores.rules.record(Ingress.Events.RoutingDecision.schema.parse({
        traceId: "seed", time: 0, inboundId: "seed", surface: "discord", mode: "direct",
        stage: "automation", outcome: "record", decision: "matched", by: "rule/admission",
        reason: "matched", factsUsed: [], factsDigest: "seed",
      }));
    }
    const router = makeRouter();
    const event = facts;
    const original = await runEffect(router.ingest(ownerSender, event));
    const originalRows = ledger().stores.rules.decisions(id);
    expect(originalRows).toEqual([expect.objectContaining({ decision })]);
    if (decision === "grouped") await runEffect(router.advance(10_001));
    const rows = ledger().stores.rules.decisions(id);
    expect(rows[0]).toEqual(originalRows[0]);
    expect(rows).toHaveLength(decision === "grouped" ? 2 : 1);
    const before = commits.length;
    const replay = await runEffect(router.ingest(ownerSender, event));
    if (original.status === "blocked_pre") expect(replay).toEqual(original);
    else expect(replay).toMatchObject({
      reasonCode: decision === "filtered" ? "filtered"
        : decision === "refused" ? "limit" : "message.external.event_id_dedupe",
    });
    expect(commits).toHaveLength(before);
    const expected = decision === "matched"
      ? [...rows, expect.objectContaining({ decision: "deduped", inboundId: id, reason: "event_id_dedupe" })]
      : rows;
    expect(ledger().stores.rules.decisions(id)).toEqual(expected);
    expect(routingDecisions().filter((row) => row.stage === "automation" && row.inboundId === id))
      .toEqual(expected);
  },
);

test.each(["action", "prompt"] as const)("a restored %s group uses gated dispatch and aggregated content", async (kind) => {
  registerOwnerDm();
  trigger({ outcome: { kind: "deliver", target: "session:worker", deliveryKind: kind, reply: "none" }, group: { by: "thread", windowSeconds: 10 } });
  const router = makeRouter({ now: () => 0 });
  await runEffect(router.ingest(ownerSender, facts));
  await runEffect(router.ingest(ownerSender, { ...facts, eventId: "second", render: "second body" }));
  expect(ledger().stores.rules.decisions(id)).toEqual([expect.objectContaining({ decision: "grouped" })]);
  const observations: Gateway.MessageObservation[] = [];
  await runEffect(makeRouter({ observe: (_sender, observation) => observations.push(observation) }).advance(10_000));
  expect(commits).toHaveLength(1);
  expect(commits[0]?.kind).toBe(kind);
  expect(Delivery.text(commits[0]?.content ?? [])).toContain("hello resident");
  expect(Delivery.text(commits[0]?.content ?? [])).toContain("second body");
  expect(observations.map((observation) => observation.kind))
    .toEqual(["message.sent", "message.admitted", "message.committed"]);
  expect(ledger().stores.rules.groups()).toEqual([]);
  expect(ledger().stores.rules.decisions(id)).toEqual([
    expect.objectContaining({ decision: "grouped" }),
    expect.objectContaining({ decision: "grouped", reason: `firing:${commits[0]?.id}` }),
  ]);
  expect(ledger().stores.rules.decisions("discord:owner-workspace:owner-dm:second")).toEqual([
    expect.objectContaining({ decision: "grouped" }),
    expect.objectContaining({ decision: "matched" }),
  ]);
});

test.each([0, 10] as const)("the event-id gate refuses %s-second automation delivery", async (windowSeconds) => {
  registerOwnerDm();
  trigger({ group: { by: "thread", windowSeconds } });
  const observations: Gateway.MessageObservation[] = [];
  const router = makeRouter({
    now: () => 0,
    prepare: (_sender, _send, target) => Effect.succeed({
      target, message: { sender: "external", eventIdUnique: false },
    }),
    observe: (_sender, observation) => observations.push(observation),
  });
  await runEffect(router.ingest(ownerSender, facts));
  await runEffect(router.advance(10_000));
  expect(commits).toEqual([]);
  expect(observations).toContainEqual(expect.objectContaining({
    kind: "message.rejected", matchedRuleIds: ["message.external.event_id_dedupe"],
  }));
  if (windowSeconds === 10) expect(ledger().stores.rules.decisions(id)).toEqual([
    expect.objectContaining({ decision: "grouped" }),
    expect.objectContaining({ decision: "refused", reason: "message.external.event_id_dedupe" }),
  ]);
});

test("revoked admission cannot be revived by closing an existing group", async () => {
  registerOwnerDm();
  trigger({ group: { by: "thread", windowSeconds: 10 } });
  const router = makeRouter({ now: () => 0 });
  await runEffect(router.ingest(ownerSender, facts));
  ledger().stores.rules.disable("admission");
  await runEffect(router.advance(10_000));
  expect(commits).toEqual([]);
  expect(ledger().stores.rules.groups()).toEqual([]);
});

test("a grouped new target and all members survive closing and reopening SQLite", async () => {
  const directory = mkdtempSync(join(tmpdir(), "automation-restart-"));
  const paths = { catalog: join(directory, "catalog.sqlite"), sessions: join(directory, "session.sqlite") };
  resetLedger(paths);
  try {
    registerOwnerDm();
    trigger({ outcome: { kind: "deliver", target: "new", deliveryKind: "action", reply: "none" }, group: { by: "thread", windowSeconds: 10 } });
    const router = makeRouter({ now: () => 0 });
    await runEffect(router.ingest(ownerSender, facts));
    const target = ledger().stores.rules.groups()[0]?.target;
    if (target === undefined) throw new Error("group target was not persisted");
    await runEffect(router.ingest(ownerSender, { ...facts, eventId: "second" }));
    resetLedger(paths);
    const resumed = makeRouter({ now: () => 10_000 });
    await runEffect(resumed.advance());
    expect(commits).toHaveLength(1);
    expect(`session:${commits[0]?.sessionId}`).toBe(target);
    expect(JSON.parse(Delivery.text(commits[0]?.content ?? [])).event.messages).toHaveLength(2);
    expect(ledger().stores.rules.matchedToday("admission", 10_000)).toBe(1);
    await runEffect(resumed.ingest(ownerSender, facts));
    expect(ledger().stores.rules.decisions(id)).toEqual([
      expect.objectContaining({ decision: "grouped" }),
      expect.objectContaining({ decision: "grouped", reason: `firing:${commits[0]?.id}` }),
    ]);
    expect(commits).toHaveLength(1);
  } finally {
    resetLedger();
    rmSync(directory, { recursive: true, force: true });
  }
});

test.each(["disabled", "removed", "limited"] as const)("a %s group closes without session delivery", async (state) => {
  registerOwnerDm();
  trigger({ group: { by: "thread", windowSeconds: 10 } });
  const router = makeRouter({ now: () => 0 });
  await runEffect(router.ingest(ownerSender, facts));
  const store = ledger().stores.rules;
  if (state === "disabled") store.disable("admission");
  else if (state === "removed") store.remove("admission");
  else {
    trigger({ group: { by: "thread", windowSeconds: 10 }, outcome: { kind: "deliver", target: "session:worker", deliveryKind: "action", reply: "none", maxRunsPerDay: 1 } });
    store.record(Ingress.Events.RoutingDecision.schema.parse({
      traceId: "seed", time: 0, inboundId: "seed", surface: "discord", mode: "direct",
      stage: "automation", outcome: "record", decision: "matched", by: "rule/admission",
      reason: "matched", factsUsed: [], factsDigest: "seed",
    }));
  }
  await runEffect(router.advance(10_000));
  expect(commits).toEqual([]);
  expect(store.groups()).toEqual([]);
  expect(store.decisions(id)).toEqual([
    expect.objectContaining({ decision: "grouped", reason: "grouped" }),
    expect.objectContaining({
      decision: state === "limited" ? "refused" : "filtered",
      reason: state === "limited" ? "limit" : state,
    }),
  ]);
});

test("a request created after group cannot acquire the held event", async () => {
  registerOwnerDm();
  trigger({ group: { by: "thread", windowSeconds: 10 } });
  const router = makeRouter({ now: () => 0 });
  await runEffect(router.ingest(ownerSender, { ...facts, reply: { chain: [], tokenHash: "late" } }));
  await runEffect(await openRequest("late", {
    expectedResponders: ["actor-owner"],
    correlation: { channelId: ownerFacts.channelId, tokenHash: "late" },
  }));
  await runEffect(router.advance(10_000));
  expect(commits).toEqual([]);
  expect(ledger().kernel.requestById("late")?.state).toBe("open");
  expect(ledger().stores.rules.decisions(id)).toEqual([
    expect.objectContaining({ decision: "grouped" }),
    expect.objectContaining({ decision: "refused", reason: "request_correlation" }),
  ]);
});

test.each([0, 10] as const)("egress denial also governs %s-second automation delivery", async (windowSeconds) => {
  registerOwnerDm();
  trigger({ group: { by: "thread", windowSeconds } });
  const router = makeRouter({
    now: () => 0,
    messaging: { grants: () => [], deliveryRoutes: new Map(), budgets: () => [{
      id: "budget", targetActorId: "actor-owner", doNotContact: true, maxPerWindow: 1, windowMs: 60_000, cooldownMs: 0,
    }] },
  });
  const result = await runEffect(router.ingest(ownerSender, facts));
  if (windowSeconds === 0) expect(result).toMatchObject({ reasonCode: "message.external.egress_budget" });
  await runEffect(router.advance(10_000));
  expect(commits).toEqual([]);
  if (windowSeconds === 10) expect(ledger().stores.rules.decisions(id)).toEqual([
    expect.objectContaining({ decision: "grouped" }),
    expect.objectContaining({ decision: "refused", reason: "message.external.egress_budget" }),
  ]);
});

test.each([
  ["an unregistered sender", false, "evidence_only"],
  ["the registered owner", true, "full_access"],
] as const)("a rule admits %s's message without lending it authority", async (_label, registered, treatment) => {
  if (registered) registerOwnerDm();
  trigger({ outcome: { kind: "deliver", target: "session:worker", deliveryKind: "prompt", reply: "none" } });
  const router = makeRouter();
  expect(await runEffect(router.ingest(ownerSender, facts))).toMatchObject({ status: "executed" });
  expect(routingDecisions().filter((row) => row.inboundId === id && row.stage === "surface_default")).toEqual([
    expect.objectContaining({ outcome: "route", sessionId: "worker",
      ...(registered ? { trustTier: "owner" } : { inboundTreatment: "evidence_only" }) }),
  ]);
  expect(commits).toHaveLength(1);
  expect(commits[0]?.origin.value).toMatchObject({ inboundTreatment: treatment });
});
