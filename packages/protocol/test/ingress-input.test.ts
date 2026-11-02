import { expect, test } from "bun:test";
import { Ingress } from "../src/ingress/index.js";

const input = {
  eventId: "event-1",
  surface: "discord",
  instance: "channel:discord:main",
  channelId: "alerts",
  threadId: "thread-1",
  workspaceId: "workspace-1",
  author: { externalId: "user-1", isBot: true },
  from: "user-1", addressees: [], payload: {},
  dm: false,
  addressed: true,
  render: "ready",
  receivedAt: 1_750_000_000_000,
};

for (const event of ["message", "reaction", "postback", "mention", "webhook", "github", "schedule"] as const) {
  test(`normalizes ${event} inputs without dropping fields`, () => {
    const value = {
      ...input, event,
      ...(event === "webhook" ? { secretRef: "secret:hook-1" } : {}),
      ...(event === "github" ? { githubEvent: "pull_request.opened" } : {}),
    };
    expect(Ingress.Message.parse(value)).toEqual(value);
  });
}

test("rejects unknown input and author fields", () => {
  expect(Ingress.Message.safeParse({ ...input, event: "reaction", unexpected: "raw" }).success).toBe(false);
  expect(
    Ingress.Message.safeParse({ ...input, event: "reaction", author: { ...input.author, name: "x" } })
      .success,
  ).toBe(false);
});

test("rejects missing identity and unsupported events", () => {
  expect(Ingress.Message.safeParse({ ...input, event: "edit" }).success).toBe(false);
  expect(Ingress.Message.safeParse({ ...input, event: "message", author: { isBot: false } }).success).toBe(false);
});
