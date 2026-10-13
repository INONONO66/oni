import { describe, expect, expectTypeOf, test } from "bun:test";
import { DecisionFact } from "../src/ledger/schema.js";
import {
  Alarm,
  Journal,
  canonicalDigest,
  Delivery,
  LedgerAction,
  LedgerSession,
  PolicyRow,
  RESERVED_ALARM_PURPOSES,
  isReservedAlarmPurpose,
  type Tool,
  type PlainObject,
} from "../src/index.js";

const payload = { encodingVersion: 1, value: { text: "hello" } } as const;

describe("L0 ledger protocol", () => {
  test("changed payload fields retain the plain-object contract", () => {
    expectTypeOf<DecisionFact.Record["data"]>().toEqualTypeOf<PlainObject>();
    expectTypeOf<DecisionFact.Recorded["data"]>().toEqualTypeOf<PlainObject>();
    expectTypeOf<Tool.Spec["inputSchema"]>().toEqualTypeOf<PlainObject>();
  });

  test("rejects non-plain decision fact data", () => {
    const values = [() => "nope", new Date(), new (class Example {})(), { [Symbol("key")]: 1 }];
    for (const data of values) {
      expect(
        DecisionFact.Record.safeParse({ key: "s", type: "t", data, timeCreated: 1 }).success,
      ).toBe(false);
    }
  });

  test("rejects non-plain recorded fact data", () => {
    const values = [() => "nope", new Date(), new (class Example {})(), { [Symbol("key")]: 1 }];
    for (const data of values) {
      expect(
        DecisionFact.Recorded.safeParse({
          key: "s",
          type: "t",
          data,
          timeCreated: 1,
          rowHash: "0".repeat(64),
        }).success,
      ).toBe(false);
    }
  });

  test("parses every confirmed action kind and enforces terminal exclusivity", () => {
    const kinds = [...Journal.KINDS, "fold.checkpoint"] as const;

    for (const kind of kinds) {
      expect(
        LedgerAction.Node.parse({
          id: `action-${kind}`,
          parentId: null,
          sessionId: "session-1",
          kind,
          intent: payload,
          effect: payload,
          irreversible: true,
          ts: 100,
          ordinal: 1,
          prevHash: "fixture-prev",
          actionHash: "fixture-hash",
        }).kind,
      ).toBe(kind);
    }

    const base = {
      id: "action-1",
      parentId: null,
      sessionId: "session-1",
      kind: "tool",
      intent: payload,
      effect: payload,
      ts: 100,
      ordinal: 1,
      prevHash: "fixture-prev",
      actionHash: "fixture-hash",
    } as const;
    expect(LedgerAction.Node.safeParse(base).success).toBe(false);
    expect(
      LedgerAction.Node.safeParse({ ...base, revert: payload, irreversible: true }).success,
    ).toBe(false);
  });

  test("child delivery materialization requires pinned limits but root admission does not", () => {
    const admission = {
      id: "delivery-1",
      sessionId: "session-1",
      kind: "prompt",
      content: "hello",
      origin: payload,
      createdAt: 100,
    };
    const createSession = {
      row: {
        id: "session-1",
        parentId: null,
        role: "resident",
        fenceOwner: null,
        fence: 0,
        revision: 0,
        state: "idle",
      },
      initialAction: {
        id: "configure-1",
        parentId: null,
        sessionId: "session-1",
        kind: "session.configure",
        intent: payload,
        effect: payload,
        irreversible: true,
        ts: 100,
      },
    };
    expect(Delivery.Commit.parse(admission).parentActionId).toBeNull();
    expect(Delivery.Commit.safeParse({ ...admission, createSession }).success).toBe(true);
    const child = {
      ...createSession,
      row: { ...createSession.row, parentId: "parent-1", role: "child" },
    };
    const refused = Delivery.Commit.safeParse({ ...admission, createSession: child });
    expect(refused.success).toBe(false);
    expect(refused.error?.issues.map(({ path }) => path)).toEqual([["limits"]]);
    expect(
      Delivery.Commit.safeParse({
        ...admission,
        createSession: child,
        limits: { fanout: 0, depth: 0 },
      }).success,
    ).toBe(true);
  });

  test("watch lifetimes, absolute paths and regular expressions validate at the public boundary", () => {
    const command = { command: "echo hello", description: "command watch" };
    const path = { path: "/tmp/watch", event: "modify", description: "path watch" };
    const terminal = { machine: "m-1", session: "qa", description: "terminal watch" };
    for (const spec of [command, path, terminal]) {
      expect(Alarm.Watch.safeParse(spec).success).toBe(false);
      expect(Alarm.Watch.safeParse({ ...spec, persistent: true, timeout_ms: 1 }).success).toBe(
        false,
      );
      expect(Alarm.Watch.safeParse({ ...spec, persistent: true }).success).toBe(true);
      expect(Alarm.Watch.safeParse({ ...spec, timeout_ms: 1 }).success).toBe(true);
    }
    expect(Alarm.Watch.safeParse({ ...command, persistent: true, filter: "^hello$" }).success).toBe(
      true,
    );
    expect(Alarm.Watch.safeParse({ ...command, persistent: true, filter: undefined }).success).toBe(
      true,
    );
    for (const [spec, field] of [
      [{ ...command, timeout_ms: 1, filter: "[" }, "filter"],
      [{ ...terminal, timeout_ms: 1, filter: "[" }, "filter"],
      [{ ...path, persistent: true, path: "relative" }, "path"],
    ] as const) {
      const result = Alarm.Watch.safeParse(spec);
      expect(result.success).toBe(false);
      expect(result.error?.issues.map(({ path: issuePath }) => issuePath)).toEqual([[field]]);
    }
  });

  test("alarm occurrence minter is a pinned domain-separated digest", () => {
    const id = Alarm.occurrenceId("session-1", "alarm-1", 7, "retry");
    expect(id).toBe(canonicalDigest(["alarm.occurrence", "session-1", "alarm-1", 7, "retry"]));
    // Same inputs, same digest.
    expect(Alarm.occurrenceId("session-1", "alarm-1", 7, "retry")).toBe(id);
    // A fork never accepts its parent's key: sessionId changes the digest.
    expect(Alarm.occurrenceId("session-2", "alarm-1", 7, "retry")).not.toBe(id);
    expect(Alarm.occurrenceId("session-1", "alarm-2", 7, "retry")).not.toBe(id);
    expect(Alarm.occurrenceId("session-1", "alarm-1", 8, "retry")).not.toBe(id);
    expect(Alarm.occurrenceId("session-1", "alarm-1", 7, "deadline")).not.toBe(id);
  });

  test("parses session, delivery, fence-adoption, and global policy rows", () => {
    expect(
      LedgerSession.Row.parse({
        id: "session-1",
        parentId: null,
        role: "resident",
        fenceOwner: null,
        fence: 0,
        revision: 0,
        state: "idle",
      }),
    ).toMatchObject({ role: "resident", revision: 0, state: "idle" });

    expect(
      Delivery.Row.parse({
        id: "delivery-1",
        sessionId: "session-1",
        kind: "prompt",
        content: "hello",
        origin: payload,
        status: "pending",
        consumedBy: null,
        consumedAt: null,
        createdAt: 100,
        ordinal: 1,
      }),
    ).toMatchObject({ kind: "prompt", status: "pending" });

    expect(
      LedgerSession.AdoptFence.parse({ sessionId: "session-1", owner: "runner-1", fence: 3 }),
    ).toMatchObject({ owner: "runner-1", fence: 3 });
    expect(
      LedgerSession.AdoptFence.safeParse({ sessionId: "session-1", owner: "runner-1", fence: 0 })
        .success,
    ).toBe(false);

    expect(
      PolicyRow.Row.parse({
        name: "tool-guard",
        kind: "tool",
        phase: "pre",
        match: payload,
        verdict: payload,
        priority: 10,
        generation: 1,
      }),
    ).toMatchObject({ name: "tool-guard", generation: 1 });
  });
});

test("the loop-reserved alarm purpose set is closed and classifies exactly its members", () => {
  expect([...RESERVED_ALARM_PURPOSES]).toEqual(["step_watchdog", "retry", "deadline", "resume"]);
  for (const purpose of RESERVED_ALARM_PURPOSES) {
    expect(isReservedAlarmPurpose(purpose)).toBe(true);
  }
  expect(isReservedAlarmPurpose("monitor.hit")).toBe(false);
  expect(isReservedAlarmPurpose("cron.tick")).toBe(false);
});
