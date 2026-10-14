import { type Channel, Gateway } from "@openomni/protocol";
import type { InboundNormalizer } from "../../types";
import type { TelegramMessage, TelegramReaction } from "./types";

interface TelegramNormalizerContext {
  botId: string;
  botUsername: string;
}

export class TelegramNormalizer implements InboundNormalizer<TelegramMessage | TelegramReaction> {
  constructor(private readonly ctx: TelegramNormalizerContext) {}

  normalize(message: TelegramMessage | TelegramReaction): Channel.InboundMessage | null {
    const reaction = "new_reaction" in message;
    const from = reaction ? message.user : message.from;
    const userId = from?.id ?? (reaction ? message.actor_chat?.id : undefined);
    // A frame with no identifiable author is not an outside event.
    if (userId === undefined) return null;
    // The bot's own echo is not an outside event.
    if (String(userId) === this.ctx.botId) return null;
    const text = reaction ? message.new_reaction.find((entry) => entry.emoji)?.emoji : message.text;
    // A frame without renderable text or a newly added emoji is not an outside message.
    if (!text) return null;

    const chatId = String(message.chat.id);
    const addressees = reaction
      ? []
      : (message.entities ?? []).flatMap((entity) => {
          if (entity.type === "text_mention" && entity.user !== undefined)
            return [{ externalId: String(entity.user.id) }];
          if (entity.type !== "mention") return [];
          const name = text.slice(entity.offset, entity.offset + entity.length);
          return [
            {
              externalId:
                name.toLowerCase() === `@${this.ctx.botUsername.toLowerCase()}`
                  ? this.ctx.botId
                  : name,
            },
          ];
        });
    const chain: string[] = [];
    if (!reaction) {
      for (
        let reply = message.reply_to_message;
        reply !== undefined;
        reply = reply.reply_to_message
      )
        chain.push(String(reply.message_id));
    }
    return {
      sender: { kind: "external", surface: "telegram", externalId: String(userId) },
      facts: {
        eventId: reaction ? `${message.message_id}:${text}:${userId}` : String(message.message_id),
        event: reaction
          ? "reaction"
          : addressees.some((entry) => entry.externalId === this.ctx.botId)
            ? "mention"
            : "message",
        author: { externalId: String(userId), isBot: from?.is_bot === true },
        surface: "telegram",
        channelId: chatId,
        addressees,
        dm: message.chat.type === "private",
        ...(reaction ? {} : telegramReply(message, chain)),
        ...(reaction ? {} : quotedContext(message, this.ctx.botId)),
        payload: Gateway.IngressFacts.shape.payload.parse(message),
        render: text,
      },
    };
  }
}

/** The quoted message's author and text, so the model reads what the person is answering. */
function quotedContext(message: TelegramMessage, botId: string) {
  const quoted = message.reply_to_message;
  if (quoted?.text === undefined || quoted.from === undefined) return {};
  const author = String(quoted.from.id) === botId ? "assistant"
    : quoted.from.username !== undefined ? `@${quoted.from.username}` : quoted.from.first_name;
  return { context: { quoted: { author, text: quoted.text } } };
}

/** A forum topic is the thread; a quoted message is the reply-to. Neither alone makes a `reply`. */
function telegramReply(message: TelegramMessage, chain: readonly string[]) {
  const topic = message.is_topic_message === true && message.message_thread_id !== undefined
    ? { threadId: String(message.message_thread_id) } : {};
  const quoted = message.reply_to_message === undefined
    ? {} : { replyToMessageId: String(message.reply_to_message.message_id) };
  return Object.keys(topic).length + Object.keys(quoted).length === 0
    ? {} : { reply: { chain: [...chain], ...topic, ...quoted } };
}
