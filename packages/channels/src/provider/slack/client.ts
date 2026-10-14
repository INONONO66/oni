import { z } from "zod";
import { fetchWithRetry } from "../../support/fetch-retry";
import type { ChannelClient, EffectRunner, PublishPort } from "../../types";
import { SlackApiError } from "../../errors";

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
    body: Record<string, string>,
    traceId: string,
    token: string,
    shape: { readonly schema: z.ZodType<T>; readonly malformed: string },
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
    if (!envelope.data.ok) {
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
