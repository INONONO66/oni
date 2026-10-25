import { type Channel, Gateway } from "@oni/protocol";
import type { TelegramOwnerMessage } from "./owner-sdk.js";

/** Messages without a canonical Bot API id occupy a separate account-local key space. */
export function accountLocalEventId(messageId: string): string {
  return `tdlib:${messageId}`;
}

export function ownerAttachments(message: TelegramOwnerMessage) {
  return message.media.map((media) => ({
    kind: media.kind,
    ref: `tdlib-file:${media.fileId}`,
    name: media.name,
    mime: media.mime,
    bytes: media.size,
    ...(media.voice === undefined ? {} : { voice: media.voice }),
  }));
}

export function ownerInbound(message: TelegramOwnerMessage, userId: string): Channel.InboundMessage | null {
  if (message.outgoing || message.sender.id === userId || (!message.text && message.media.length === 0))
    return null;
  const mentioned = message.mentionedUserIds.includes(userId);
  const attachments = ownerAttachments(message);
  const threadId = message.botThreadId ?? message.threadId;
  return {
    sender: { kind: "external", surface: "telegram", externalId: message.sender.id },
    facts: {
      eventId: message.botMessageId ?? accountLocalEventId(message.messageId),
      event: mentioned ? "mention" : "message",
      ...(message.sender.kind === "user" ? {
        author: { externalId: message.sender.id, isBot: message.sender.isBot },
      } : {}),
      surface: "telegram",
      channelId: message.chatId,
      addressees: mentioned ? [{ externalId: userId }] : [],
      dm: message.dm,
      receivedBy: "owner",
      ...(threadId === undefined && message.replyToMessageId === undefined ? {} : {
        reply: {
          chain: message.replyToMessageId === undefined ? [] : [message.botReplyToMessageId ?? message.replyToMessageId],
          ...(threadId === undefined ? {} : { threadId }),
          ...(message.replyToMessageId === undefined ? {} : {
            replyToMessageId: message.botReplyToMessageId ?? message.replyToMessageId,
          }),
        },
      }),
      payload: Gateway.IngressFacts.shape.payload.parse(message),
      render: message.text,
      ...(attachments.length === 0 ? {} : { attachments }),
    },
  };
}
