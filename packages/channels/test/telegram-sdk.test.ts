import { describe, expect, test } from "bun:test";
import { TelegramBotClient, TelegramBotListener } from "../src/provider/telegram/sdk";
import {
  isTelegramTerminal,
  TELEGRAM_ALLOWED_UPDATES,
  TelegramBotError,
  telegramSdk,
} from "../src/provider/telegram/sdk";
import { bounded } from "./helpers/bounded";

/**
 * Pins the SDK facts the Telegram surface relies on (#1569): the default seam
 * builds the real client and listener without I/O, the consumed update
 * classes include reactions and reach the first `getUpdates` on the wire,
 * and the real listener reports a refused `deleteWebhook`/`getMe` as an
 * `error` event (then stops) instead of hanging.
 */
describe("agent-messenger telegram bot SDK seam", () => {
  test("the default seam builds the real client and listener (no I/O)", async () => {
    const sdk = telegramSdk();
    const client = sdk.client();
    expect(client).toBeInstanceOf(TelegramBotClient);
    await client.login({ token: "offline" });
    expect(sdk.listener(client, { allowedUpdates: TELEGRAM_ALLOWED_UPDATES })).toBeInstanceOf(
      TelegramBotListener,
    );
  });

  test("the consumed update classes are messages, reactions and callback queries", () => {
    expect([...TELEGRAM_ALLOWED_UPDATES]).toEqual([
      "message",
      "message_reaction",
      "callback_query",
    ]);
  });

  test("the real listener's first poll carries offset 0 and the consumed update classes", async () => {
    const polls: object[] = [];
    const firstPoll = Promise.withResolvers<void>();
    const client = Object.assign(new TelegramBotClient(), {
      deleteWebhook: async () => true,
      getMe: async () => ({ id: 42, is_bot: true, first_name: "Omni", username: "omni_bot" }),
      getUpdates: (params: object, signal: AbortSignal) => {
        polls.push(params);
        if (polls.length === 1) {
          firstPoll.resolve();
          return Promise.resolve([]);
        }
        // The second poll hangs like a real long poll until stop() aborts it.
        return new Promise<never>((_, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
      },
    });
    const listener = telegramSdk().listener(client, {
      allowedUpdates: TELEGRAM_ALLOWED_UPDATES,
    });
    const connected: object[] = [];
    listener.on("connected", (info) => connected.push(info));
    listener.on("error", () => undefined);
    await listener.start();
    await bounded(firstPoll.promise);
    listener.stop();
    expect(connected).toEqual([
      { user: { id: 42, is_bot: true, first_name: "Omni", username: "omni_bot" } },
    ]);
    expect(polls[0]).toMatchObject({
      offset: 0,
      allowed_updates: ["message", "message_reaction", "callback_query"],
    });
  });

  test("the real listener reports a refused start as an error event and stops, instead of hanging", async () => {
    const refusing = Object.assign(new TelegramBotClient(), {
      deleteWebhook: async (): Promise<boolean> => {
        throw new TelegramBotError("Unauthorized: bad token", "unauthorized");
      },
      getMe: async (): Promise<never> => {
        throw new Error("never reached");
      },
    });
    const listener = new TelegramBotListener(refusing, {
      allowedUpdates: [...TELEGRAM_ALLOWED_UPDATES],
    });
    const errors: string[] = [];
    listener.on("error", (error) => {
      errors.push("code" in error && typeof error.code === "string" ? error.code : error.message);
    });
    await listener.start();
    listener.stop();
    expect(errors).toEqual(["unauthorized"]);
  });

  test.each([
    ["unauthorized", true],
    ["conflict", true],
    ["forbidden", false],
    ["network_error", false],
  ] as const)("code %s terminal: %s", (code, terminal) => {
    expect(isTelegramTerminal(new TelegramBotError("x", code))).toBe(terminal);
    expect(isTelegramTerminal(new Error(code))).toBe(false);
  });
});
