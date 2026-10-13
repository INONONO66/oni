import { expect, test } from "bun:test";
import { Ingress } from "../src/ingress/index.js";

const input = {
  eventId: "event-1",
  surface: "discord",
  channelId: "alerts",
  threadId: "thread-1",
  workspaceId: "workspace-1",
  author: { externalId: "user-1", isBot: true },
  dm: false,
  mentionsBot: true,
  body: "ready",
  receivedAt: 1_750_000_000_000,
};

for (const event of ["message", "reaction", "mention", "webhook", "github", "schedule"] as const) {
  test(`normalizes ${event} inputs without dropping fields`, () => {
    const value = {
      ...input, event,
      ...(event === "webhook" ? { secretRef: "secret:hook-1" } : {}),
      ...(event === "github" ? { githubEvent: "pull_request.opened" } : {}),
    };
    expect(Ingress.Input.parse(value)).toEqual(value);
  });
}

test("rejects unknown input and author fields", () => {
  expect(Ingress.Input.safeParse({ ...input, event: "reaction", payload: "raw" }).success).toBe(false);
  expect(
    Ingress.Input.safeParse({ ...input, event: "reaction", author: { ...input.author, name: "x" } })
      .success,
  ).toBe(false);
});

test("rejects missing identity and unsupported events", () => {
  expect(Ingress.Input.safeParse({ ...input, event: "edit" }).success).toBe(false);
  expect(Ingress.Input.safeParse({ ...input, event: "message", author: { isBot: false } }).success).toBe(false);
});
