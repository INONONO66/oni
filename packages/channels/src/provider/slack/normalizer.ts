import type { Channel } from "@oni/protocol";
import { kindOfMime } from "../../support/media-kind";
import type { InboundNormalizer } from "../../types";
import type { SlackInteraction, SlackMessageEvent } from "./types";
import type { SlackOwnerEventMap } from "./owner-sdk";

type SlackHuddleChanged = SlackOwnerEventMap["user_huddle_changed"][0];

/** A resolved Owner room is an unaddressed call fact; a room id is never a conversation id. */
export function slackCall(
  event: SlackHuddleChanged,
  context: { readonly team: string; readonly ownerUserId: string; readonly channelId: string; readonly dm: boolean },
): Channel.InboundMessage | null {
  const room = event.user.profile.huddle_state_call_id;
  if (event.user.id !== context.ownerUserId || event.user.team_id !== context.team ||
      event.user.profile.huddle_state !== "in_a_huddle" || !room) return null;
  const externalId = `${context.team}:${context.ownerUserId}`;
  return {
    sender: { kind: "external", surface: "slack", externalId },
    facts: {
      eventId: `call:slack:${context.team}:${context.ownerUserId}:${event.event_ts}:${room}`,
      event: "call",
      author: { externalId, isBot: false },
      surface: "slack",
      receivedBy: "owner",
      workspaceId: context.team,
      channelId: context.channelId,
      addressees: [],
      dm: context.dm,
      payload: {
        roomId: room,
        state: event.user.profile.huddle_state,
        channelId: context.channelId,
      },
      render: `Owner joined a huddle in ${context.channelId}`,
    },
  };
}

interface SlackNormalizerContext {
  botUserId: string;
  /** Workspace (team) id from `auth.test` — the surface-key namespace AND the sender-id prefix. */
  team: string;
}

function slackAttachments(files: NonNullable<SlackMessageEvent["files"]>) {
  return files.flatMap((file) => {
    // The file id first: it is what the authenticated download takes, and the
    // private URLs answer only with the bot token anyway.
    const ref = file.id ?? file.url_private_download ?? file.url_private;
    return ref === undefined ? [] : [{
      kind: kindOfMime(file.mimetype),
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

function slackContent(event: SlackMessageEvent, changed: SlackMessageEvent["message"], reaction: boolean) {
  return {
    text: reaction ? event.reaction : changed?.text ?? event.text,
    attachments: reaction ? [] : slackAttachments(changed?.files ?? event.files ?? []),
  };
}

function slackPostback(event: SlackInteraction, ctx: SlackNormalizerContext): Channel.InboundMessage {
  const action = event.actions[0];
  const messageRef = event.container?.message_ts ?? event.message?.ts;
  const threadId = event.message?.thread_ts;
  return {
    sender: { kind: "external", surface: "slack", externalId: `${ctx.team}:${event.user.id}` },
    facts: {
      eventId: `${action.action_ts}:${event.user.id}`,
      event: "postback",
      author: { externalId: `${ctx.team}:${event.user.id}`, isBot: false },
      surface: "slack",
      workspaceId: ctx.team,
      channelId: event.channel.id,
      addressees: [{ externalId: `${ctx.team}:${ctx.botUserId}` }],
      dm: event.channel.id.startsWith("D"),
      ...(threadId === undefined ? {} : { reply: { chain: [threadId], threadId } }),
      payload: event,
      render: action.text.text,
      postback: {
        id: action.action_id,
        label: action.text.text,
        ...(messageRef === undefined ? {} : { messageRef }),
      },
    },
  };
}

export class SlackNormalizer implements InboundNormalizer<SlackMessageEvent | SlackInteraction> {
  constructor(private readonly ctx: SlackNormalizerContext) {}

  normalize(event: SlackMessageEvent | SlackInteraction): Channel.InboundMessage | null {
    return "actions" in event ? slackPostback(event, this.ctx) : this.normalizeMessage(event);
  }

  private normalizeMessage(event: SlackMessageEvent): Channel.InboundMessage | null {
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
    const { text, attachments } = slackContent(event, changed, reaction);
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
