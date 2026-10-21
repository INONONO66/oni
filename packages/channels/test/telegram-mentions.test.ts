import { expect, test } from "bun:test";
import { TelegramNormalizer } from "../src/provider/telegram/normalizer";

test("Telegram addressees preserve explicit users and resolve the configured bot mention", () => {
  const message = new TelegramNormalizer({ botId: "42", botUsername: "oni" }).normalize({
    message_id: 1,
    date: 1,
    chat: { id: 2, type: "group" },
    from: { id: 3, is_bot: false, first_name: "Sender" },
    text: "@Oni @other user",
    entities: [
      { type: "mention", offset: 0, length: 4 },
      { type: "mention", offset: 5, length: 6 },
      {
        type: "text_mention",
        offset: 12,
        length: 4,
        user: { id: 7, is_bot: false, first_name: "User" },
      },
      { type: "bold", offset: 12, length: 4 },
    ],
  });
  expect(message?.facts.addressees).toEqual([
    { externalId: "42" },
    { externalId: "@other" },
    { externalId: "7" },
  ]);
});
