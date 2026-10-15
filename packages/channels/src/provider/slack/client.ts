import { z } from "zod";
import { fetchWithRetry } from "../../support/fetch-retry";
import type { ChannelClient, EffectRunner, MediaBytes, PublishPort } from "../../types";
import { SlackApiError } from "../../errors";
import type { PlainValue } from "@openomni/protocol";
import type { SlackBlock } from "./render.js";

const BASE_URL = "https://slack.com/api";

/** Slack wraps errors in a 200 body — every call is judged by this envelope first. */
const EnvelopeSchema = z
  .object({ ok: z.boolean(), error: z.string().optional() })
  .catchall(z.json());

const SocketUrlSchema = z.object({ url: z.string() });
const IdentitySchema = z.object({ user_id: z.string(), team_id: z.string() });
const PostedTsSchema = z.object({ ts: z.string().optional() });
const DmChannelSchema = z.object({ channel: z.object({ id: z.string() }) });
const ThreadMessageSchema = z.object({
  ts: z.string(),
  user: z.string().optional(),
  bot_id: z.string().optional(),
  text: z.string().optional(),
});
const ThreadRepliesSchema = z.object({ messages: z.array(ThreadMessageSchema) });
const UploadUrlSchema = z.object({ upload_url: z.string(), file_id: z.string() });
const OkSchema = z.object({});
export type SlackThreadMessage = z.infer<typeof ThreadMessageSchema>;

/** How much of a thread a new thread session is seeded with. */
export const THREAD_HISTORY_LIMIT = 20;

/**
 * Slack Web API client. Two tokens by design (Socket Mode): the app-level
 * token (`xapp-`) may ONLY open the socket URL; everything else — identity,
 * DMs, posting — runs on the bot token (`xoxb-`). Slack wraps errors in a
 * 200 body (`{ok:false, error}`), so `ok` is checked on every call, and each
 * response body is parsed through its wire schema — a shape that does not
 * parse is a typed `SlackApiError`, never a duck-typed walk.
 */
export class SlackClient implements ChannelClient {
  constructor(
    private readonly botToken: string,
    private readonly appToken: string,
    private readonly publish: PublishPort,
    private readonly run: EffectRunner,
  ) {}

  /** `apps.connections.open` — the only app-token call; returns the Socket Mode wss URL. */
  async openSocketUrl(traceId: string): Promise<string> {
    const data = await this.api("apps.connections.open", {}, traceId, this.appToken, {
      schema: SocketUrlSchema,
      malformed: "apps.connections.open returned no url",
    });
    return data.url;
  }

  /** Bot identity: user id (mention detection, self-filter) and workspace (endpoint keys). */
  async authTest(traceId: string): Promise<{ botUserId: string; team: string }> {
    const data = await this.api("auth.test", {}, traceId, this.botToken, {
      schema: IdentitySchema,
      malformed: "auth.test returned no user_id/team_id",
    });
    return { botUserId: data.user_id, team: data.team_id };
  }

  async send(channelId: string, text: string, traceId: string): Promise<string | undefined> {
    const data = await this.api(
      "chat.postMessage",
      { channel: channelId, text },
      traceId,
      this.botToken,
      { schema: PostedTsSchema, malformed: "chat.postMessage returned a malformed ts" },
    );
    return data.ts;
  }

  async sendBlocks(channelId: string, blocks: readonly SlackBlock[], text: string, traceId: string, threadTs?: string): Promise<string | undefined> {
    const data = await this.api(
      "chat.postMessage",
      { channel: channelId, text, blocks: [...blocks], ...(threadTs === undefined ? {} : { thread_ts: threadTs }) },
      traceId,
      this.botToken,
      { schema: PostedTsSchema, malformed: "chat.postMessage returned a malformed ts" },
    );
    return data.ts;
  }

  /** Threaded reply — same postMessage, anchored to the thread root ts. */
  async sendInThread(
    channelId: string,
    threadTs: string,
    text: string,
    traceId: string,
  ): Promise<string | undefined> {
    const data = await this.api(
      "chat.postMessage",
      { channel: channelId, text, thread_ts: threadTs },
      traceId,
      this.botToken,
      { schema: PostedTsSchema, malformed: "chat.postMessage returned a malformed ts" },
    );
    return data.ts;
  }

  /** The thread's messages, root first (`conversations.replies`), as far as one page reaches. */
  async threadReplies(
    channelId: string,
    threadTs: string,
    traceId: string,
  ): Promise<readonly SlackThreadMessage[]> {
    const data = await this.api(
      "conversations.replies",
      { channel: channelId, ts: threadTs, limit: String(THREAD_HISTORY_LIMIT + 1) },
      traceId,
      this.botToken,
      { schema: ThreadRepliesSchema, malformed: "conversations.replies returned no messages" },
    );
    return data.messages;
  }

  /**
   * The v2 upload: reserve a URL sized to the bytes, POST them, then complete
   * the upload into the channel (and thread). The share's message carries no
   * ts in the response, so the caller gets an acknowledgement without one.
   */
  async sendMedia(
    channelId: string,
    threadTs: string | undefined,
    media: MediaBytes,
    caption: string | undefined,
    traceId: string,
  ): Promise<void> {
    const reserved = await this.api(
      "files.getUploadURLExternal",
      { filename: media.name, length: media.bytes.byteLength },
      traceId,
      this.botToken,
      { schema: UploadUrlSchema, malformed: "files.getUploadURLExternal returned no upload url" },
    );
    const put = await fetchWithRetry(
      reserved.upload_url,
      { method: "POST", headers: { "Content-Type": media.mime }, body: media.bytes },
      { traceId, run: this.run, label: "slack upload", publish: this.publish },
    );
    if (!put.ok) {
      throw new SlackApiError({
        message: `slack upload failed (${put.status})`,
        rejected: put.status >= 400 && put.status < 500,
      });
    }
    await this.api(
      "files.completeUploadExternal",
      {
        files: [{ id: reserved.file_id, title: media.name }],
        channel_id: channelId,
        ...(threadTs === undefined ? {} : { thread_ts: threadTs }),
        ...(caption === undefined ? {} : { initial_comment: caption }),
      },
      traceId,
      this.botToken,
      { schema: OkSchema, malformed: "files.completeUploadExternal returned a malformed envelope" },
    );
  }

  /** `reactions.add` takes the emoji's short name without colons. */
  async react(channelId: string, messageTs: string, name: string, traceId: string): Promise<void> {
    await this.api(
      "reactions.add",
      { channel: channelId, timestamp: messageTs, name },
      traceId,
      this.botToken,
      { schema: OkSchema, malformed: "reactions.add returned a malformed envelope", settled: ["already_reacted"] },
    );
  }

  async removeReaction(channelId: string, messageTs: string, name: string, traceId: string): Promise<void> {
    await this.api(
      "reactions.remove",
      { channel: channelId, timestamp: messageTs, name },
      traceId,
      this.botToken,
      { schema: OkSchema, malformed: "reactions.remove returned a malformed envelope", settled: ["no_reaction"] },
    );
  }

  /** DM channel for a user id (`conversations.open`). */
  async openDm(userId: string, traceId: string): Promise<string> {
    const data = await this.api("conversations.open", { users: userId }, traceId, this.botToken, {
      schema: DmChannelSchema,
      malformed: "conversations.open returned no channel id",
    });
    return data.channel.id;
  }

  private async api<T>(
    method: string,
    body: Record<string, PlainValue>,
    traceId: string,
    token: string,
    shape: {
      readonly schema: z.ZodType<T>;
      readonly malformed: string;
      /** Platform errors that mean the requested state already holds; their envelope is returned, not refused. */
      readonly settled?: readonly string[];
    },
  ): Promise<T> {
    const res = await fetchWithRetry(
      `${BASE_URL}/${method}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(body),
      },
      { traceId, run: this.run, label: `slack ${method}`, publish: this.publish },
    );
    if (!res.ok) {
      throw new SlackApiError({
        message: `slack ${method} failed (${res.status})`,
        rejected: res.status >= 400 && res.status < 500,
      });
    }
    const envelope = EnvelopeSchema.safeParse(await res.json());
    if (!envelope.success) {
      throw new SlackApiError({ message: `slack ${method} returned a malformed envelope` });
    }
    if (!envelope.data.ok && !shape.settled?.includes(envelope.data.error ?? "")) {
      throw new SlackApiError({
        message: `slack ${method} refused: ${envelope.data.error ?? "unspecified error"}`,
        rejected: true,
      });
    }
    const parsed = shape.schema.safeParse(envelope.data);
    if (!parsed.success) {
      throw new SlackApiError({ message: shape.malformed });
    }
    return parsed.data;
  }
}
