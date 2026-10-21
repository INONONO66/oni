import type { TelegramMessage } from "../../src/provider/telegram/types";

export function telegramReply(username?: string): TelegramMessage {
  return {
    message_id: 12,
    chat: { id: 34, type: "group" },
    date: 1,
    from: {
      id: 56,
      is_bot: false,
      first_name: "Seller",
      ...(username === undefined ? {} : { username }),
    },
    text: "tracking number",
    reply_to_message: {
      message_id: 11,
      chat: { id: 34, type: "group" },
      date: 1,
      from: { id: 78, is_bot: true, first_name: "Oni" },
      text: "please report",
    },
  };
}
