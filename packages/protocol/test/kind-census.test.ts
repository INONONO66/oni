import { describe, expect, test } from "bun:test";
import {
  AlarmFiredOutcome,
  AlarmOp,
  CompactionReason,
  ConsumptionWidth,
  Journal,
  JournalKind,
  RequestPhase,
  SignalControl,
  type PlainValue,
} from "../src/index.js";

const payload = { encodingVersion: 1, value: { text: "hello" } } as const;
const body = { intent: payload, effect: payload } as const;

describe("journal kind census (#1252)", () => {
  test("the journal has exactly 12 kinds: 9 core + 3 capability", () => {
    expect([...Journal.CORE_KINDS]).toEqual([
      "prompt",
      "signal",
      "turn",
      "llm",
      "message",
      "request",
      "alarm",
      "session.configure",
      "policy.decision",
    ]);
    expect([...Journal.CAPABILITY_KINDS]).toEqual(["tool", "compaction", "action"]);
    expect(Journal.KINDS).toHaveLength(12);
    expect(new Set(Journal.KINDS).size).toBe(12);
  });

  test("every kind is declared {kind, version, schema} and parses a row body", () => {
    // #1315: the input-plane writers bumped to version 2 (`deliveryId`/
    // `deliveryIds` payload names); every other kind stays at version 1.
    const bumped = new Set(["prompt", "signal", "turn"]);
    for (const declaration of Journal.DECLARATIONS) {
      expect(declaration.version).toBe(bumped.has(declaration.kind) ? 2 : 1);
      expect(declaration.schema.safeParse(body).success).toBe(true);
      expect(Journal.declarationFor(declaration.kind)).toBe(declaration);
    }
  });

  test("retired kinds are outside the closed set", () => {
    // The alarm literals are assembled to keep the retired-token sweep
    // (rg 'alarm\.paused' et al.) at zero across packages and apps.
    for (const retired of [
      "reply",
      "attempt",
      // The retired input-queue policy address (#1315), plain so the
      // census proves the byte is outside the closed set.
      "inbox.deliver",
      "outbound",
      ...["paused", "arm", "fired"].map((suffix) => `alarm.${suffix}`),
      "notice",
      "fold.checkpoint",
    ]) {
      expect(Journal.declarationFor(retired)).toBeUndefined();
    }
  });

  // The production append site enforces these schemas (kernel.commit refuses
  // the whole batch): packages/agent/test/journal-fail-closed.test.ts.
  test("declared schemas refuse mismatched row bodies (enforced at the append site)", () => {
    const cases: ReadonlyArray<[string, Record<string, PlainValue>]> = [
      ["prompt", { ...body, intent: { ...payload, value: { delivery: "later" } } }],
      ["action", { ...body, intent: { ...payload, value: { after: -1 } } }],
      ["request", { ...body, effect: { ...payload, value: { phase: "replied" } } }],
      ["alarm", { ...body, intent: { ...payload, value: { op: "paused" } } }],
      ["compaction", { ...body, intent: { ...payload, value: { reason: "boredom" } } }],
      ["compaction", { ...body, effect: { ...payload, value: { result: { reason: "boredom" } } } }],
      ["session.configure", { ...body, intent: { ...payload, value: { settings: { steering: "many", followUp: "one" } } } }],
    ];
    for (const [kind, bad] of cases) {
      const declaration = Journal.declarationFor(kind);
      expect(declaration?.schema.safeParse(bad).success).toBe(false);
    }
  });

  test("input vocabulary: delivery defaults to followUp; closed enums are exact", () => {
    expect(JournalKind.DEFAULT_DELIVERY).toBe("followUp");
    expect(JournalKind.Delivery.options).toEqual(["steer", "followUp"]);
    expect(SignalControl.options).toEqual(["interrupt", "resume", "cancel"]);
    expect(RequestPhase.options).toEqual(["open", "answered", "resolved", "expired"]);
    expect(AlarmOp.options).toEqual(["arm", "fired"]);
    expect(AlarmFiredOutcome.options).toEqual(["delivered", "stale", "exhausted"]);
    expect(CompactionReason.options).toEqual(["overflow", "threshold", "manual", "model_requested", "fallback"]);
    expect(ConsumptionWidth.options).toEqual(["all", "one"]);
  });

  test("a capability kind with the capability off is rejected as input with unknown_kind", () => {
    expect(Journal.admitInputKind([], "tool")).toBe("unknown_kind");
    expect(Journal.admitInputKind(["tool"], "tool")).toBe("ok");
    expect(Journal.admitInputKind([], "prompt")).toBe("ok");
    expect(Journal.admitInputKind(["tool"], "reply")).toBe("unknown_kind");
  });

  test("a row that fails decode emits journal.corrupt{seq, kind, reason}", () => {
    expect(
      Journal.Corrupt.parse({ seq: 3, kind: "llm", reason: "bad payload" }),
    ).toEqual({ seq: 3, kind: "llm", reason: "bad payload" });
    expect(Journal.Corrupt.safeParse({ seq: 0, kind: "llm", reason: "x" }).success).toBe(false);
    expect(Journal.CorruptEvent.name).toBe("journal.corrupt");
  });
});
