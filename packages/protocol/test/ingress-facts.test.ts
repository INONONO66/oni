import { expect, test } from "bun:test";
import { Ingress } from "../src/ingress/index.js";

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
    expect(Ingress.Message.parse(facts)).toEqual(facts);
  });
}

test("legacy driver facts still parse without author or event", () => {
  expect(Ingress.Message.parse(base)).toEqual(base);
});

test("postback preserves button identity and refuses extra or empty fields", () => {
  const facts = { ...base, event: "postback" as const, render: "Approve", postback: {
    id: "approve", label: "Approve", messageRef: "message-1",
  } };
  expect(Ingress.Message.parse(facts)).toEqual(facts);
  expect(Ingress.Message.safeParse({ ...facts, postback: { id: "approve", label: "Approve" } }).success).toBe(true);
  expect(Ingress.Message.safeParse({ ...facts, postback: { ...facts.postback, extra: true } }).success).toBe(false);
  expect(Ingress.Message.safeParse({ ...facts, postback: { ...facts.postback, id: "" } }).success).toBe(false);
  expect(Ingress.Message.safeParse({ ...facts, postback: { ...facts.postback, label: "" } }).success).toBe(false);
  expect(Ingress.Message.safeParse({ ...facts, postback: { ...facts.postback, messageRef: "" } }).success).toBe(false);
});

test("rejects invalid event, bot flag, and additional author keys", () => {
  expect(Ingress.Message.safeParse({ ...base, event: "edit" }).success).toBe(false);
  expect(Ingress.Message.safeParse({ ...base, author: { externalId: "u", isBot: "yes" } }).success).toBe(false);
  expect(Ingress.Message.safeParse({ ...base, author: { externalId: "u", isBot: false, name: "x" } }).success).toBe(false);
});
