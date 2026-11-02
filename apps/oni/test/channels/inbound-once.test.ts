import { describe, expect, test } from "bun:test";
import type { Channel } from "@oni/protocol";
import { inboundOnce } from "../../../../packages/channels/src/support/inbound-once.js";
import { bounded } from "../../../../packages/channels/test/helpers/bounded.js";

function message(eventId: string, receivedBy: "bot" | "owner", channelId = "C1"): Channel.InboundMessage {
  return {
    sender: { kind: "external", surface: "slack", externalId: "T1:U7" },
    facts: {
      eventId,
      surface: "slack",
      instance: `channel:slack:${receivedBy}`,
      workspaceId: "T1",
      channelId,
      addressees: [],
      dm: false,
      receivedBy,
      payload: {},
      render: "hi",
    },
  };
}

describe("inboundOnce: one physical message reaches routing once across instances (#1569 lane 6)", () => {
  test("equal event ids in different workspaces are independent, but a workspace redelivery is deduplicated", async () => {
    const seen: string[] = [];
    const once = inboundOnce(async (inbound) => { seen.push(inbound.facts.instance ?? "missing"); });
    for (const workspaceId of ["east", "west", "west"]) {
      const inbound = message("same-event", "bot");
      await once({ ...inbound, facts: { ...inbound.facts, workspaceId, instance: `channel:slack:${workspaceId}` } });
    }
    expect(seen).toEqual(["channel:slack:east", "channel:slack:west"]);
  });

  test("the second instance's copy of an admitted message is dropped; a different message or channel is not", async () => {
    const seen: string[] = [];
    const once = inboundOnce(async (inbound) => {
      seen.push(`${inbound.facts.receivedBy}:${inbound.facts.channelId}:${inbound.facts.eventId}`);
    });
    await once(message("1700.1", "bot"));
    await once(message("1700.1", "owner"));
    await once(message("1700.2", "owner"));
    await once(message("1700.1", "owner", "C2"));
    expect(seen).toEqual(["bot:C1:1700.1", "owner:C1:1700.2", "owner:C2:1700.1"]);
  });

  test("a refused handoff lets the next copy carry the message; an admitted one does not", async () => {
    let attempts = 0;
    const once = inboundOnce(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("admission refused");
    });
    await expect(once(message("1700.3", "bot"))).rejects.toThrow("admission refused");
    await once(message("1700.3", "owner"));
    await once(message("1700.3", "owner"));
    expect(attempts).toBe(2);
  });

  test("a copy arriving while the other instance's copy is in flight waits: it carries the message only if that copy was refused", async () => {
    const carried: string[] = [];
    const outcomes = new Map<string, Promise<void>>();
    const gates = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
    const accountEntered = Promise.withResolvers<void>();
    const once = inboundOnce(async (inbound) => {
      const gate = Promise.withResolvers<void>();
      gates.set(inbound.facts.receivedBy ?? "bot", gate);
      if (inbound.facts.receivedBy === "owner") accountEntered.resolve();
      await gate.promise;
      carried.push(inbound.facts.receivedBy ?? "bot");
    });
    // The bot's copy of an Account mention is in flight; the Account's copy arrives.
    outcomes.set("bot", once(message("1700.4", "bot")));
    outcomes.set("owner", once(message("1700.4", "owner")));
    expect(gates.has("owner")).toBe(false);
    // The bot's copy is refused (a mention-only posture): the Account's copy now carries the message.
    gates.get("bot")?.reject(new Error("mention_only"));
    await expect(outcomes.get("bot")).rejects.toThrow("mention_only");
    await bounded(accountEntered.promise);
    expect(gates.has("owner")).toBe(true);
    gates.get("owner")?.resolve();
    await outcomes.get("owner");
    expect(carried).toEqual(["owner"]);
    // The other order: the first copy is admitted, the waiting copy is dropped.
    gates.clear();
    const first = once(message("1700.5", "owner"));
    const second = once(message("1700.5", "bot"));
    gates.get("owner")?.resolve();
    await first;
    await second;
    expect(gates.has("bot")).toBe(false);
    expect(carried).toEqual(["owner", "owner"]);
  });

  test("the window is bounded: the oldest admitted key leaves when the capacity is exceeded", async () => {
    const seen: string[] = [];
    const once = inboundOnce(async (inbound) => {
      seen.push(inbound.facts.eventId);
    }, 2);
    await once(message("a", "bot"));
    await once(message("b", "bot"));
    await once(message("c", "bot"));
    await once(message("a", "owner"));
    expect(seen).toEqual(["a", "b", "c", "a"]);
  });
});
