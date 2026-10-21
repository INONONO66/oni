import { ledger, resetLedger } from "../helpers/ledger";
import { sessionTree } from "../../../agent/test/store/helpers/session-tree";
import { runEffect } from "../helpers/effect";
import { beforeEach, expect, test } from "bun:test";
import { SessionTransition } from "@oni/protocol";
import { answer, command, openRequest, requestPort } from "../helpers/requests";
import { requestFixture } from "../helpers/request-record";

beforeEach(() => {
  resetLedger();
});

test.each([
  "first",
  "quorum",
  "all",
] as const)("%s resolves only at its distinct-responder threshold", async (resolution: "first" | "quorum" | "all") => {
  const threshold = resolution === "first" ? 1 : resolution === "quorum" ? 2 : 3;
  await runEffect(await openRequest("original", { expectedResponders: ["a", "b", "c"], resolution, threshold }));
  for (const [index, responder] of ["a", "b", "c"].slice(0, threshold).entries()) {
    expect(await runEffect(answer("original", responder, `reply-${index}`, 2 + index))).toBe(
      index + 1 === threshold ? "resolved" : "attached",
    );
  }
  const stored = ledger().kernel.requestById("original");
  expect(stored?.replies).toHaveLength(threshold);
  expect(stored?.sessionId).toBe("request-owner");
  expect(
    sessionTree("request-owner", ledger().sessions.actions).filter(
      (action) => action.id === "original:resolution",
    ),
  ).toHaveLength(1);
});

test("same reply and same responder never advance the request twice", async () => {
  await runEffect(await openRequest("original", {
    expectedResponders: ["a", "b"],
    resolution: "all",
    threshold: 2,
  }));
  expect(await runEffect(answer("original", "a", "reply-a", 2))).toBe("attached");
  const before = sessionTree("request-owner", ledger().sessions.actions);
  expect(await runEffect(answer("original", "a", "reply-a", 2))).toBe("attached");
  expect(sessionTree("request-owner", ledger().sessions.actions)).toEqual(before);
  expect(await runEffect(answer("original", "a", "reply-a-new", 3))).toBe("duplicate");
  expect(ledger().kernel.requestById("original")?.replies).toHaveLength(1);
});

test("unknown responder is rejected without attaching", async () => {
  await runEffect(await openRequest("original"));
  expect(await runEffect(answer("original", "stranger", "reply", 2))).toBe("rejected");
  expect(ledger().kernel.requestById("original")?.replies).toEqual([]);
});

test.each([0, 1])("timeout keeps %s partial replies in original action history", async (count: number) => {
  await runEffect(await openRequest("original", {
    expectedResponders: ["a", "b"],
    resolution: "all",
    threshold: 2,
    deadline: 10,
  }));
  if (count) await runEffect(answer("original", "a", "early", 2));
  expect(
    (await command("original", { kind: "request.timeout", requestId: "original" }, 9)).resolution,
  ).toBe("rejected");
  expect(
    (await command("original", { kind: "request.timeout", requestId: "original" }, 10)).resolution,
  ).toBe("expired");
  expect(ledger().kernel.requestById("original")).toMatchObject({
    state: "expired",
    outcome: "outcome_unknown",
  });
  expect(ledger().kernel.requestById("original")?.replies).toHaveLength(count);
});

test("cancellation preserves partial replies and cannot be reversed by late input", async () => {
  await runEffect(await openRequest("original", {
    expectedResponders: ["a", "b"],
    resolution: "all",
    threshold: 2,
  }));
  await runEffect(answer("original", "a", "early", 2));
  expect(
    (await command(
      "original",
      {
        kind: "request.cancel",
        requestId: "original",
        principal: { kind: "actor", principalId: "a", evidenceId: "external" },
      },
      3,
    )).resolution,
  ).toBe("rejected");
  expect(
    (await command(
      "original",
      {
        kind: "request.cancel",
        requestId: "original",
        principal: { kind: "session", principalId: "request-owner", evidenceId: "session" },
      },
      4,
    )).resolution,
  ).toBe("cancelled");
  expect(await runEffect(answer("original", "b", "late", 5))).toBe("duplicate");
  expect(ledger().kernel.requestById("original")).toMatchObject({
    state: "cancelled",
    replies: [{ replyId: "early" }],
  });
});

test.each([10, 11])("answer at %s cannot cross the deadline", async (at: number) => {
  await runEffect(await openRequest("original", { deadline: 10 }));
  expect(await runEffect(answer("original", "actor-external-child", "late", at))).toBe("late_unknown");
  expect(ledger().kernel.requestById("original")?.replies).toEqual([]);
  expect(ledger().kernel.requestById("original")?.state).toBe("expired");
});

test("resolved request cannot reopen for supplementary replies", async () => {
  await runEffect(await openRequest("original"));
  expect(await runEffect(answer("original", "actor-external-child", "first", 2))).toBe("resolved");
  expect(await runEffect(answer("original", "actor-external-child", "second", 3))).toBe("duplicate");
  expect(ledger().kernel.requestById("original")?.replies).toHaveLength(1);
});

test.each([
  "accepted",
  "rejected",
  "unknown",
] as const)("physical %s receipt preserves its value in request action history", async (value: "accepted" | "rejected" | "unknown") => {
  await runEffect(await openRequest("original"));
  const port = requestPort();
  const receipt = {
    inputId: "receipt",
    requestId: "original",
    sessionId: "request-owner",
    sourceActionId: "original",
    externalMessageId: "platform",
    value,
    at: 2,
  };
  await runEffect(port.receipt(receipt));
  const before = sessionTree("request-owner", ledger().sessions.actions);
  await runEffect(port.receipt(receipt));
  expect(sessionTree("request-owner", ledger().sessions.actions)).toEqual(before);
  expect(
    before.find((action) => action.id === "original:input:receipt")?.effect.value,
  ).toMatchObject({ receipt });
  expect(ledger().kernel.requestById("original")?.correlation.replyToMessageId).toBe("platform");
  expect(ledger().kernel.requestById("original")?.state).toBe("open");
});

test.each([
  { expectedResponders: ["a", "a"] },
  { resolution: "quorum", threshold: 2 },
  { resolution: "all", expectedResponders: ["a", "b"], threshold: 1 },
  { resolution: "first", threshold: 2 },
  { state: "resolved", outcome: null },
] as const)("request schema rejects incoherent bounds or terminal state %#", (overrides) => {
  expect(SessionTransition.Request.safeParse({ ...requestFixture(), ...overrides }).success).toBe(
    false,
  );
});
