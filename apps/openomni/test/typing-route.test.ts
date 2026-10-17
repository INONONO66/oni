import { expect, test } from "bun:test";
import type { ProviderTypingRoute } from "@openomni/channels";
import { typingRouteFor } from "../src/composition/typing-route";

const pulse = (name: string): ProviderTypingRoute => ({
  everyMs: 4_000,
  open: async (externalId) => ({ channelId: `${name}:${externalId}` }),
  pulse: async () => undefined,
});

test("#1600 lane R3: the pulse rides the bot, else the identity-less surface, else an auto-replying Owner account — never a drafting one", () => {
  const bot = pulse("slack:bot");
  const owner = pulse("slack:owner");
  const bare = pulse("ws");
  const igOwner = pulse("instagram:owner");
  const routes = new Map([
    ["slack:bot", bot],
    ["slack:owner", owner],
    ["ws", bare],
    ["instagram:owner", igOwner],
  ]);
  const autoReplying = typingRouteFor(routes, new Set(["instagram:owner", "slack:owner"]));
  expect(autoReplying("slack")).toBe(bot);
  expect(autoReplying("ws")).toBe(bare);
  expect(autoReplying("instagram")).toBe(igOwner);
  expect(autoReplying("telegram")).toBeUndefined();
  const drafting = typingRouteFor(routes, new Set());
  expect(drafting("instagram")).toBeUndefined();
  expect(drafting("slack")).toBe(bot);
});
