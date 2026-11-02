import { beforeEach, expect, test } from "bun:test";
import { Effect } from "effect";
import { Delivery, Ingress } from "@oni/protocol";
import { ledger } from "./helpers/ledger.js";
import { runEffect } from "./helpers/effect.js";
import { commits, createMappedOwnerSession, makeRouter, ownerFacts, ownerSender, registerOwnerDm, resetRouterState } from "./router/_router-fixture.js";

beforeEach(resetRouterState);

test.each([
  { name: "DM", facts: ownerFacts, expected: "seed-owner-dm" },
  { name: "mention", facts: { ...ownerFacts, dm: false, account: "self", addressees: [{ externalId: "self" }] }, expected: "seed-owner-addressed" },
  { name: "bot author", facts: { ...ownerFacts, author: { externalId: "bot", isBot: true } }, expected: "none" },
  { name: "unaddressed reaction", facts: { ...ownerFacts, dm: false, event: "reaction" as const }, expected: "none" },
] satisfies { name: string; facts: Ingress.Message; expected: string }[])("router records the matched rule for $name", async ({ facts, expected }) => {
  registerOwnerDm();
  await runEffect(makeRouter().ingest(ownerSender, facts));
  expect(ledger().stores.rules.decisions("discord:owner-workspace:owner-dm:inbound-owner-dm")[0]).toMatchObject({ by: `rule/${expected}` });
});

test.each(["yes", "no", "unknown"] as const)("router judge %s records exactly the selected rule", async (verdict) => {
  addRule("judged", { judge: "JUDGE_SENTINEL" });
  await runEffect(makeRouter({ judge: () => Effect.succeed(verdict) }).ingest(ownerSender, ownerFacts));
  expect(ledger().stores.rules.decisions("discord:owner-workspace:owner-dm:inbound-owner-dm")[0])
    .toMatchObject({ by: verdict === "yes" ? "rule/judged" : "rule/none" });
});

test.each(["drop", "record"] as const)("a %s outcome terminates matching without delivery or group holding", async (kind) => {
  registerOwnerDm();
  addRule("stop", { outcome: { kind }, group: { by: "thread", windowSeconds: 10 } });
  const router = makeRouter();
  expect(await runEffect(router.ingest(ownerSender, ownerFacts))).toEqual({ status: "blocked_pre", reasonCode: kind });
  expect(ledger().stores.rules.decisions("discord:owner-workspace:owner-dm:inbound-owner-dm")[0])
    .toMatchObject({ by: "rule/stop", decision: "filtered", reason: kind });
  expect(commits).toEqual([]);
  expect(ledger().stores.rules.groups()).toEqual([]);
  expect(await runEffect(router.ingest(ownerSender, ownerFacts))).toEqual({ status: "blocked_pre", reasonCode: kind });
});

function addRule(id: string, extras: Partial<Ingress.Rule> = {}) {
  ledger().stores.rules.add(Ingress.Rule.parse({
    id, position: 0, enabled: true, createdBy: "owner", when: { instance: ownerFacts.surface },
    outcome: { kind: "deliver", target: "session:worker", deliveryKind: "action", reply: "none" }, ...extras,
  }));
}

test.each(["matched", "missing", "disabled", "unapproved"] as const)(
  "only a matched enabled approved rule routes an unknown sender: %s", async (state) => {
    if (state !== "missing") addRule("selected", { enabled: state === "matched", createdBy: state === "unapproved" ? "session:proposer" : "owner" });
    const result = await runEffect(makeRouter().ingest(ownerSender, ownerFacts));
    expect(result).toMatchObject(state === "matched" ? { status: "executed", handle: { target: "worker" } } : { status: "blocked_pre", reasonCode: "none" });
    expect(commits).toHaveLength(state === "matched" ? 1 : 0);
    const row = ledger().stores.rules.decisions("discord:owner-workspace:owner-dm:inbound-owner-dm")[0];
    expect(row).toMatchObject({ by: state === "matched" ? "rule/selected" : "rule/none" });
  },
);

test("conversation rules preserve the first claimed DM session without synthesizing records", async () => {
  registerOwnerDm();
  const existing = createMappedOwnerSession();
  const router = makeRouter();
  const first = await runEffect(router.ingest(ownerSender, ownerFacts));
  const second = await runEffect(router.ingest(ownerSender, { ...ownerFacts, eventId: "second" }));
  expect(first).toMatchObject({ status: "executed", handle: { target: existing.id } });
  expect(second).toMatchObject({ status: "executed", handle: { target: existing.id } });
  expect(ledger().stores.rules.list().map(({ record }) => record.id)).toEqual(["seed-owner-dm", "seed-owner-addressed"]);
});

test("a mention claims its root thread and a bound followup matches the same addressed rule", async () => {
  registerOwnerDm();
  const router = makeRouter();
  const first = await runEffect(router.ingest(ownerSender, { ...ownerFacts, dm: false, account: "self", addressees: [{ externalId: "self" }], eventId: "root" }));
  const followup = await runEffect(router.ingest(ownerSender, { ...ownerFacts, dm: false, eventId: "reply", reply: { chain: [], threadId: "root" } }));
  expect(first.status).toBe("executed");
  expect(followup.status).toBe("executed");
  if (first.status !== "executed" || followup.status !== "executed") throw new Error("thread was not routed");
  expect(followup.handle.target).toBe(first.handle.target);
  expect(ledger().stores.surfaceKeys.lookup("discord:channel:owner-dm:thread:root")).toBe(first.handle.target);
  expect(ledger().stores.rules.decisions("discord:owner-workspace:owner-dm:reply")[0]).toMatchObject({ by: "rule/seed-owner-addressed" });
  expect(await runEffect(router.ingest(ownerSender, { ...ownerFacts, dm: false, eventId: "ambient" })))
    .toEqual({ status: "blocked_pre", reasonCode: "none" });
});

test("position precedes a conversation seed and delivers one action", async () => {
  registerOwnerDm();
  addRule("first");
  const result = await runEffect(makeRouter().ingest(ownerSender, ownerFacts));
  expect(result).toMatchObject({ status: "executed", handle: { target: "worker" } });
  expect(commits).toHaveLength(1);
  expect(commits[0]?.kind).toBe("action");
  expect(JSON.parse(Delivery.text(commits[0]?.content ?? []))).toMatchObject({ ruleId: "first", event: { instance: "discord" } });
});

test("new-target actions create one new session", async () => {
  addRule("spawn", { outcome: { kind: "deliver", target: "new", deliveryKind: "action", reply: "none" } });
  const result = await runEffect(makeRouter().ingest(ownerSender, ownerFacts));
  expect(result.status).toBe("executed");
  if (result.status !== "executed") throw new Error("new session was not routed");
  expect(commits).toEqual([expect.objectContaining({ kind: "action", sessionId: result.handle.target })]);
  expect(result.handle.target).not.toBe("new");
});

test("event replay records dedupe without another delivery", async () => {
  registerOwnerDm();
  const router = makeRouter();
  expect((await runEffect(router.ingest(ownerSender, ownerFacts))).status).toBe("executed");
  expect(await runEffect(router.ingest(ownerSender, ownerFacts))).toMatchObject({ status: "blocked_pre", reasonCode: "message.external.event_id_dedupe" });
  expect(commits).toHaveLength(1);
  expect(ledger().stores.rules.decisions("discord:owner-workspace:owner-dm:inbound-owner-dm").map((row) => row.stage === "automation" ? row.decision : undefined)).toEqual(["matched", "deduped"]);
});

test("bot authors are admitted only when an explicit rule permits them", async () => {
  registerOwnerDm();
  const bot = { ...ownerFacts, author: { externalId: "bot", isBot: true } };
  expect(await runEffect(makeRouter().ingest(ownerSender, bot))).toEqual({ status: "blocked_pre", reasonCode: "none" });
  expect(commits).toHaveLength(0);
  addRule("bots", { when: { instance: "discord", isBot: true } });
  expect((await runEffect(makeRouter().ingest(ownerSender, { ...bot, eventId: "next" }))).status).toBe("executed");
  expect(commits).toHaveLength(1);
});

test("a selected rule's daily limit never falls back to conversation delivery", async () => {
  registerOwnerDm();
  addRule("limited", { outcome: { kind: "deliver", target: "session:worker", deliveryKind: "action", reply: "none", maxRunsPerDay: 1 } });
  const router = makeRouter();
  expect((await runEffect(router.ingest(ownerSender, ownerFacts))).status).toBe("executed");
  expect(await runEffect(router.ingest(ownerSender, { ...ownerFacts, eventId: "limited" }))).toEqual({ status: "blocked_pre", reasonCode: "limit" });
  expect(commits).toHaveLength(1);
});

test("grouped thread members close once on exact clock advance", async () => {
  addRule("group", { group: { by: "thread", windowSeconds: 10 } });
  const time = { now: 0 };
  const router = makeRouter({ now: () => time.now });
  for (const [eventId, at] of [["one", 0], ["two", 3000], ["three", 6000]] as const) {
    time.now = at;
    expect(await runEffect(router.ingest(ownerSender, { ...ownerFacts, dm: false, eventId, reply: { chain: [], threadId: "root" } }))).toMatchObject({ status: "blocked_pre", reasonCode: "grouped" });
  }
  expect(commits).toHaveLength(0);
  await runEffect(router.advance(10000));
  expect(commits).toHaveLength(1);
  expect(JSON.parse(Delivery.text(commits[0]?.content ?? [])).event.messages).toHaveLength(3);
  await runEffect(router.advance(20000));
  expect(commits).toHaveLength(1);
});
