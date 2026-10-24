import { type Channel, type Gateway, Operational, type Outbound } from "@oni/protocol";
import { Duration, Effect } from "effect";
import { z } from "zod";
import { ChannelsFailure, DeliveryNotSent } from "../../errors";
import { Dedupe } from "../../support/dedupe";
import { type DeliveryReceipt, DeliveryReconciliation, deliverKeyed } from "../../support/deliver";
import { handoffInbound } from "../../support/inbound-handoff";
import { requireHandler } from "../../support/handler-frame";
import { type ListenerCustody, listenerCustody } from "../../support/sdk-listener";
import { newTraceId } from "../../support/trace";
import { translate } from "../../support/translate";
import type { MediaBytes, PublishPort } from "../../types";
import type { AccountIdentity, OwnerPosture, ProviderOptions } from "../contract";
import { KAKAOTALK_MEDIA_LIMITS, KAKAOTALK_RENDER } from "./format";
import {
  type KakaoTalkDeviceType,
  type KakaoTalkMessage,
  type KakaoTalkOwnerApi,
  type KakaoTalkOwnerEventMap,
  type KakaoTalkOwnerEvents,
  type KakaoTalkOwnerSdk,
  KakaoTalkMessageSchema,
  kakaoChatKind,
  kakaoMediaKind,
  kakaoTalkOwnerSdk,
  KakaoTalkOwnerError,
} from "./owner-sdk";

/** The vault-opened account session: the OAuth token the login helper registered for a device. */
export interface KakaoTalkOwnerCredentials {
  readonly oauthToken: string;
  readonly userId: string;
  readonly deviceUuid?: string;
  readonly deviceType?: KakaoTalkDeviceType;
}

/** The SDK listener never reopens a closed LOCO session; the surface does, with its own bounded backoff. */
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;

/** Refusals raised before any request leaves: nothing was sent. */
const REJECTED = new Set(["missing_token", "missing_user_id", "not_authenticated"]);

/** The SDK's own synthetic answer for a request whose socket closed before the reply: the WRITE may have landed. */
const CONNECTION_CLOSED_STATUS = -1;

/** A pushed media message's LOCO extra: only one already carrying a download URL becomes an attachment. */
const LocoMedia = z.object({
  url: z.string().min(1),
  name: z.string().min(1).optional(),
  mt: z.string().min(1).optional(),
  s: z.number().int().nonnegative().optional(),
});

function kakaoAttachments(message: KakaoTalkMessage) {
  const kind = kakaoMediaKind(message.message_type);
  const media = LocoMedia.catch({ url: "" }).parse(message.attachment);
  if (kind === undefined || media.url.length === 0) return [];
  const { url, name, mt, s } = media;
  return [{
    kind,
    ref: url,
    ...(name === undefined ? {} : { name }),
    ...(mt === undefined ? {} : { mime: mt }),
    ...(s === undefined ? {} : { bytes: s }),
  }];
}

/** A send's settled answer: its log id, or the failure the status proves. */
function settled(sent: { success: boolean; status_code: number; log_id: string }, operation: string, media = false): string {
  if (sent.success && (!media || (sent.log_id.length > 0 && sent.log_id !== "0"))) return sent.log_id;
  if (sent.success && media)
    throw new ChannelsFailure({ operation, cause: "media acknowledgement carried no usable log id" });
  if (sent.status_code === CONNECTION_CLOSED_STATUS || (media && sent.status_code === 0))
    throw new ChannelsFailure({ operation, cause: media && sent.status_code === 0 ? "media COMPLETE acknowledgement missing" : "connection closed before the reply" });
  throw new DeliveryNotSent({ operation, cause: `status ${sent.status_code}` });
}

function kakaoCode(error: Error): string | undefined {
  return error instanceof KakaoTalkOwnerError ? error.code : undefined;
}

/**
 * KakaoTalk as the Owner's own account (#1569 lane 7): the
 * `kakaotalk:owner` instance — the platform has no bot account for a
 * person's chats. Intake is the account's LOCO push listener under the
 * declared posture: a direct chat is a DM to the Owner, a group message is
 * intake only when it names the Owner's nickname (`@nickname`) under
 * `mentions_and_dms`, everything under `all`; the account's own messages
 * are never an outside event. A chat's shape (direct or group) is read
 * once per chat through the SDK and remembered. The SDK listener does not
 * reopen a dropped session (and still counts itself running after one, so
 * a bare start would be a no-op), so the surface stops and restarts it
 * under a bounded backoff, from a drop and from a refused reopen alike; a
 * session kicked by another device is terminal. Delivery posts into the
 * conversation's chat, or into the direct chat the person last wrote from;
 * a cold send to a person the account has no direct chat with is
 * `not_sent`. One physical attempt per idempotency key: the SDK re-runs a
 * send once when the session died under it, so a thrown send is `unknown`,
 * never retried here, and so is a send whose socket closed before the
 * reply. Media goes up through the SDK's LOCO upload, its caption as the
 * text message after it; no reactions.
 */
export class KakaoTalkOwnerAdapter implements Channel.Surface {
  readonly id = "kakaotalk:owner";
  /** The surface contract's config: an Owner instance carries its posture instead. */
  readonly config: Channel.Config = {};

  private readonly client: KakaoTalkOwnerApi;
  private readonly sdk: KakaoTalkOwnerSdk;
  private readonly dedupe: Dedupe;
  private readonly outbound = new DeliveryReconciliation();
  private custody: ListenerCustody | null = null;
  private listener: KakaoTalkOwnerEvents | null = null;
  private handler: Channel.MessageHandler | null = null;
  private nickname: string | null = null;
  /** A chat's shape is read once (the first lookup is shared by the messages that race for it). */
  private readonly chatKinds = new Map<string, Promise<"dm" | "group" | "open" | "unknown">>();
  /** The direct chat each person last wrote from: where a cold send to them goes. */
  private readonly directChats = new Map<string, string>();
  private reconnectAttempts = 0;
  /** Connected at least once: a refused reopen is then retried, a refused boot is not. */
  private live = false;
  private stopped = false;

  constructor(
    private readonly credentials: KakaoTalkOwnerCredentials,
    readonly posture: OwnerPosture,
    private readonly publish: PublishPort,
    private readonly options: ProviderOptions,
    sdk: KakaoTalkOwnerSdk = kakaoTalkOwnerSdk(),
  ) {
    this.sdk = sdk;
    this.client = sdk.client();
    this.dedupe = new Dedupe(options.now);
  }

  onMessage(handler: Channel.MessageHandler): void {
    this.handler = handler;
  }

  /**
   * The account logs in (in memory) and its profile names the nickname a
   * mention of the Owner carries; under an intake posture the push
   * listener then opens, settling on the session's `connected`.
   */
  /** The account's KakaoTalk user id (#1600), the shape a KakaoTalk endpoint takes; known from the declaration itself. */
  account(): AccountIdentity | undefined {
    return { externalId: String(this.credentials.userId) };
  }

  async start(traceId: string): Promise<void> {
    this.stopped = false;
    await this.client.login({
      oauthToken: this.credentials.oauthToken,
      userId: this.credentials.userId,
      ...(this.credentials.deviceUuid === undefined ? {} : { deviceUuid: this.credentials.deviceUuid }),
      ...(this.credentials.deviceType === undefined ? {} : { deviceType: this.credentials.deviceType }),
    });
    const profile = await this.client.getProfile();
    this.nickname = profile.nickname;
    const listens = this.posture.intake !== "none" && this.handler !== null;
    if (listens) await this.listen();
    this.publish(Operational.Events.Info, {
      traceId,
      time: this.options.now(),
      component: "server",
      msg: "kakaotalk owner instance started",
      context: { userId: profile.user_id, nickname: profile.nickname, listener: listens ? this.posture.intake : "none" },
    });
  }

  private async listen(): Promise<void> {
    const listener = this.sdk.listener(this.client);
    const custody = listenerCustody<KakaoTalkOwnerEventMap>(listener, {
      label: "kakaotalk push",
      publish: this.publish,
      now: this.options.now,
      id: this.options.id,
      failOnCloseBeforeConnected: true,
      // Kicked by another device: the SDK has stopped itself for good.
      terminal: (error) => /kicked/i.test(error.message),
      onConnected: () => {
        this.reconnectAttempts = 0;
        this.live = true;
      },
    });
    listener.on("message", (message) => {
      const parsed = KakaoTalkMessageSchema.safeParse(message);
      if (parsed.success) this.handleMessage(parsed.data);
    });
    listener.on("disconnected", () => this.reopen());
    // A refused reopen emits only `error` (custody, subscribed first, has
    // already ended a terminal one): the next backoff step follows.
    listener.on("error", () => {
      if (this.live) this.reopen();
    });
    this.listener = listener;
    this.custody = custody;
    await custody.start().catch((error: Error) => {
      this.listener = null;
      this.custody = null;
      throw error;
    });
  }

  /**
   * The SDK listener reports a dropped session and stays idle, still
   * counting itself running; the surface stops it (which only drops its
   * client subscriptions) and starts it again under a bounded backoff.
   */
  private reopen(): void {
    const listener = this.listener;
    if (this.stopped || listener === null || this.custody?.dead === true) return;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempts, RECONNECT_MAX_MS);
    this.reconnectAttempts += 1;
    void this.options
      .run(Effect.sleep(Duration.millis(delay)))
      .then(() => {
        if (this.stopped || this.listener !== listener || this.custody?.dead === true) return undefined;
        listener.stop();
        return listener.start();
      })
      .catch(() => undefined);
  }

  stop(traceId: string): void {
    this.stopped = true;
    this.live = false;
    this.custody?.stop();
    this.custody = null;
    this.listener = null;
    this.client.close();
    this.publish(Operational.Events.Info, {
      traceId,
      time: this.options.now(),
      component: "server",
      msg: "kakaotalk owner instance stopped",
    });
  }

  /** One pushed message under the posture: never the account's own; a direct chat or a mention of the Owner's nickname. */
  private handleMessage(message: KakaoTalkMessage): void {
    const authorId = String(message.author_id);
    if (authorId === this.credentials.userId) return;
    const traceId = newTraceId(this.options.id);
    void handoffInbound({
      dedupe: this.dedupe,
      key: `${message.chat_id}:${message.log_id}`,
      traceId,
      now: this.options.now,
      publish: this.publish,
      errorMessage: "kakaotalk owner message handling failed",
      rethrowFailure: false,
      handle: async () => {
        const kind = await this.chatKind(message.chat_id);
        const dm = kind === "dm";
        if (dm) this.directChats.set(authorId, message.chat_id);
        const mentioned = this.nickname !== null && message.message.includes(`@${this.nickname}`);
        const attachments = kakaoAttachments(message);
        if (this.posture.intake !== "all" && !(dm || mentioned)) return;
        await requireHandler(this.handler, "kakaotalk:owner")({
          sender: { kind: "external", surface: "kakaotalk", externalId: authorId },
          facts: {
            eventId: message.log_id,
            event: mentioned && !dm ? "mention" : "message",
            author: { externalId: authorId, isBot: false },
            surface: "kakaotalk",
            channelId: message.chat_id,
            addressees: mentioned ? [{ externalId: this.credentials.userId }] : [],
            dm,
            receivedBy: "owner",
            payload: { ...message, attachment: message.attachment === null ? null : JSON.stringify(message.attachment) },
            render: message.message,
            ...(attachments.length === 0 ? {} : { attachments }),
          },
        });
      },
    });
  }

  /** A chat's shape is read once; a lookup that fails is treated as a group (fail closed: not a DM). */
  private chatKind(chatId: string): Promise<"dm" | "group" | "open" | "unknown"> {
    const known = this.chatKinds.get(chatId);
    if (known !== undefined) return known;
    const kind = this.client.getChat(chatId).then(kakaoChatKind, () => "unknown" as const);
    this.chatKinds.set(chatId, kind);
    return kind;
  }

  /**
   * Delivery as the Owner: into the conversation's chat, else into the
   * direct chat the person last wrote from; a person the account never
   * had a direct chat with cannot be reached cold.
   */
  async deliver(
    externalId: string,
    payload: Outbound.Payload,
    idempotencyKey: string,
    conversation?: Gateway.Conversation,
  ): Promise<DeliveryReceipt> {
    const chatId = conversation?.channelId ?? this.directChats.get(externalId);
    // #1600 lane R3: nothing was attempted — the sender's typed fact, not a thrown failure.
    if (chatId === undefined) return { value: "not_sent" };
    return await deliverKeyed(
      this.outbound,
      idempotencyKey,
      async () =>
        await translate(
          payload,
          KAKAOTALK_RENDER,
          {
            text: async (chunk) => settled(await this.client.sendMessage(chatId, chunk), "kakaotalk.sendMessage"),
            media: {
              limits: KAKAOTALK_MEDIA_LIMITS,
              captionAsText: true,
              upload: (kind, bytes) => this.upload(chatId, kind, bytes),
            },
          },
          this.options.media,
        ),
      (error) => {
        const code = kakaoCode(error);
        return code !== undefined && REJECTED.has(code);
      },
      this.publish,
      this.options,
    );
  }

  private async upload(
    chatId: string,
    kind: "image" | "file" | "audio" | "video",
    media: MediaBytes,
  ): Promise<{ externalMessageId: string }> {
    const sends = {
      image: () => this.client.sendPhoto(chatId, media.bytes, media.name),
      video: () => this.client.sendVideo(chatId, media.bytes, media.name),
      audio: () => this.client.sendAudio(chatId, media.bytes, media.name),
      file: () => this.client.sendFile(chatId, media.bytes, media.name, media.mime),
    };
    return { externalMessageId: settled(await sends[kind](), `kakaotalk.upload.${kind}`, true) };
  }

  /** The typing indicator rides the conversation's chat; a cold turn needs a known direct chat. */
  async openTyping(externalId: string, conversation?: Gateway.Conversation): Promise<Gateway.Conversation> {
    if (conversation !== undefined) return conversation;
    const chatId = this.directChats.get(externalId);
    if (chatId === undefined)
      throw new DeliveryNotSent({ operation: "kakaotalk.owner", cause: `no direct chat with ${externalId} yet` });
    return { channelId: chatId };
  }

  async typing(conversation: Gateway.Conversation): Promise<void> {
    await this.client.sendTyping(conversation.channelId);
  }
}
