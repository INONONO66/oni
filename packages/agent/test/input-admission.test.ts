import { expect, test } from "bun:test";
import { Delivery, Journal } from "@oni/protocol";
import { kernelOwnedRow } from "./helpers/request-fixtures";
import { deliveryActions, inputRowKind, receivedMessageAction } from "../src/core/journal/delivery";
import { decideSessionAdmission } from "../src/core/session/admission";

/**
 * Input admission: delivered inputs are journal rows of the closed set —
 * `prompt` rows carry `delivery: steer|followUp` (default `followUp`), control
 * inputs (interrupt/resume) are `signal` rows — and each produced row passes
 * its kind's declared schema.
 */

function row(kind: Delivery.Kind, id: string): Delivery.Row {
  return Delivery.Row.parse({
    id,
    sessionId: "s1",
    kind,
    content: "payload",
    origin: { encodingVersion: 1, value: { channel: "test" } },
    status: "pending",
    consumedBy: null,
    consumedAt: null,
    createdAt: 10,
    ordinal: 1,
  });
}

test("a delivered prompt is a prompt row with delivery defaulting to followUp", () => {
  const [action] = deliveryActions([row("prompt", "in-1")], { kind: "turn", turnId: "t1" }, "before_llm", null);
  if (action === undefined) throw new Error("missing delivery action");
  expect(action.kind).toBe("prompt");
  expect(action.intent.value).toEqual({ deliveryId: "in-1", delivery: "followUp" });
  expect(Journal.declarationFor("prompt")?.schema.safeParse({ intent: action.intent, effect: action.effect }).success).toBe(true);
});

test("control inputs deliver as signal rows, never as turn inputs of the prompt kind", () => {
  for (const control of ["interrupt", "resume"] as const) {
    const [action] = deliveryActions([row(control, `in-${control}`)], { kind: "pending" }, "before_llm", null);
    if (action === undefined) throw new Error("missing delivery action");
    expect(action.kind).toBe("signal");
    expect(action.intent.value).toEqual({ deliveryId: `in-${control}`, control });
    expect(Journal.declarationFor("signal")?.schema.safeParse({ intent: action.intent, effect: action.effect }).success).toBe(true);
  }
});

test("admission rows split the same way: prompt stays prompt, control admits as signal", () => {
  const admit = (kind: Delivery.Kind) =>
    receivedMessageAction({
      id: `adm-${kind}`,
      sessionId: "s1",
      kind,
      content: "payload",
      origin: { encodingVersion: 1, value: { channel: "test" } },
      parentActionId: null,
      at: 10,
    });
  expect(admit("prompt").kind).toBe("prompt");
  expect(admit("interrupt").kind).toBe("signal");
  expect(admit("resume").kind).toBe("signal");
  // The delivery vocabulary itself is closed: steer|followUp only.
  const declaration = Journal.declarationFor("prompt");
  const base = admit("prompt");
  expect(
    declaration?.schema.safeParse({
      intent: { encodingVersion: 1, value: { delivery: "steer" } },
      effect: base.effect,
    }).success,
  ).toBe(true);
  expect(
    declaration?.schema.safeParse({
      intent: { encodingVersion: 1, value: { delivery: "immediately" } },
      effect: base.effect,
    }).success,
  ).toBe(false);
});

test("an input of a capability kind whose capability is off is rejected with unknown_kind", () => {
  const sessionRow = kernelOwnedRow("s1", "idle");
  const pending = [row("action", "in-action")];
  // The composed generation registers only the built-ins: the action input is refused.
  const refused = decideSessionAdmission({ row: sessionRow, pending, capabilityKinds: ["tool", "compaction"] });
  expect(refused).toEqual({ kind: "refused", reason: "unknown_kind" });
  // The same input with the action capability composed is admitted and heads
  // a turn like a prompt: boundary consumption — not an idle
  // noop-consume — owns a pending action's delivery or stale closure.
  const admitted = decideSessionAdmission({
    row: sessionRow,
    pending,
    capabilityKinds: ["tool", "compaction", "action"],
  });
  expect(admitted).toEqual({ kind: "start" });
  // The mapping is exact: action inputs land as action rows, control as signal.
  expect(inputRowKind("action")).toBe("action");
  expect(inputRowKind("prompt")).toBe("prompt");
  expect(inputRowKind("interrupt")).toBe("signal");
  expect(inputRowKind("resume")).toBe("signal");
  const [delivery] = deliveryActions(pending, { kind: "pending" }, "before_llm", null);
  if (delivery === undefined) throw new Error("missing delivery action");
  expect(delivery.kind).toBe("action");
  expect(delivery.intent.value).toEqual({ deliveryId: "in-action", delivery: "followUp" });
  expect(Journal.declarationFor("action")?.schema.safeParse({ intent: delivery.intent, effect: delivery.effect }).success).toBe(true);
});
