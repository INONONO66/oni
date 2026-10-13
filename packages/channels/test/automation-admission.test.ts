import { beforeEach, expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Gateway, Ingress } from "@openomni/protocol";
import { ledger, resetLedger } from "./helpers/ledger.js";
import { openRequest } from "./helpers/requests.js";
import { runEffect } from "./helpers/effect.js";
import { commits, makeRouter, ownerFacts, ownerSender, registerOwnerDm, resetRouterState, routingDecisions } from "./router/_router-fixture.js";

beforeEach(resetRouterState);

function trigger(extras: Partial<Ingress.Automation> = {}) {
  ledger().stores.automations.add(Ingress.Automation.parse({
    id: "admission", name: "Admission", enabled: true, createdBy: "owner",
    triggers: [{ type: "message", surface: "discord", event: "message" }],
    target: "session:worker", ...extras,
  }));
}
const facts = { ...ownerFacts, dm: false };
const id = "discord:owner-workspace:owner-dm:inbound-owner-dm";

test.each([0, 10] as const)("blocked routing cannot enter a %s-second automation", async (windowSeconds) => {
  trigger({ grouping: { by: "channel", windowSeconds } });
  const router = makeRouter();
  expect(await runEffect(router.ingest(ownerSender, facts))).toMatchObject({ status: "blocked_pre" });
  await runEffect(router.advance(10_001));
  expect(commits).toEqual([]);
  expect(ledger().stores.automations.decisions(id)).toEqual([]);
  expect(ledger().stores.automations.groups()).toEqual([]);
  expect(ledger().stores.automations.matchedToday("admission", 10_001)).toBe(0);
});

test.each(["matched", "filtered", "refused", "grouped", "superseded"] as const)(
  "%s replay retains exactly one original decision and observation", async (decision) => {
    registerOwnerDm();
    trigger(decision === "filtered" ? { conditions: { contains: ["missing"] } }
      : decision === "refused" ? { limits: { maxRunsPerDay: 1 } }
      : decision === "grouped" ? { grouping: { by: "channel", windowSeconds: 10 } } : {});
    if (decision === "refused") {
      ledger().stores.automations.record(Ingress.Events.RoutingDecision.schema.parse({
        traceId: "seed", time: 0, inboundId: "seed", surface: "discord", mode: "direct",
        stage: "automation", outcome: "record", decision: "matched", by: "automation/admission",
        reason: "matched", factsUsed: [], factsDigest: "seed",
      }));
    }
    const router = makeRouter();
    const event = decision === "superseded" ? ownerFacts : facts;
    const original = await runEffect(router.ingest(ownerSender, event));
    const rows = ledger().stores.automations.decisions(id);
    expect(rows).toEqual([expect.objectContaining({ decision })]);
    if (decision === "grouped") await runEffect(router.advance(10_001));
    const before = commits.length;
    const replay = await runEffect(router.ingest(ownerSender, event));
    if (original.status === "blocked_pre") expect(replay).toEqual(original);
    else expect(replay).toMatchObject({
      reasonCode: decision === "filtered" ? "filtered"
        : decision === "refused" ? "limit" : "message.external.event_id_dedupe",
    });
    expect(commits).toHaveLength(before);
    expect(ledger().stores.automations.decisions(id)).toEqual(rows);
    expect(routingDecisions().filter((row) => row.stage === "automation" && row.inboundId === id))
      .toEqual(rows);
  },
);

test.each(["action", "prompt"] as const)("a restored %s group uses gated dispatch and aggregated content", async (kind) => {
  registerOwnerDm();
  trigger({ kind, grouping: { by: "channel", windowSeconds: 10 } });
  const router = makeRouter({ now: () => 0 });
  await runEffect(router.ingest(ownerSender, facts));
  await runEffect(router.ingest(ownerSender, { ...facts, eventId: "second", render: "second body" }));
  expect(ledger().stores.automations.decisions(id)).toEqual([expect.objectContaining({ decision: "grouped" })]);
  const observations: Gateway.MessageObservation[] = [];
  await runEffect(makeRouter({ observe: (_sender, observation) => observations.push(observation) }).advance(10_000));
  expect(commits).toHaveLength(1);
  expect(commits[0]?.kind).toBe(kind);
  expect(commits[0]?.content).toContain("hello resident");
  expect(commits[0]?.content).toContain("second body");
  expect(observations.map((observation) => observation.kind))
    .toEqual(["message.sent", "message.admitted", "message.committed"]);
  expect(ledger().stores.automations.groups()).toEqual([]);
});

test.each([0, 10] as const)("the event-id gate refuses %s-second automation delivery", async (windowSeconds) => {
  registerOwnerDm();
  trigger({ grouping: { by: "channel", windowSeconds } });
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
});

test("revoked admission cannot be revived by closing an existing group", async () => {
  registerOwnerDm();
  trigger({ grouping: { by: "channel", windowSeconds: 10 } });
  const router = makeRouter({ now: () => 0 });
  await runEffect(router.ingest(ownerSender, facts));
  ledger().stores.blacklist.put({ id: "block", kind: "channel", value: ownerFacts.channelId, createdBy: "owner" });
  await runEffect(router.advance(10_000));
  expect(commits).toEqual([]);
  expect(ledger().stores.automations.groups()).toEqual([]);
});

test("a grouped new target and all members survive closing and reopening SQLite", async () => {
  const directory = mkdtempSync(join(tmpdir(), "automation-restart-"));
  const paths = { catalog: join(directory, "catalog.sqlite"), sessions: join(directory, "session.sqlite") };
  resetLedger(paths);
  try {
    registerOwnerDm();
    trigger({ target: "new", grouping: { by: "author", windowSeconds: 10 } });
    const router = makeRouter({ now: () => 0 });
    await runEffect(router.ingest(ownerSender, facts));
    const target = ledger().stores.automations.groups()[0]?.target;
    if (target === undefined) throw new Error("group target was not persisted");
    await runEffect(router.ingest(ownerSender, { ...facts, eventId: "second" }));
    resetLedger(paths);
    const resumed = makeRouter({ now: () => 10_000 });
    await runEffect(resumed.advance());
    expect(commits).toHaveLength(1);
    expect(`session:${commits[0]?.sessionId}`).toBe(target);
    expect(JSON.parse(commits[0]?.content ?? "{}").event.messages).toHaveLength(2);
    expect(ledger().stores.automations.matchedToday("admission", 10_000)).toBe(1);
    await runEffect(resumed.ingest(ownerSender, facts));
    expect(ledger().stores.automations.decisions(id)).toHaveLength(1);
    expect(commits).toHaveLength(1);
  } finally {
    resetLedger();
    rmSync(directory, { recursive: true, force: true });
  }
});

test.each(["disabled", "removed", "limited"] as const)("a %s group closes without session delivery", async (state) => {
  registerOwnerDm();
  trigger({ grouping: { by: "thread", windowSeconds: 10 } });
  const router = makeRouter({ now: () => 0 });
  await runEffect(router.ingest(ownerSender, facts));
  const store = ledger().stores.automations;
  if (state === "disabled") store.disable("admission");
  else if (state === "removed") store.remove("admission");
  else {
    trigger({ grouping: { by: "thread", windowSeconds: 10 }, limits: { maxRunsPerDay: 1 } });
    store.record(Ingress.Events.RoutingDecision.schema.parse({
      traceId: "seed", time: 0, inboundId: "seed", surface: "discord", mode: "direct",
      stage: "automation", outcome: "record", decision: "matched", by: "automation/admission",
      reason: "matched", factsUsed: [], factsDigest: "seed",
    }));
  }
  await runEffect(router.advance(10_000));
  expect(commits).toEqual([]);
  expect(store.groups()).toEqual([]);
  expect(store.decisions(id)).toEqual([expect.objectContaining({ decision: "grouped" })]);
});

test("a request created after grouping cannot acquire the held event", async () => {
  registerOwnerDm();
  trigger({ grouping: { by: "channel", windowSeconds: 10 } });
  const router = makeRouter({ now: () => 0 });
  await runEffect(router.ingest(ownerSender, { ...facts, reply: { chain: [], tokenHash: "late" } }));
  await runEffect(await openRequest("late", {
    expectedResponders: ["actor-owner"],
    correlation: { channelId: ownerFacts.channelId, tokenHash: "late" },
  }));
  await runEffect(router.advance(10_000));
  expect(commits).toEqual([]);
  expect(ledger().kernel.requestById("late")?.state).toBe("open");
});

test.each([0, 10] as const)("egress denial also governs %s-second automation delivery", async (windowSeconds) => {
  registerOwnerDm();
  trigger({ grouping: { by: "channel", windowSeconds } });
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
});
