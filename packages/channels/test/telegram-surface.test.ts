import { afterEach, describe, expect, it } from "bun:test";
import { type Channel, Operational } from "@oni/protocol";
import { z } from "zod";
import { createTelegramProvider } from "../src/provider/telegram/provider";
import { TELEGRAM_ALLOWED_UPDATES, TelegramBotError } from "../src/provider/telegram/sdk";
import { TelegramAdapter } from "../src/provider/telegram/surface";
import { RECONNECT_ATTEMPT_BOUND } from "../src/support/sdk-listener";
import type { PublishPort } from "../src/types";
import { bounded } from "./helpers/bounded";
import { injectedOptions } from "./helpers/injected";
import { FakeTelegramListener, ME, fakeTelegramSdk } from "./helpers/telegram-sdk";

const noopPublish: PublishPort = () => undefined;
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const message = (
  message_id: number,
  chatId: number,
  text: string,
  from = { id: 7, is_bot: false, first_name: "Ann" },
) => ({
  message_id,
  from,
  chat: { id: chatId, type: "private" },
  date: 1,
  text,
});

/** One inline-button tap on a message the bot posted. */
const callback = (id: string) => ({
  id,
  from: { id: 7, is_bot: false, first_name: "Ann" },
  data: "approve",
  message: {
    ...message(50, 111, "Approve?", { id: ME.user.id, is_bot: true, first_name: "Omni" }),
    reply_markup: { inline_keyboard: [[{ text: "Approve", callback_data: "approve" }]] },
  },
});

/** One started adapter over the scripted SDK listener, with an inbound queue. */
async function started(publish: PublishPort = noopPublish, listener?: FakeTelegramListener) {
  const fake = fakeTelegramSdk(listener);
  const adapter = new TelegramAdapter("token", {}, publish, injectedOptions(), fake.sdk);
  const inbound: Channel.InboundMessage[] = [];
  const waiters: Array<(message: Channel.InboundMessage) => void> = [];
  const next = () => {
    const waiter = Promise.withResolvers<Channel.InboundMessage>();
    waiters.push(waiter.resolve);
    return bounded(waiter.promise);
  };
  adapter.onMessage(async (message) => {
    inbound.push(message);
    waiters.shift()?.(message);
  });
  await adapter.start("boot");
  return { ...fake, adapter, inbound, next };
}

describe("TelegramAdapter over the agent-messenger long-poll listener", () => {
  it("logs in with the bot token, declares the consumed updates, and binds the bot identity on connected", async () => {
    const infos: string[] = [];
    const { client, listener, next, adapter } = await started((event, data) => {
      if (event.name === Operational.Events.Info.name)
        infos.push(z.object({ msg: z.string() }).parse(data).msg);
    });
    expect(client.logins).toEqual(["token"]);
    expect(listener.allowedUpdates).toEqual(TELEGRAM_ALLOWED_UPDATES);
    expect(listener.started).toBe(1);
    expect(infos).toContain("telegram bot started");
    const facts = next();
    listener.update({
      update_id: 1,
      message: {
        ...message(100, 111, "@omni_bot hello"),
        entities: [{ type: "mention", offset: 0, length: 9 }],
      },
    });
    expect(await facts).toMatchObject({
      sender: { kind: "external", externalId: "7" },
      facts: {
        eventId: "100",
        channelId: "111",
        event: "mention",
        dm: true,
        render: "@omni_bot hello",
      },
    });
    adapter.stop("stop");
    expect(listener.stopped).toBe(1);
  });

  it("drops the bot's own echo and delivers a reaction as facts", async () => {
    const { listener, next, inbound } = await started();
    listener.update({
      update_id: 2,
      message: message(101, 111, "my own post", {
        id: ME.user.id,
        is_bot: true,
        first_name: "Omni",
      }),
    });
    const facts = next();
    listener.update({
      update_id: 3,
      message_reaction: {
        chat: { id: 111, type: "private" },
        message_id: 100,
        user: { id: 7, is_bot: false, first_name: "Ann" },
        date: 2,
        new_reaction: [{ type: "emoji", emoji: "👍" }],
      },
    });
    expect(await facts).toMatchObject({
      sender: { externalId: "7" },
      facts: { event: "reaction", render: "👍", eventId: "100:👍:7" },
    });
    expect(inbound).toHaveLength(1);
  });

  /**
   * D1: telegram message_id is a PER-CHAT counter, so two different chats can
   * legitimately share one id inside the dedupe window. The surface keys
   * dedupe on `${chat.id}:${message_id}` — keying on the bare message_id
   * silently dropped the second chat's message with no trace.
   */
  it("delivers the same message_id from two chats as two events (no cross-chat collision)", async () => {
    const { listener, inbound, next } = await started();
    const first = next();
    listener.update({ update_id: 4, message: message(100, 111, "one") });
    await first;
    const second = next();
    listener.update({ update_id: 5, message: message(100, 222, "two") });
    await second;
    expect(inbound.map((entry) => entry.facts.channelId).sort()).toEqual(["111", "222"]);
  });

  it("hands off a media-only update as attachment facts", async () => {
    const { listener, next } = await started();
    const facts = next();
    const { text: _text, ...bare } = message(102, 111, "");
    listener.update({ update_id: 11, message: { ...bare, photo: [{ file_id: "photo-5" }] } });
    expect(await facts).toMatchObject({
      facts: { eventId: "102", render: "", attachments: [{ kind: "image", ref: "photo-5" }] },
    });
  });

  it("answers a callback through the API before handoff and still delivers when the answer is refused", async () => {
    const warns: string[] = [];
    const { client, listener, next } = await started((event, data) => {
      if (event.name === Operational.Events.Warn.name)
        warns.push(z.object({ msg: z.string() }).parse(data).msg);
    });
    const first = next();
    listener.update({ update_id: 6, callback_query: callback("accepted") });
    expect(await first).toMatchObject({
      facts: {
        event: "postback",
        render: "Approve",
        postback: { id: "approve", label: "Approve", messageRef: "50" },
      },
    });
    const second = next();
    client.fail("answerCallbackQuery", new TelegramBotError("query is too old", "api_error", { httpStatus: 400 }));
    listener.update({ update_id: 7, callback_query: callback("refused") });
    expect((await second).facts.eventId).toBe("refused");
    expect(client.calls.filter(({ method }) => method === "answerCallbackQuery")).toHaveLength(2);
    expect(warns).toEqual(["telegram callback acknowledgment failed; delivering anyway"]);
  });

  it("a callback whose answer is still in flight at stop() still hands off: the SDK has already confirmed the update", async () => {
    const { listener, adapter, next, inbound } = await started();
    const facts = next();
    listener.update({ update_id: 10, callback_query: callback("late") });
    adapter.stop("stop");
    expect(listener.stopped).toBe(1);
    expect((await facts).facts.eventId).toBe("late");
    expect(inbound).toHaveLength(1);
  });

  it("warns and drops a malformed update, and releases a failed handoff for the dedupe", async () => {
    const warns: string[] = [];
    const errors: string[] = [];
    let attempts = 0;
    const failed = Promise.withResolvers<void>();
    const fake = fakeTelegramSdk();
    const adapter = new TelegramAdapter(
      "token",
      {},
      (event, data) => {
        const { msg } = z.object({ msg: z.string() }).parse(data);
        if (event.name === Operational.Events.Warn.name) warns.push(msg);
        if (event.name === Operational.Events.Error.name) {
          errors.push(msg);
          if (msg === "telegram message handling failed") failed.resolve();
        }
      },
      injectedOptions(),
      fake.sdk,
    );
    const retried = Promise.withResolvers<void>();
    adapter.onMessage(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("store refused");
      retried.resolve();
    });
    await adapter.start("boot");
    fake.listener.update({ nope: true });
    expect(warns).toEqual(["telegram update malformed; dropped"]);
    fake.listener.update({ update_id: 8, message: message(300, 111, "again") });
    await bounded(failed.promise);
    expect(errors).toEqual(["telegram message handling failed"]);
    // The dedupe claim was released: the same message handed off again reaches the handler.
    fake.listener.update({ update_id: 8, message: message(300, 111, "again") });
    await bounded(retried.promise);
    expect(attempts).toBe(2);
  });

  it("fails start on an error before connected and leaves no listener behind", async () => {
    const listener = new FakeTelegramListener((self) => {
      self.emit("error", new TelegramBotError("Unauthorized: bad token", "unauthorized"));
    });
    const fake = fakeTelegramSdk(listener);
    const adapter = new TelegramAdapter("token", {}, noopPublish, injectedOptions(), fake.sdk);
    adapter.onMessage(async () => undefined);
    await expect(adapter.start("boot")).rejects.toMatchObject({ code: "unauthorized" });
    expect(listener.stopped).toBe(1);
  });

  it("a poll-failure streak is reported unreachable once and keeps polling; a terminal code is a typed dead surface", async () => {
    const seen: { level: string; msg: string; failures?: number }[] = [];
    const { listener } = await started((event, data) => {
      const parsed = z
        .object({
          msg: z.string(),
          context: z.object({ failures: z.number().optional() }).optional(),
        })
        .parse(data);
      seen.push({
        level: event.name,
        msg: parsed.msg,
        ...(parsed.context?.failures === undefined ? {} : { failures: parsed.context.failures }),
      });
    });
    const cycles = RECONNECT_ATTEMPT_BOUND + 15;
    for (let cycle = 0; cycle < cycles; cycle += 1) listener.emit("disconnected");
    expect(listener.stopped).toBe(0);
    expect(
      seen.filter((entry) => entry.msg === "telegram poll closed, sdk reconnecting"),
    ).toHaveLength(cycles - 1);
    expect(seen.filter((entry) => entry.level === Operational.Events.Error.name)).toEqual([
      {
        level: Operational.Events.Error.name,
        msg: `telegram poll unreachable: ${RECONNECT_ATTEMPT_BOUND} failures without a reconnect`,
        failures: RECONNECT_ATTEMPT_BOUND,
      },
    ]);
    expect(seen.at(-1)?.failures).toBe(cycles);
    listener.emit("error", new TelegramBotError("Conflict: another poller", "conflict"));
    expect(listener.stopped).toBe(1);
    expect(seen.filter((entry) => entry.level === Operational.Events.Error.name).at(-1)).toEqual({
      level: Operational.Events.Error.name,
      msg: "telegram poll dead: Conflict: another poller",
    });
  });

  it("the provider builds the same surface over an injected seam with a typing route", async () => {
    const fake = fakeTelegramSdk();
    const runtime = createTelegramProvider(fake.sdk).create(
      { token: "token" },
      {},
      noopPublish,
      injectedOptions(),
    );
    runtime.surface.onMessage(async () => undefined);
    await runtime.surface.start("boot");
    expect(fake.client.logins).toEqual(["token"]);
    expect(runtime.typingRoute).toBeDefined();
    runtime.surface.stop("stop");
  });
});
