import type { Channel } from "@openomni/protocol";
import type { InboundNormalizer } from "../../types";
import type { DiscordMessage, DiscordReaction } from "./types";

export class DiscordNormalizer implements InboundNormalizer<DiscordMessage | DiscordReaction> {
  constructor(private readonly selfId?: string) {}

  normalize(message: DiscordMessage | DiscordReaction): Channel.InboundMessage | null {
    const reaction = "message_id" in message;
    const authorId = reaction ? message.user_id : message.author.id;
    // The bot's own gateway echo is not an outside event.
    if (authorId === this.selfId) return null;
    const text = reaction ? message.emoji.name : message.content;
    // A frame with no renderable text or emoji is not an outside message.
    if (!text) return null;
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
        render: text,
      },
    };
  }
}
