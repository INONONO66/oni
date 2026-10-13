import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { Ingress } from "@openomni/protocol";
import { createAutomationStore, AutomationEnableRefused } from "../src/store/automation/index.js";
import { openChannelStore } from "../src/store/sqlite/index.js";
import { AutomationConfigurationError } from "../src/errors.js";
import { compiledPattern } from "../src/automation/regex.js";
import { effectFailure } from "./helpers/effect-failure.js";
import { StoredGroup } from "../src/store/automation/group.js";

const record = Ingress.Automation.parse({
  id: "daily", name: "Daily", enabled: false, createdBy: "session:x",
  triggers: [{ type: "message", surface: "telegram", event: "message" }],
  target: "session:x", limits: { maxRunsPerDay: 2 },
});

function fixture() {
  const db = new Database(":memory:");
  const store = createAutomationStore(openChannelStore(db, () => 0));
  return { db, store };
}

describe("automation store", () => {
  test("an unapproved session record cannot be enabled", () => {
    const { db, store } = fixture();
    store.add(record);
    expect(() => store.enable(record.id)).toThrow(AutomationEnableRefused);
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
      by: "automation/daily", reason: "matched", factsUsed: ["event"], factsDigest: "digest",
    });
    store.record(row);
    store.record({ ...row, time: 86_400_001, inboundId: "event-2" });
    store.record({ ...row, time: 172_800_000, inboundId: "event-3" });
    expect(store.matchedToday("daily", 86_400_002)).toBe(2);
    expect(store.matchedToday("daily", 172_800_001)).toBe(1);
    expect(store.decisions("event-1")).toEqual([row]);
    db.close();
  });

  test("migrates a granted surface to one prompt record without duplicates", () => {
    const { db, store } = fixture();
    const grant = { surfaceKey: "telegram:dm:user", surface: "telegram", channelId: "dm:user",
      users: ["user"], sessionId: "resident" };
    const first = store.migrateGrantedDirect(grant);
    expect(first).toMatchObject({ kind: "prompt", enabled: true, target: "session:resident",
      conditions: { channels: ["dm:user"], includeBots: false } });
    expect(first.conditions?.users).toBeUndefined();
    expect(store.migrateGrantedDirect(grant)).toEqual(first);
    expect(store.list()).toHaveLength(1);
    db.close();
  });
});

test("invalid regex configuration is refused before persistence and valid patterns are cached", () => {
  const { db, store } = fixture();
  try {
    for (const pattern of ["[", "x".repeat(513)]) {
      expect(() => store.add({ ...record, conditions: { regex: [pattern] } }))
        .toThrow(AutomationConfigurationError);
      expect(store.get(record.id)).toBeUndefined();
    }
    store.add({ ...record, conditions: { regex: ["^deploy"] } });
    expect(compiledPattern("^deploy")).toBe(compiledPattern("^deploy"));
    expect(compiledPattern("^deploy").test("deploy now")).toBe(true);
  } finally { db.close(); }
});

test("unconfigured automation storage fails through the typed Effect channel", async () => {
  const store = createAutomationStore({});
  expect(await effectFailure(store.ready)).toMatchObject({
    _tag: "AutomationConfigurationError", reason: "store_unconfigured",
  });
  expect(() => store.list()).toThrow(AutomationConfigurationError);
});

test("owner approval and enable disable remove operations retain their stored state", () => {
  const { db, store } = fixture();
  try {
    expect(() => store.add({ ...record, enabled: true })).toThrow(AutomationEnableRefused);
    expect(store.list()).toEqual([]);
    for (const operate of [store.enable, store.disable, store.approve])
      expect(() => operate("missing")).toThrow(AutomationEnableRefused);
    store.add({ ...record, createdBy: "owner", enabled: true });
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
    stage: "automation", outcome: "record", decision: "grouped", by: "automation/daily",
    reason: "grouped", factsUsed: ["grouping"], factsDigest: "digest",
  });
  const group = StoredGroup.parse({
    id: "group", target: "session:x", sender: { kind: "external", surface: "telegram", externalId: "owner" },
    facts: { eventId: "member", surface: "telegram", channelId: "room", addressees: [],
      dm: false, payload: "hello", render: "hello" },
    pending: { automationId: "daily", key: "room", openedAt: 0, windowSeconds: 10,
      trigger: { type: "message", surface: "telegram", event: "message" },
      inputs: [{ eventId: "member", surface: "telegram", event: "message", channelId: "room",
        author: { externalId: "owner", isBot: false }, dm: false, mentionsBot: false,
        body: "hello", receivedAt: 0 }] },
  });
  const closed = Ingress.Events.RoutingDecision.schema.parse({
    ...held, time: 10_000, decision: "filtered", reason: "disabled",
  });
  try {
    store.record(held, group);
    db.exec("CREATE TRIGGER fail_close BEFORE INSERT ON automation_group_close BEGIN SELECT RAISE(ABORT, 'close unavailable'); END");
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
