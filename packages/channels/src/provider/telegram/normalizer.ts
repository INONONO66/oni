import { type Channel, Gateway } from "@openomni/protocol";
import type { InboundNormalizer } from "../../types";
import type { TelegramMessage, TelegramReaction } from "./types";

interface TelegramNormalizerContext {
  botId: string;
  botUsername: string;
}

function fileAttachment(
  kind: "image" | "audio" | "file",
  file: { file_id: string; file_name?: string; mime_type?: string; file_size?: number },
  mime = file.mime_type,
) {
  return {
    kind, ref: file.file_id,
    ...(file.file_name === undefined ? {} : { name: file.file_name }),
    ...(mime === undefined ? {} : { mime }),
    ...(file.file_size === undefined ? {} : { bytes: file.file_size }),
  };
}

function telegramAttachments(message: TelegramMessage) {
  const photo = message.photo?.at(-1);
  const sticker = message.sticker;
  return [
    photo === undefined ? undefined : fileAttachment("image", photo),
    message.document === undefined ? undefined : fileAttachment("file", message.document),
    message.voice === undefined ? undefined : fileAttachment("audio", message.voice),
    message.audio === undefined ? undefined : fileAttachment("audio", message.audio),
    sticker === undefined || sticker.is_animated || sticker.is_video
      ? undefined : fileAttachment("image", sticker, "image/webp"),
  ].filter((entry) => entry !== undefined);
}

function telegramAddressees(message: TelegramMessage, text: string, ctx: TelegramNormalizerContext) {
  return (message.entities ?? message.caption_entities ?? []).flatMap((entity) => {
    if (entity.type === "text_mention" && entity.user !== undefined)
      return [{ externalId: String(entity.user.id) }];
    if (entity.type !== "mention") return [];
    const name = text.slice(entity.offset, entity.offset + entity.length);
    return [{
      externalId: name.toLowerCase() === `@${ctx.botUsername.toLowerCase()}` ? ctx.botId : name,
    }];
  });
}

function telegramText(message: TelegramMessage | TelegramReaction) {
  return "new_reaction" in message
    ? message.new_reaction.find((entry) => entry.emoji)?.emoji
    : message.text ?? message.caption;
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
    const text = telegramText(message);
    const attachments = reaction ? [] : telegramAttachments(message);
    // A frame without renderable text or a newly added emoji is not an outside message.
    if (!text && attachments.length === 0) return null;

    const chatId = String(message.chat.id);
    const addressees = reaction ? [] : telegramAddressees(message, text ?? "", this.ctx);
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
        render: text ?? "",
        ...(attachments.length === 0 ? {} : { attachments }),
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
