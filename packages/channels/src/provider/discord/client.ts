import { z } from "zod";
import { fetchWithRetry } from "../../support/fetch-retry";
import type { ChannelClient, EffectRunner, MediaBytes, PublishPort } from "../../types";
import { DiscordApiError, DiscordGatewayFetchError } from "../../errors";
import type { Gateway, PlainValue } from "@openomni/protocol";

const BASE_URL = "https://discord.com/api/v10";

/** Discord rate-limit body carries the wait in seconds. */
const RetryAfterSchema = z.object({ retry_after: z.number().optional() });

/** Created message — the snowflake id anchors reply threading; absence means nothing to anchor. */
const CreatedMessageSchema = z.object({ id: z.string().optional() });

const DmChannelSchema = z.object({ id: z.string().optional() });

const GatewayUrlSchema = z.object({ url: z.string() });

/** A reply quotes a message in the same channel; `fail_if_not_exists` keeps a deleted original from refusing the send. */
function replyReference(conversation: Gateway.Conversation | undefined): Record<string, PlainValue> {
  return conversation?.replyToMessageId === undefined
    ? {}
    : { message_reference: { message_id: conversation.replyToMessageId, fail_if_not_exists: false } };
}

export class DiscordClient implements ChannelClient {
  constructor(
    private readonly token: string,
    private readonly publish: PublishPort,
    private readonly run: EffectRunner,
  ) {}

  async send(
    channelId: string,
    text: string,
    traceId: string,
    conversation?: Gateway.Conversation,
  ): Promise<string | undefined> {
    const message = await this.api(
      `/channels/${channelId}/messages`,
      { content: text, ...replyReference(conversation) },
      traceId,
      CreatedMessageSchema,
    );
    return message.id;
  }

  /** One attachment: multipart with the JSON body in `payload_json` and the bytes in `files[0]`. */
  async sendMedia(
    channelId: string,
    media: MediaBytes,
    caption: string | undefined,
    traceId: string,
    conversation?: Gateway.Conversation,
  ): Promise<string | undefined> {
    const form = new FormData();
    form.set(
      "payload_json",
      JSON.stringify({
        ...(caption === undefined ? {} : { content: caption }),
        attachments: [{ id: 0, filename: media.name }],
        ...replyReference(conversation),
      }),
    );
    form.set("files[0]", new Blob([media.bytes], { type: media.mime }), media.name);
    const message = await this.request(`/channels/${channelId}/messages`, { method: "POST", body: form }, traceId, CreatedMessageSchema);
    return message.id;
  }

  /** `PUT .../reactions/{emoji}/@me`; Discord answers 204 with no body. */
  async react(channelId: string, messageId: string, emoji: string, traceId: string): Promise<void> {
    await this.request(
      `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`,
      { method: "PUT" },
      traceId,
      z.undefined(),
    );
  }

  async removeReaction(channelId: string, messageId: string, emoji: string, traceId: string): Promise<void> {
    await this.request(
      `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`,
      { method: "DELETE" },
      traceId,
      z.undefined(),
    );
  }

  /** `POST /channels/{id}/typing` shows the indicator for about ten seconds. */
  async typing(channelId: string, traceId: string): Promise<void> {
    await this.request(`/channels/${channelId}/typing`, { method: "POST" }, traceId, z.undefined());
  }

  async createDmChannel(recipientId: string, traceId: string): Promise<string> {
    const channel = await this.api(
      "/users/@me/channels",
      { recipient_id: recipientId },
      traceId,
      DmChannelSchema,
    );
    if (channel.id === undefined) {
      throw new DiscordApiError({
        message: "Discord DM channel response carried no string id",
      });
    }
    return channel.id;
  }

  async fetchGatewayUrl(): Promise<string> {
    const res = await fetch(`${BASE_URL}/gateway/bot`, {
      headers: { Authorization: `Bot ${this.token}` },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new DiscordGatewayFetchError({
        message: `Discord gateway fetch failed (${res.status}): ${body}`,
      });
    }

    const gateway = GatewayUrlSchema.safeParse(await res.json());
    if (!gateway.success) {
      throw new DiscordGatewayFetchError({
        message: "Discord gateway response carried no url",
      });
    }
    return `${gateway.data.url}?v=10&encoding=json`;
  }

  private api<T>(
    path: string,
    body: Record<string, PlainValue>,
    traceId: string,
    schema: z.ZodType<T>,
  ): Promise<T> {
    return this.request(
      path,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      traceId,
      schema,
    );
  }

  private async request<T>(
    path: string,
    init: Pick<RequestInit, "method" | "headers" | "body">,
    traceId: string,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const res = await fetchWithRetry(
      `${BASE_URL}${path}`,
      { ...init, headers: { Authorization: `Bot ${this.token}`, ...init.headers } },
      {
        traceId,
        run: this.run,
        publish: this.publish,
        retryAfterSchema: RetryAfterSchema.transform((hint) => hint.retry_after ?? 5),
        label: `discord${path}`,
      },
    );

    if (!res.ok) {
      const text = await res.text();
      throw new DiscordApiError({
        message: `Discord API ${path} failed (${res.status}): ${text}`,
        rejected: res.status >= 400 && res.status < 500,
      });
    }

    const parsed = schema.safeParse(res.status === 204 ? undefined : await res.json());
    if (!parsed.success) {
      throw new DiscordApiError({
        message: `Discord API ${path} returned a malformed body`,
      });
    }
    return parsed.data;
  }
}
