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

for (const event of ["message", "reaction", "mention"] as const) {
  test(`accepts ${event} with a bot author`, () => {
    const facts = { ...base, event, author: { externalId: "user-1", isBot: true } };
    expect(Gateway.IngressFacts.parse(facts)).toEqual(facts);
  });
}

test("legacy driver facts still parse without author or event", () => {
  expect(Gateway.IngressFacts.parse(base)).toEqual(base);
});

test("rejects invalid event, bot flag, and additional author keys", () => {
  expect(Gateway.IngressFacts.safeParse({ ...base, event: "webhook" }).success).toBe(false);
  expect(Gateway.IngressFacts.safeParse({ ...base, author: { externalId: "u", isBot: "yes" } }).success).toBe(false);
  expect(Gateway.IngressFacts.safeParse({ ...base, author: { externalId: "u", isBot: false, name: "x" } }).success).toBe(false);
});
