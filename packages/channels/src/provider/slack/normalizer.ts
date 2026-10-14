import type { Channel } from "@openomni/protocol";
import type { InboundNormalizer } from "../../types";
import type { SlackMessageEvent } from "./types";

interface SlackNormalizerContext {
  botUserId: string;
  /** Workspace (team) id from `auth.test` — the surface-key namespace AND the sender-id prefix. */
  team: string;
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
    const text = reaction ? event.reaction : (changed?.text ?? event.text);
    // A frame without renderable content is not an outside message.
    if (!text) return null;

    const isDM = event.channel_type === "im";
    const mentions = reaction
      ? []
      : [...text.matchAll(/<@([^>]+)>/g)].flatMap((match) =>
          match[1] === undefined ? [] : [match[1]],
        );
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
        // A thread reply keys on its root; a mention at channel top level keys on
        // its own ts, the root of the thread the answer opens, so the follow-ups
        // written under that answer land on the same session.
        ...(event.thread_ts !== undefined
          ? { reply: { chain: [event.thread_ts], threadId: event.thread_ts } }
          : !isDM && !reaction && mentions.includes(this.ctx.botUserId)
            ? { reply: { chain: [], threadId: messageId } }
            : {}),
        // Subtypes including bot_message, message_changed and channel_join remain raw facts;
        // bot_message author falls back to bot_id, message_changed to message.user above.
        payload: event,
        render: text,
      },
    };
  }
}
