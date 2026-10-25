import type { Channel } from "@oni/protocol";
import { kindOfMime } from "../../support/media-kind";
import type { InboundNormalizer } from "../../types";
import type { DiscordInteraction, DiscordMessage, DiscordReaction } from "./types";
import type { DiscordVoiceStateUpdate } from "./sdk";

/** One guild voice join or move, with gateway dispatch identity rather than a synthetic chat body. */
export function discordCall(
  state: DiscordVoiceStateUpdate, sequence: number, sessionId: string, selfId: string,
): Channel.InboundMessage | null {
  if (!state.guild_id || !state.channel_id || state.user_id === selfId) return null;
  return {
    sender: { kind: "external", surface: "discord", externalId: state.user_id },
    facts: {
      eventId: `call:${state.guild_id}:${state.user_id}:${sessionId}:${sequence}`,
      event: "call",
      surface: "discord",
      workspaceId: state.guild_id,
      channelId: state.channel_id,
      author: { externalId: state.user_id, isBot: false },
      addressees: [{ externalId: selfId }],
      dm: false,
      payload: state,
      render: `joined voice channel ${state.channel_id}`,
    },
  };
}

function discordPostback(
  message: DiscordInteraction,
  selfId: string,
): Channel.InboundMessage | null {
  const author = message.member?.user ?? message.user;
  if (author === undefined) return null;
  const authorId = author.id;
  const id = message.data.custom_id;
  const button = message.message?.components
    ?.flatMap((component) => component.components ?? [component])
    .find((component) => component.custom_id === id);
  const label = button?.label || id;
  return {
    sender: { kind: "external", surface: "discord", externalId: authorId },
    facts: {
      eventId: message.id,
      event: "postback",
      author: { externalId: authorId, isBot: author.bot === true },
      surface: "discord",
      channelId: message.channel_id,
      ...(message.guild_id === undefined ? {} : { workspaceId: message.guild_id }),
      addressees: [{ externalId: selfId }],
      dm: message.guild_id === undefined,
      payload: message,
      render: label,
      postback: {
        id,
        label,
        ...(message.message === undefined ? {} : { messageRef: message.message.id }),
      },
    },
  };
}

export class DiscordNormalizer
  implements InboundNormalizer<DiscordMessage | DiscordReaction | DiscordInteraction>
{
  constructor(private readonly selfId?: string) {}

  normalize(
    message: DiscordMessage | DiscordReaction | DiscordInteraction,
  ): Channel.InboundMessage | null {
    // An interaction carries the callback token no message or reaction has.
    return "token" in message
      ? this.selfId === undefined
        ? null
        : discordPostback(message, this.selfId)
      : this.normalizeMessage(message);
  }

  private normalizeMessage(
    message: DiscordMessage | DiscordReaction,
  ): Channel.InboundMessage | null {
    const reaction = "message_id" in message;
    const authorId = reaction ? message.user_id : message.author.id;
    // The bot's own gateway echo is not an outside event.
    if (authorId === this.selfId) return null;
    const text = reaction ? message.emoji.name : message.content;
    const attachments = reaction
      ? []
      : (message.attachments ?? []).map((attachment) => ({
          kind: kindOfMime(attachment.content_type),
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
