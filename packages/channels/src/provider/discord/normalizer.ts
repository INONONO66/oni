import type { Channel } from "@openomni/protocol";
import type { InboundNormalizer } from "../../types";
import type { DiscordInteraction, DiscordMessage, DiscordReaction } from "./types";

function discordPostback(message: DiscordInteraction, selfId: string): Channel.InboundMessage | null {
  const authorId = message.member?.user?.id ?? message.user?.id;
  if (authorId === undefined) return null;
  const id = message.data.custom_id;
  const button = message.message?.components?.flatMap((component) =>
    component.components ?? [component]).find((component) => component.custom_id === id);
  const label = button?.label || id;
  return {
    sender: { kind: "external", surface: "discord", externalId: authorId },
    facts: {
      eventId: message.id,
      event: "postback",
      author: { externalId: authorId, isBot: false },
      surface: "discord",
      channelId: message.channel_id,
      ...(message.guild_id === undefined ? {} : { workspaceId: message.guild_id }),
      addressees: [{ externalId: selfId }],
      dm: message.guild_id === undefined,
      payload: message,
      render: label,
      postback: {
        id, label,
        ...(message.message === undefined ? {} : { messageRef: message.message.id }),
      },
    },
  };
}

export class DiscordNormalizer implements InboundNormalizer<DiscordMessage | DiscordReaction | DiscordInteraction> {
  constructor(private readonly selfId?: string) {}

  normalize(message: DiscordMessage | DiscordReaction | DiscordInteraction): Channel.InboundMessage | null {
    return "type" in message
      ? this.selfId === undefined ? null : discordPostback(message, this.selfId)
      : this.normalizeMessage(message);
  }

  private normalizeMessage(message: DiscordMessage | DiscordReaction): Channel.InboundMessage | null {
    const reaction = "message_id" in message;
    const authorId = reaction ? message.user_id : message.author.id;
    // The bot's own gateway echo is not an outside event.
    if (authorId === this.selfId) return null;
    const text = reaction ? message.emoji.name : message.content;
    const attachments = reaction ? [] : (message.attachments ?? []).map((attachment) => ({
      kind: attachment.content_type?.startsWith("image/") ? "image" as const
        : attachment.content_type?.startsWith("audio/") ? "audio" as const : "file" as const,
      ref: attachment.url,
      name: attachment.filename,
      ...(attachment.content_type === undefined ? {} : { mime: attachment.content_type }),
      bytes: attachment.size,
    }));
    // A frame with no renderable text or emoji is not an outside message.
    if (!text && attachments.length === 0) return null;
    const isDM = !message.guild_id;
    const mentions = reaction ? [] : (message.mentions ?? []);
    const eventId = reaction ? `${message.message_id}:${text}:${authorId}` : message.id;
    return {
      sender: { kind: "external", surface: "discord", externalId: authorId },
      facts: {
        eventId,
        event: reaction
          ? "reaction"
          : mentions.some((user) => user.id === this.selfId)
            ? "mention"
            : "message",
        author: {
          externalId: authorId,
          isBot: reaction ? message.member?.user?.bot === true : message.author.bot === true,
        },
        surface: "discord",
        channelId: message.channel_id,
        ...(message.guild_id === undefined ? {} : { workspaceId: message.guild_id }),
        addressees: mentions.map((user) => ({ externalId: user.id })),
        dm: isDM,
        ...(!reaction && message.message_reference?.message_id
          ? {
              reply: {
                chain: [message.message_reference.message_id],
                replyToMessageId: message.message_reference.message_id,
              },
            }
          : {}),
        payload: message,
        render: text ?? "",
        ...(attachments.length === 0 ? {} : { attachments }),
      },
    };
  }
}
