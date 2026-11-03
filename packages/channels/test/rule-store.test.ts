import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { Ingress } from "@oni/protocol";
import { createRuleStore, RuleEnableRefused } from "@oni/channels";
import { openChannelStore } from "@oni/channels";
import { RuleConfigurationError } from "@oni/channels";
import { effectFailure } from "./helpers/effect-failure.js";
import { StoredGroup } from "../src/store/rule/group.js";

const record = Ingress.Rule.parse({
  id: "daily", position: 0, enabled: false, createdBy: "session:x",
  when: { instance: "telegram" },
  outcome: { kind: "deliver", target: "session:x", deliveryKind: "action", reply: "none", maxRunsPerDay: 2 },
});

function fixture() {
  const db = new Database(":memory:");
  const store = createRuleStore(openChannelStore(db, () => 0));
  return { db, store };
}

describe("rule store", () => {
  test("an unapproved session record cannot be enabled", () => {
    const { db, store } = fixture();
    store.add(record);
    expect(() => store.enable(record.id)).toThrow(RuleEnableRefused);
    expect(store.get(record.id)?.record.enabled).toBe(false);
    store.approve(record.id);
    expect(store.enable(record.id).record.enabled).toBe(true);
    db.close();
  });

  test("records decisions and counts matched rows by UTC day", () => {
    const { db, store } = fixture();
    store.add(record);
    const row = Ingress.Events.RoutingDecision.schema.parse({
      traceId: "trace", time: 86_400_000, inboundId: "event-1", surface: "telegram",
      mode: "direct", stage: "automation", outcome: "record", decision: "matched",
      by: "rule/daily", reason: "matched", factsUsed: ["event"], factsDigest: "digest",
    });
    store.record(row);
    store.record({ ...row, time: 86_400_001, inboundId: "event-2" });
    store.record({ ...row, time: 172_800_000, inboundId: "event-3" });
    expect(store.matchedToday("daily", 86_400_002)).toBe(2);
    expect(store.matchedToday("daily", 172_800_001)).toBe(1);
    expect(store.decisions("event-1")).toEqual([row]);
    db.close();
  });

});


test("unconfigured rule storage fails through the typed Effect channel", async () => {
  const store = createRuleStore({});
  expect(await effectFailure(store.ready)).toMatchObject({
    _tag: "RuleConfigurationError", reason: "store_unconfigured",
  });
  expect(() => store.list()).toThrow(RuleConfigurationError);
});

test("authorization and enable disable remove operations retain their stored state", () => {
  const { db, store } = fixture();
  try {
    expect(() => store.add({ ...record, enabled: true })).toThrow(RuleEnableRefused);
    expect(store.list()).toEqual([]);
    for (const operate of [store.enable, store.disable, store.approve])
      expect(() => operate("missing")).toThrow(RuleEnableRefused);
    store.add({ ...record, createdBy: "session:test", enabled: true }, true);
    expect(store.disable(record.id).record.enabled).toBe(false);
    expect(store.enable(record.id).record.enabled).toBe(true);
    expect(store.remove(record.id)).toBe(true);
    expect(store.remove(record.id)).toBe(false);
  } finally { db.close(); }
});

test("group closure records member facts atomically and cannot close twice", () => {
  const { db, store } = fixture();
  const held = Ingress.Events.RoutingDecision.schema.parse({
    traceId: "member", time: 0, inboundId: "member", surface: "telegram", mode: "direct",
    stage: "automation", outcome: "record", decision: "grouped", by: "rule/daily",
    reason: "grouped", factsUsed: ["grouping"], factsDigest: "digest",
  });
  const group = StoredGroup.parse({
    id: "group", target: "session:x", sender: { kind: "external", surface: "telegram", externalId: "sender" },
    facts: { eventId: "member", surface: "telegram", channelId: "room", addressees: [],
      dm: false, payload: "hello", render: "hello" },
    pending: { ruleId: "daily", key: "room", openedAt: 0, windowSeconds: 10,
      when: { instance: "telegram" },
      inputs: [{ eventId: "member", instance: "telegram", surface: "telegram", event: "message", channelId: "room",
        author: { externalId: "sender", isBot: false }, dm: false, addressed: false,
        from: "sender", addressees: [], payload: {},
        render: "hello", receivedAt: 0 }] },
  });
  const closed = Ingress.Events.RoutingDecision.schema.parse({
    ...held, time: 10_000, decision: "filtered", reason: "disabled",
  });
  try {
    store.record(held, group);
    db.exec("CREATE TRIGGER fail_close BEFORE INSERT ON rule_group_close BEGIN SELECT RAISE(ABORT, 'close unavailable'); END");
    expect(() => store.closeGroup(group.id, 10_000, false, [closed])).toThrow("close unavailable");
    expect(store.groups()).toEqual([group]);
    expect(store.decisions("member")).toEqual([held]);
    db.exec("DROP TRIGGER fail_close");
    expect(store.closeGroup(group.id, 10_000, false, [closed])).toEqual([closed]);
    expect(store.closeGroup(group.id, 20_000, true, [closed])).toEqual([]);
    expect(store.groups()).toEqual([]);
    expect(store.decisions("member")).toEqual([held, closed]);
    expect(store.matchedToday("daily", 20_000)).toBe(0);
  } finally { db.close(); }
});

test("move reorders atomically and seeded rows cannot be deleted or unprotected", () => {
  const { db, store } = fixture();
  try {
    store.add({ ...record, id: "seed", position: 0, createdBy: "session:test", seed: true }, true);
    store.add({ ...record, id: "first", position: 1 });
    store.add({ ...record, id: "second", position: 2 });
    expect(store.move("second", 0).record.position).toBe(0);
    expect(store.list().map(({ record: row }) => [row.id, row.position]))
      .toEqual([["second", 0], ["seed", 1], ["first", 2]]);
    expect(() => store.remove("seed")).toThrow(RuleEnableRefused);
    expect(() => store.add({ ...record, id: "seed", position: 1, seed: false })).toThrow(RuleEnableRefused);
    expect(store.disable("seed").record.enabled).toBe(false);
    expect(() => store.move("missing", 0)).toThrow(RuleEnableRefused);
    expect(() => store.move("first", -1)).toThrow(RuleEnableRefused);
    expect(() => store.move("first", 3)).toThrow(RuleEnableRefused);
    expect(store.list().map(({ record: row }) => row.id)).toEqual(["second", "seed", "first"]);
    store.remove("second");
    expect(store.list().map(({ record: row }) => row.position)).toEqual([0, 1]);
  } finally { db.close(); }
});
