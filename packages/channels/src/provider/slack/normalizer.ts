import type { Channel } from "@openomni/protocol";
import type { InboundNormalizer } from "../../types";
import type { SlackMessageEvent } from "./types";

interface SlackNormalizerContext {
  botUserId: string;
  /** Workspace (team) id from `auth.test` — the surface-key namespace AND the sender-id prefix. */
  team: string;
}

function slackAttachments(files: NonNullable<SlackMessageEvent["files"]>) {
  return files.flatMap((file) => {
    // The download URL when the file is hosted, else the private URL, else the
    // file id a `files.info` call resolves; a file with none of them has no handle.
    const ref = file.url_private_download ?? file.url_private ?? file.id;
    return ref === undefined ? [] : [{
      kind: file.mimetype?.startsWith("image/") ? "image" as const
        : file.mimetype?.startsWith("audio/") ? "audio" as const : "file" as const,
      ref,
      ...(file.mimetype === undefined ? {} : { mime: file.mimetype }),
      ...(file.name === undefined ? {} : { name: file.name }),
      ...(file.size === undefined ? {} : { bytes: file.size }),
    }];
  });
}

function slackMentions(text: string) {
  return [...text.matchAll(/<@([^>]+)>/g)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]]);
}

function slackReply(
  event: SlackMessageEvent, reaction: boolean, isDM: boolean,
  mentions: readonly string[], botUserId: string, messageId: string,
) {
  // A top-level mention is the root for later replies.
  if (event.thread_ts !== undefined)
    return { reply: { chain: [event.thread_ts], threadId: event.thread_ts } };
  if (!isDM && !reaction && mentions.includes(botUserId))
    return { reply: { chain: [], threadId: messageId } };
  return {};
}

function slackText(event: SlackMessageEvent, changed: SlackMessageEvent["message"], reaction: boolean) {
  return reaction ? event.reaction : changed?.text ?? event.text;
}

export class SlackNormalizer implements InboundNormalizer<SlackMessageEvent> {
  constructor(private readonly ctx: SlackNormalizerContext) {}

  normalize(event: SlackMessageEvent): Channel.InboundMessage | null {
    const reaction = event.type === "reaction_added";
    // `message_changed` carries its author and text on the nested edited
    // message, not on the envelope itself.
    const changed = event.subtype === "message_changed" ? event.message : undefined;
    // A bot_message frame (CI bots, incoming webhooks) has no `user`, only
    // `bot_id`; the author is still identifiable, just not a human account.
    const authorId = event.user ?? changed?.user ?? event.bot_id;
    // Our own echo is not an outside event.
    if (authorId === this.ctx.botUserId) return null;
    // A frame with no identifiable author at all is not an outside message.
    if (authorId === undefined) return null;
    const text = slackText(event, changed, reaction);
    // Slack private download URLs require the bot token when fetched.
    const attachments = reaction ? [] : slackAttachments(changed?.files ?? event.files ?? []);
    // A frame without renderable content is not an outside message.
    if (!text && attachments.length === 0) return null;

    const isDM = event.channel_type === "im";
    const mentions = reaction ? [] : slackMentions(text ?? "");
    const channel = reaction ? event.item?.channel : event.channel;
    const messageId = reaction ? event.item?.ts : event.ts;
    // A reaction without its target is not an outside event we can address.
    if (channel === undefined || messageId === undefined) return null;
    return {
      sender: { kind: "external", surface: "slack", externalId: `${this.ctx.team}:${authorId}` },
      facts: {
        eventId: reaction ? `${messageId}:${text}:${authorId}` : messageId,
        event: reaction
          ? "reaction"
          : mentions.includes(this.ctx.botUserId)
            ? "mention"
            : "message",
        // `bot_id` present (even on a frame without `user`) is the platform fact for isBot.
        author: {
          externalId: `${this.ctx.team}:${authorId}`,
          isBot: (event.bot_id ?? changed?.bot_id) != null,
        },
        surface: "slack",
        workspaceId: this.ctx.team,
        channelId: channel,
        addressees: [...new Set(mentions)].map((id) => ({ externalId: `${this.ctx.team}:${id}` })),
        dm: isDM,
        ...slackReply(event, reaction, isDM, mentions, this.ctx.botUserId, messageId),
        // Subtypes including bot_message, message_changed and channel_join remain raw facts;
        // bot_message author falls back to bot_id, message_changed to message.user above.
        payload: event,
        render: text ?? "",
        ...(attachments.length === 0 ? {} : { attachments }),
      },
    };
  }
}
