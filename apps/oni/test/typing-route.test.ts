import { expect, test } from "bun:test";
import type { ProviderTypingRoute } from "@oni/channels";
import type { Channel } from "@oni/protocol";
import { typingRouteFor } from "../src/composition/typing-route";

const pulse = (name: string): ProviderTypingRoute => ({
  everyMs: 4_000,
  open: async (externalId) => ({ channelId: `${name}:${externalId}` }),
  pulse: async () => undefined,
});

test("the pulse rides the receiving instance and never substitutes a sibling or a drafting Owner", () => {
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
  const instances = new Map<string, Channel.Instance>([
    ["slack:bot", { platform: "slack", identity: "bot" }],
    ["slack:owner", { platform: "slack", identity: "owner" }],
    ["ws", { platform: "ws", identity: "bot" }],
    ["instagram:owner", { platform: "instagram", identity: "owner" }],
  ]);
  const autoReplying = typingRouteFor(routes, new Set(["instagram:owner", "slack:owner"]), instances);
  expect(autoReplying("slack:bot")).toBe(bot);
  expect(autoReplying("slack:owner")).toBe(owner);
  expect(autoReplying("ws")).toBe(bare);
  expect(autoReplying("instagram:owner")).toBe(igOwner);
  expect(autoReplying("telegram")).toBeUndefined();
  const drafting = typingRouteFor(routes, new Set(), instances);
  expect(drafting("instagram:owner")).toBeUndefined();
  expect(drafting("slack:bot")).toBe(bot);
  expect(drafting("slack")).toBeUndefined();
});
