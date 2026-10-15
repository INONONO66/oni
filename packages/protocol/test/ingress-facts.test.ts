import { expect, test } from "bun:test";
import { Gateway } from "../src/gateway/index.js";

const base = {
  eventId: "event-1",
  surface: "discord",
  channelId: "alerts",
  addressees: [],
  dm: false,
  payload: { id: "raw" },
  render: "message text",
};

for (const event of ["message", "reaction", "postback", "mention", "webhook", "github", "schedule"] as const) {
  test(`accepts ${event} with a bot author`, () => {
    const facts = { ...base, event, author: { externalId: "user-1", isBot: true } };
    expect(Gateway.IngressFacts.parse(facts)).toEqual(facts);
  });
}

test("legacy driver facts still parse without author or event", () => {
  expect(Gateway.IngressFacts.parse(base)).toEqual(base);
});

test("postback preserves button identity and refuses extra or empty fields", () => {
  const facts = { ...base, event: "postback" as const, render: "Approve", postback: {
    id: "approve", label: "Approve", messageRef: "message-1",
  } };
  expect(Gateway.IngressFacts.parse(facts)).toEqual(facts);
  expect(Gateway.IngressFacts.safeParse({ ...facts, postback: { id: "approve", label: "Approve" } }).success).toBe(true);
  expect(Gateway.IngressFacts.safeParse({ ...facts, postback: { ...facts.postback, extra: true } }).success).toBe(false);
  expect(Gateway.IngressFacts.safeParse({ ...facts, postback: { ...facts.postback, id: "" } }).success).toBe(false);
  expect(Gateway.IngressFacts.safeParse({ ...facts, postback: { ...facts.postback, label: "" } }).success).toBe(false);
  expect(Gateway.IngressFacts.safeParse({ ...facts, postback: { ...facts.postback, messageRef: "" } }).success).toBe(false);
});

test("rejects invalid event, bot flag, and additional author keys", () => {
  expect(Gateway.IngressFacts.safeParse({ ...base, event: "edit" }).success).toBe(false);
  expect(Gateway.IngressFacts.safeParse({ ...base, author: { externalId: "u", isBot: "yes" } }).success).toBe(false);
  expect(Gateway.IngressFacts.safeParse({ ...base, author: { externalId: "u", isBot: false, name: "x" } }).success).toBe(false);
});
