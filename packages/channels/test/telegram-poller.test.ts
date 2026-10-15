import { describe, expect, it } from "bun:test";
import { injectedOptions } from "./helpers/injected";
import { z } from "zod";
import { TelegramPoller } from "../src/provider/telegram/poller";
import type { TelegramMessage, TelegramUpdate } from "../src/provider/telegram/types";

function message(updateId: number): TelegramMessage {
  return {
    message_id: updateId + 90,
    from: { id: 7, is_bot: false, first_name: "Ada" },
    chat: { id: 7, type: "private" },
    date: 1,
    text: `update ${updateId}`,
  };
}

describe("TelegramPoller checkpoints", () => {
  it("acknowledges a callback before handoff and delivers despite a refused ack", async () => {
    const calls: string[] = [];
    const updates: TelegramUpdate[] = [
      { update_id: 1, callback_query: {
        id: "tap-1", data: "approve",
        from: { id: 7, is_bot: false, first_name: "Ada" }, message: message(1),
      } },
      { update_id: 2, callback_query: {
        id: "tap-2", data: "reject",
        from: { id: 7, is_bot: false, first_name: "Ada" }, message: message(2),
      } },
    ];
    const offsets: number[] = [];
    const warns: string[] = [];
    const poller = new TelegramPoller({
      async getUpdates(offset) {
        offsets.push(offset);
        return updates.filter((update) => update.update_id >= offset);
      },
      async answerCallbackQuery(id) {
        calls.push(`ack:${id}`);
        if (id === "tap-2") throw new Error("ack rejected");
      },
    }, {
      onMessage(incoming) {
        if ("id" in incoming) calls.push(`handoff:${incoming.id}`);
      },
    }, (_event, data) => {
      warns.push(z.object({ msg: z.string() }).parse(data).msg);
    }, injectedOptions());

    await poller.pollOnce("callbacks");
    await poller.pollOnce("after-callbacks");

    expect(calls).toEqual(["ack:tap-1", "handoff:tap-1", "ack:tap-2", "handoff:tap-2"]);
    expect(warns).toEqual(["telegram callback acknowledgment failed; delivering anyway"]);
    expect(offsets).toEqual([0, 3]);
  });
  it("redelivers a callback after a failed handoff even when its second ack is rejected", async () => {
    const callback: TelegramUpdate = { update_id: 5, callback_query: {
      id: "tap-5", data: "approve", from: { id: 7, is_bot: false, first_name: "Ada" },
      message: message(5),
    } };
    const offsets: number[] = [];
    const calls: string[] = [];
    const delivered: string[] = [];
    const warnings: string[] = [];
    let firstHandoff = true;
    let firstAck = true;
    const poller = new TelegramPoller({
      async getUpdates(offset) {
        offsets.push(offset);
        return offset <= callback.update_id ? [callback] : [];
      },
      async answerCallbackQuery(id) {
        calls.push(`ack:${id}`);
        if (!firstAck) throw new Error("callback already answered");
        firstAck = false;
      },
    }, {
      onMessage(incoming) {
        if (!("id" in incoming)) return;
        calls.push(`handoff:${incoming.id}`);
        if (firstHandoff) {
          firstHandoff = false;
          throw new Error("handoff failed");
        }
        delivered.push(incoming.id);
      },
    }, (_event, data) => {
      warnings.push(z.object({ msg: z.string() }).parse(data).msg);
    }, injectedOptions());

    await expect(poller.pollOnce("first")).rejects.toThrow("handoff failed");
    await poller.pollOnce("retry");
    await poller.pollOnce("after");

    expect(calls).toEqual(["ack:tap-5", "handoff:tap-5", "ack:tap-5", "handoff:tap-5"]);
    expect(delivered).toEqual(["tap-5"]);
    expect(offsets).toEqual([0, 0, 6]);
    expect(warnings).toEqual(["telegram callback acknowledgment failed; delivering anyway"]);
  });
  it("hands off a media-only update before advancing its offset", async () => {
    const updates: TelegramUpdate[] = [
      { update_id: 5, message: { ...message(5), text: undefined, photo: [{ file_id: "photo-5" }] } },
      // A frame with nothing to render reaches the normalizer too; it, not the poller, decides.
      { update_id: 6, message: { ...message(6), text: undefined } },
    ];
    const offsets: number[] = [];
    const received: string[] = [];
    const poller = new TelegramPoller({
      async getUpdates(offset: number) {
        offsets.push(offset);
        return updates.filter((update) => update.update_id >= offset);
      },
      async answerCallbackQuery() { return; },
    }, {
      onMessage: (incoming) => {
        if ("new_reaction" in incoming || "id" in incoming) return;
        received.push(incoming.photo?.[0]?.file_id ?? "");
      },
    }, () => undefined, injectedOptions());

    await poller.pollOnce("media");
    await poller.pollOnce("after-media");

    expect(received).toEqual(["photo-5", ""]);
    expect(offsets).toEqual([0, 7]);
  });
  it("resumes at a failed handoff without skipping later updates", async () => {
    const batch: TelegramUpdate[] = [
      { update_id: 10 },
      { update_id: 11, message: message(11) },
      { update_id: 12, message: message(12) },
    ];
    const requestedOffsets: number[] = [];
    const client = {
      async getUpdates(offset: number): Promise<TelegramUpdate[]> {
        requestedOffsets.push(offset);
        return batch.filter((update) => update.update_id >= offset);
      },
      async answerCallbackQuery() { return; },
    };
    const handedOff: number[] = [];
    let fail = true;
    const poller = new TelegramPoller(
      client,
      {
        onMessage: async (telegramMessage) => {
          if ("id" in telegramMessage) return;
          handedOff.push(telegramMessage.message_id);
          if (fail) {
            fail = false;
            throw new Error("handoff failed");
          }
        },
      },
      () => undefined,
      injectedOptions(),
    );

    await expect(poller.pollOnce("trace-failed-batch")).rejects.toThrow("handoff failed");

    await poller.pollOnce("trace-retry-batch");
    await poller.pollOnce("trace-after-success");

    // update 10 is non-deliverable and checkpoints in order; failure at 11
    // prevents 12 from being touched until 11 succeeds on the next cycle.
    expect(requestedOffsets).toEqual([0, 11, 13]);
    expect(handedOff).toEqual([101, 101, 102]);
  });
});
