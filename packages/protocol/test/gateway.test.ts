import { describe, expect, test } from "bun:test";
import { ZodError } from "zod";
import { Gateway } from "../src/gateway/index.js";

const actorContext = {
  trustTier: "observer",
  inboundTreatment: "evidence_only",
  origin: { surface: "telegram", externalId: "u-9" },
} as const;
const event = {
  id: "m-1",
  traceId: "t-1",
  surface: "telegram",
  mode: "direct",
  payload: "hello",
} as const;
const decision = {
  traceId: "t-1",
  time: 1_000,
  inboundId: "m-1",
  surface: "telegram",
  mode: "direct",
  reason: "surface default",
  factsUsed: [],
  stage: "surface_default",
  outcome: "route",
  target: "resident",
} as const;
const delivery = { sessionId: "s-1", actorContext, event, decision };

// Keep the failure cases as data: the schema, rather than a test-side cast,
// decides whether each nested field is allowed across the delivery seam.
describe("Gateway.Deliver", () => {
  test("parses anonymous delivery and request resumption", () => {
    expect(Gateway.Deliver.parse(delivery).actorContext?.trustTier).toBe("observer");
    expect(
      Gateway.Deliver.parse({
        ...delivery,
        actorContext: { ...actorContext, actorId: "a-7", trustTier: "collaborator" },
        requestContext: { requestId: "w-1", allowedAction: "report_result" },
      }).requestContext?.requestId,
    ).toBe("w-1");
    expect(Gateway.Deliver.parse(delivery).requestContext).toBeUndefined();
    expect(Gateway.Deliver.parse(delivery).actorContext?.actorId).toBeUndefined();
  });
  const { origin: _origin, ...withoutOrigin } = actorContext;
  test.each([
    ["top-level unknown field", { ...delivery, smuggled: true }],
    [
      "actor unknown field",
      { ...delivery, actorContext: { ...actorContext, conductOverride: "admin" } },
    ],
    [
      "request unknown field",
      {
        ...delivery,
        requestContext: { requestId: "w-1", allowedAction: "report_result", sessionPeek: true },
      },
    ],
    [
      "dropped treatment",
      { ...delivery, actorContext: { ...actorContext, inboundTreatment: "drop" } },
    ],
    [
      "invalid treatment",
      { ...delivery, actorContext: { ...actorContext, inboundTreatment: "root_access" } },
    ],
    [
      "invalid tier",
      { ...delivery, actorContext: { ...actorContext, trustTier: "manager_i_swear" } },
    ],
    ["missing taint origin", { ...delivery, actorContext: withoutOrigin }],
    ["missing recorded decision", { sessionId: "s-1", actorContext, event }],
  ])("rejects %s", (_name, input) => {
    expect(() => Gateway.Deliver.parse(input).actorContext?.actorId).toThrow(ZodError);
  });
  test("a parsed DeliveredEvent drops an extraneous embedded agent", () => {
    expect(
      Object.getOwnPropertyDescriptor(
        Gateway.DeliveredEvent.parse({
          ...event,
          agent: { model: { provider: "smuggler", id: "smuggled-model" } },
        }).valueOf(),
        "agent",
      ),
    ).toBeUndefined();
  });
});

describe("Gateway.SendInput", () => {
  const base = {
    messageId: "m-1",
    traceId: "t-1",
    senderId: "persona-1",
    target: { actorId: "seller-1" },
    payload: { kind: "message", parts: [{ kind: "text", text: "still available?" }] },
    at: 1_000,
  };
  const requestSpec = {
    requestId: "w-1",
    sessionId: "s-1",
    allowedActions: ["report_result"],
    expectedResponders: ["seller-1"],
    resolution: "first",
    deadline: 2_000,
    threshold: 1,
  };
  test.each([
    ["awaited without requestSpec", { ...base, operation: "awaited" }],
    ["fire_and_forget with requestSpec", { ...base, operation: "fire_and_forget", requestSpec }],
    ["converse with fire_and_forget", { ...base, operation: "fire_and_forget", class: "converse" }],
    ["notify with awaited", { ...base, operation: "awaited", class: "notify" }],
  ])("rejects %s", (_name, input) => {
    expect(() => Gateway.SendInput.parse(input)).toThrow(ZodError);
  });
  test("awaited with requestSpec and coherent class parses", () => {
    expect(Gateway.SendInput.parse({ ...base, operation: "awaited", requestSpec })).toMatchObject({
      requestSpec: { requestId: "w-1" },
    });
    expect(
      Gateway.SendInput.parse({ ...base, operation: "awaited", class: "converse", requestSpec })
        .class,
    ).toBe("converse");
  });
  test("class remains optional, and notify pairs with fire_and_forget", () => {
    expect(
      Gateway.SendInput.parse({ ...base, operation: "fire_and_forget" }).class,
    ).toBeUndefined();
    expect(
      Gateway.SendInput.parse({ ...base, operation: "fire_and_forget", class: "notify" }).class,
    ).toBe("notify");
  });
});

describe("Gateway.SocialBudget", () => {
  const base = {
    id: "budget-1",
    targetActorId: "seller-1",
    maxPerWindow: 3,
    windowMs: 86_400_000,
    cooldownMs: 3_600_000,
  };
  test("minimal and optional fields parse", () => {
    expect(Gateway.SocialBudget.parse(base).maxPerWindow).toBe(3);
    expect(
      Gateway.SocialBudget.parse({
        ...base,
        classCaps: { notify: 1, converse: 2 },
        quietHours: { startMinuteUtc: 1320, endMinuteUtc: 480 },
        doNotContact: false,
        expiresAt: 9_000,
      }),
    ).toMatchObject({ classCaps: { notify: 1 }, quietHours: { startMinuteUtc: 1320 } });
    expect(Gateway.SocialBudget.parse({ ...base, cooldownMs: 0 }).cooldownMs).toBe(0);
  });
  test.each([
    ["zero window maximum", { ...base, maxPerWindow: 0 }],
    ["zero window duration", { ...base, windowMs: 0 }],
    ["minute beyond day", { ...base, quietHours: { startMinuteUtc: 1440, endMinuteUtc: 0 } }],
    ["unknown field", { ...base, unexpected: true }],
  ])("rejects %s", (_name, input) => {
    expect(() => Gateway.SocialBudget.parse(input)).toThrow(ZodError);
  });
});

describe("Gateway.SenderTargetGrant", () => {
  const standing = {
    id: "g-1",
    senderId: "persona-1",
    targetActorId: "seller-1",
    operations: ["awaited"],
  };
  test("a standing grant parses, with or without an expiry", () => {
    expect(Gateway.SenderTargetGrant.parse(standing).expiresAt).toBeUndefined();
    expect(Gateway.SenderTargetGrant.parse({ ...standing, expiresAt: 2_000 }).expiresAt).toBe(
      2_000,
    );
  });
  // #1569: the reply to the conversation that prompted a turn is authorized by
  // the router's conversation binding, never by a rule-materialized grant; the
  // former `ruleId`/`replyScope` instance fields are gone.
  test.each([
    ["a rule id", { ...standing, ruleId: "r-1", expiresAt: 2_000 }],
    ["a reply scope", { ...standing, replyScope: { surfaceKey: "junggonara:chat:777" } }],
    ["no operations", { ...standing, operations: [] }],
  ])("rejects %s", (_name, input) => {
    expect(() => Gateway.SenderTargetGrant.parse(input)).toThrow(ZodError);
  });
});

describe("Gateway.OriginTarget", () => {
  test("names the delivered prompt and nothing else", () => {
    expect(Gateway.OriginTarget.parse({ kind: "origin", inReplyTo: "m-1" })).toEqual({
      kind: "origin",
      inReplyTo: "m-1",
    });
    expect(
      Gateway.SendMessage.parse({ to: { kind: "origin", inReplyTo: "m-1" }, type: "message", content: "pong" }).to,
    ).toEqual({ kind: "origin", inReplyTo: "m-1" });
  });
  test.each([
    ["an empty prompt id", { kind: "origin", inReplyTo: "" }],
    ["an extra key", { kind: "origin", inReplyTo: "m-1", conversation: { channelId: "C1" } }],
  ])("rejects %s", (_name, input) => {
    expect(() => Gateway.OriginTarget.parse(input)).toThrow(ZodError);
  });
  test("a Table B row may target the origin kind", () => {
    expect(
      Gateway.RuleTableB.parse({
        id: "message.resident.reply_unbound",
        table: "B",
        sender: "session",
        senderRole: "resident",
        targetKind: "origin",
        check: { kind: "actor_send" },
        effect: "deny",
      }).targetKind,
    ).toBe("origin");
  });
});

describe("Gateway.RequestSpec", () => {
  test("quorum coherence is enforced by Request.Record, not at spec level", () => {
    expect(
      Gateway.RequestSpec.parse({
        requestId: "w-1",
        sessionId: "s-1",
        allowedActions: ["report_result"],
        expectedResponders: ["a", "b"],
        resolution: "first",
        threshold: 1,
        deadline: 2_000,
      }).threshold,
    ).toBe(1);
  });
});
