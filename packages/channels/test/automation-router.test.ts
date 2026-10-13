import { beforeEach, expect, test } from "bun:test";
import { Ingress } from "@openomni/protocol";
import { ledger } from "./helpers/ledger.js";
import { runEffect } from "./helpers/effect.js";
import { commits, createMappedOwnerSession, makeRouter, ownerFacts, ownerSender, registerOwnerDm, resetRouterState, routingDecisions } from "./router/_router-fixture.js";

beforeEach(resetRouterState);

function addTrigger(id: string, extras: Partial<Ingress.Automation> = {}) {
  ledger().stores.automations.add(Ingress.Automation.parse({
    id, name: id, enabled: true, createdBy: "owner",
    triggers: [{ type: "message", surface: ownerFacts.surface, event: "message" }],
    conditions: { contains: ["hello"] }, target: "session:worker", kind: "action",
    ...extras,
  }));
}

test.each(["matched", "missing", "disabled", "unapproved"] as const)(
  "an ungranted channel routes only a matched approved record: %s", async (state) => {
    const stores = ledger().stores;
    stores.actors.registerIdentity({ id: "observer", kind: "human", trustTier: "observer" });
    stores.actors.registerEndpoint({
      id: "observer-endpoint", actorId: "observer", channel: ownerSender.surface,
      externalId: ownerSender.externalId, workspace: ownerFacts.workspaceId,
    });
    if (state !== "missing") addTrigger("ungranted", {
      enabled: state === "matched",
      createdBy: state === "unapproved" ? "session:proposer" : "owner",
    });
    const router = makeRouter();
    const result = await runEffect(router.ingest(ownerSender, ownerFacts));
    if (state === "matched") {
      expect(result).toMatchObject({ status: "executed", handle: { target: "worker" } });
      expect(commits).toHaveLength(1);
      expect(routingDecisions()).toContainEqual(expect.objectContaining({
        outcome: "route", factsUsed: expect.arrayContaining(["automation:ungranted"]),
      }));
      expect(await runEffect(router.ingest(ownerSender, ownerFacts)))
        .toMatchObject({ status: "blocked_pre", reasonCode: "message.external.event_id_dedupe" });
      expect(commits).toHaveLength(1);
    } else {
      expect(result).toMatchObject({ status: "blocked_pre", reasonCode: "message.external.grant_tier" });
      expect(commits).toHaveLength(0);
      expect(routingDecisions()).toContainEqual(expect.objectContaining({
        outcome: "block", stage: "channel_ceiling",
      }));
    }
  },
);

test("a granted direct surface keeps the pre-migration session target", async () => {
  registerOwnerDm();
  const legacy = createMappedOwnerSession();
  const first = await runEffect(makeRouter().ingest(ownerSender, ownerFacts));
  expect(first).toMatchObject({ status: "executed", handle: { target: legacy.id } });
  expect(ledger().stores.automations.list()).toEqual([
    expect.objectContaining({ record: expect.objectContaining({
      kind: "prompt", target: `session:${legacy.id}`,
    }) }),
  ]);
});

test("new granted direct traffic uses one migrated prompt record and preserves its session", async () => {
  registerOwnerDm();
  const router = makeRouter();
  const first = await runEffect(router.ingest(ownerSender, ownerFacts));
  const second = await runEffect(router.ingest(ownerSender, { ...ownerFacts, eventId: "second" }));
  expect(first.status).toBe("executed");
  expect(second.status).toBe("executed");
  if (first.status !== "executed" || second.status !== "executed") return;
  expect(first.handle.target).toBe(second.handle.target);
  expect(ledger().stores.automations.list()).toHaveLength(1);
});

test("an ambient trigger writes an action and a matched ledger row", async () => {
  registerOwnerDm();
  addTrigger("ambient");
  const result = await runEffect(makeRouter().ingest(ownerSender,
    { ...ownerFacts, eventId: "ambient-one", dm: false }));
  expect(result).toMatchObject({ status: "executed", handle: { target: "worker" } });
  expect(commits).toHaveLength(1);
  expect(commits[0]).toMatchObject({ sessionId: "worker", kind: "action" });
  const ambientCommit = commits[0];
  if (ambientCommit === undefined) throw new Error("expected one commit");
  expect(JSON.parse(ambientCommit.content).event.messages).toHaveLength(1);
  expect(commits[0]?.origin.value).toMatchObject({ source: "ingress", handlerRef: "automation/ambient" });
  expect(ledger().stores.automations.decisions("discord:owner-workspace:owner-dm:ambient-one"))
    .toContainEqual(expect.objectContaining({ decision: "matched", by: "automation/ambient" }));
});

test("a new-target action materializes one new session", async () => {
  registerOwnerDm();
  addTrigger("spawn", { target: "new" });
  const result = await runEffect(makeRouter().ingest(ownerSender,
    { ...ownerFacts, eventId: "spawn-one", dm: false }));
  expect(result.status).toBe("executed");
  if (result.status !== "executed") return;
  expect(commits).toHaveLength(1);
  expect(commits[0]).toMatchObject({ kind: "action", sessionId: result.handle.target });
  expect(result.handle.target).not.toBe("new");
});

test("a repeated event records dedupe without a second session row", async () => {
  registerOwnerDm();
  const router = makeRouter();
  const first = await runEffect(router.ingest(ownerSender, ownerFacts));
  expect(first.status).toBe("executed");
  if (first.status !== "executed") return;
  const before = ledger().kernel.row(first.handle.target).revision;
  const recorded = ledger().stores.automations.decisions("discord:owner-workspace:owner-dm:inbound-owner-dm");
  const replay = await runEffect(router.ingest(ownerSender, ownerFacts));
  expect(replay).toMatchObject({
    status: "blocked_pre",
    reasonCode: "message.external.event_id_dedupe",
  });
  expect(commits).toHaveLength(1);
  expect(ledger().kernel.row(first.handle.target).revision).toBe(before);
  expect(ledger().stores.automations.decisions("discord:owner-workspace:owner-dm:inbound-owner-dm"))
    .toEqual([...recorded, expect.objectContaining({
      decision: "deduped", inboundId: "discord:owner-workspace:owner-dm:inbound-owner-dm",
    })]);
});

test("a filtered event records one ingress row and no session journal row", async () => {
  registerOwnerDm();
  const id = "discord:owner-workspace:owner-dm:bot-one";
  const result = await runEffect(makeRouter().ingest(ownerSender,
    { ...ownerFacts, eventId: "bot-one", author: { externalId: ownerSender.externalId, isBot: true } }));
  expect(result).toMatchObject({ status: "blocked_pre", reasonCode: "bot_author" });
  expect(ledger().stores.automations.decisions(id)).toEqual([
    expect.objectContaining({ decision: "filtered", by: "rule/bot-author" }),
  ]);
  expect(commits).toHaveLength(0);
  expect(ledger().kernel.actionById(id)).toBeUndefined();
});

test("a rate-limited automation records refused while ordinary delivery still executes", async () => {
  registerOwnerDm();
  addTrigger("limited", { limits: { maxRunsPerDay: 1 } });
  ledger().stores.automations.record(Ingress.Events.RoutingDecision.schema.parse({
    traceId: "seed", time: 1, inboundId: "seed", surface: ownerFacts.surface,
    mode: "direct", stage: "automation", outcome: "record", decision: "matched",
    by: "automation/limited", reason: "matched", factsUsed: [], factsDigest: "seed",
  }));
  const eventId = "discord:owner-workspace:owner-dm:limited-one";
  const result = await runEffect(makeRouter().ingest(ownerSender,
    { ...ownerFacts, eventId: "limited-one", dm: false }));
  expect(result.status).toBe("executed");
  expect(ledger().stores.automations.decisions(eventId)).toEqual([
    expect.objectContaining({ decision: "refused", reason: "limit" }),
  ]);
  expect(commits).toEqual([expect.objectContaining({ kind: "prompt", content: ownerFacts.render })]);
  expect(commits[0]?.sessionId).not.toBe("worker");
});

test("a grouped window closes once on injected clock advance without member journal rows", async () => {
  registerOwnerDm();
  addTrigger("group", { grouping: { by: "channel", windowSeconds: 10 } });
  const time = { now: 0 };
  const router = makeRouter({ now: () => time.now });
  for (const [eventId, at] of [["one", 0], ["two", 3000], ["three", 6000]] as const) {
    time.now = at;
    expect(await runEffect(router.ingest(ownerSender, { ...ownerFacts, dm: false, eventId })))
      .toMatchObject({ status: "blocked_pre", reasonCode: "grouped" });
    expect(commits).toHaveLength(0);
    expect(ledger().kernel.actionById(`discord:owner-workspace:owner-dm:${eventId}`)).toBeUndefined();
  }
  time.now = 10000;
  await runEffect(makeRouter({ now: () => time.now }).advance());
  expect(commits).toHaveLength(1);
  expect(commits[0]?.kind).toBe("action");
  const groupedCommit = commits[0];
  if (groupedCommit === undefined) throw new Error("expected one commit");
  expect(JSON.parse(groupedCommit.content).event.messages).toHaveLength(3);
  for (const eventId of ["one", "two", "three"]) {
    expect(ledger().stores.automations.decisions(`discord:owner-workspace:owner-dm:${eventId}`))
      .toEqual([
        expect.objectContaining({ decision: "grouped", reason: "grouped" }),
        expect.objectContaining(eventId === "three"
          ? { decision: "matched", target: "session:worker" }
          : { decision: "grouped", reason: `firing:${groupedCommit.id}` }),
      ]);
  }
  time.now = 20000;
  await runEffect(router.advance());
  expect(commits).toHaveLength(1);
});
