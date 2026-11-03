import { type Channel, type Gateway, Operational, Outbound } from "@oni/protocol";
import { AttachmentRefused } from "../../errors.js";
import { Dedupe } from "../../support/dedupe.js";
import { type DeliveryReceipt, DeliveryReconciliation, deliverKeyed, kernelDeliveryReceipt } from "../../support/deliver.js";
import { instanceHandler, requireHandler } from "../../support/handler-frame.js";
import { handoffInbound } from "../../support/inbound-handoff.js";
import { newTraceId } from "../../support/trace.js";
import { translate } from "../../support/translate.js";
import type { AttachmentBounds, MediaStream, PublishPort } from "../../types.js";
import type { AccountIdentity, AccountWithdrawal, ProviderOptions } from "../contract.js";
import type { ProviderHistoryResult } from "../history.js";
import { accountSession } from "./account-custody.js";
import type { TelegramAccountCredentials, TelegramAccountSurface } from "./account-contract.js";
import { accountLocalEventId, accountAttachments, accountInbound } from "./account-normalizer.js";
import { TELEGRAM_MEDIA_LIMITS } from "./format.js";
import {
  type TelegramAccountClient, TelegramAccountError, type TelegramAccountMessage,
  type TelegramAccountSdk, type TelegramAccountState, telegramAccountSdk,
} from "./account-sdk.js";

const FILE_REF = /^tdlib-file:([1-9]\d*)$/;
const TEXT_LIMIT = 4096;

function accountSend(
  client: TelegramAccountClient, chatId: string, text: string, replyTo?: string, threadId?: string,
): Promise<string> {
  return client.send(chatId, {
    kind: "text", text,
    ...(replyTo === undefined ? {} : { replyTo }),
    ...(threadId === undefined ? {} : { threadId }),
  })
    .then(({ messageId }) => messageId);
}

/** TDLib's native ids and cursor are opaque; preserve the SDK's order, including equal timestamps. */
function historyMessage(message: TelegramAccountMessage): Channel.HistoryMessage {
  return {
    chatId: message.chatId,
    messageId: message.messageId,
    senderId: message.senderId,
    outgoing: message.outgoing,
    text: message.text,
    timestampMs: message.dateSeconds * 1000,
    attachments: accountAttachments(message),
    ...(message.replyToMessageId === undefined ? {} : { replyToMessageId: message.replyToMessageId }),
    ...(message.threadId === undefined ? {} : { threadId: message.threadId }),
  };
}

function historyRefusal(error: Error): Extract<ProviderHistoryResult, { status: "refused" }>["reason"] {
  if (error instanceof TelegramAccountError) {
    switch (error.code) {
      case "session_in_use":
      case "session_lost":
      case "login_action_required":
      case "history_unavailable":
        return error.code;
      default:
        break;
    }
  }
  return "history_unavailable";
}

export class TelegramAccountAdapter implements TelegramAccountSurface {
  get id(): string { return this.options.instance; }
  readonly config: Channel.Config = {};
  private client: TelegramAccountClient | undefined;
  private identity: string | undefined;
  private handler: Channel.MessageHandler | null = null;
  private unsubscribe: (() => void) | undefined;
  private unsubscribeState: (() => void) | undefined;
  private release: (() => Promise<void>) | undefined;
  private readonly outbound = new DeliveryReconciliation();
  private readonly dedupe: Dedupe;
  private readonly sizes = new Map<number, number>();
  private readonly threads = new Map<string, string>();
  private readonly replies = new Map<string, string>();
  private readonly pending: TelegramAccountMessage[] = [];
  private generation = 0;
  private starting: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private terminal: AccountWithdrawal | undefined;
  private readonly withdrawals = new Set<(reason: AccountWithdrawal) => void>();

  private withdraw(reason: AccountWithdrawal): void {
    if (this.terminal !== undefined) return;
    this.terminal = reason;
    this.identity = undefined;
    this.pending.length = 0;
    for (const listener of this.withdrawals) listener(reason);
  }

  /** The mount account learns of a state-driven withdrawal once, with its latched reason. */
  onWithdrawn(listener: (reason: AccountWithdrawal) => void): void {
    this.withdrawals.add(listener);
  }

  private stateChanged(state: TelegramAccountState): void {
    if (state.state === "ready") return;
    this.withdraw(state.state === "login_action_required" ? "login_action_required" : "session_lost");
  }

  private methodFailure(error: Error): void {
    if (error instanceof TelegramAccountError &&
      (error.code === "session_lost" || error.code === "login_action_required"))
      this.withdraw(error.code);
  }

  /** A shared Bot API topic/reply id is translated only when this account observed its native counterpart. */
  private nativeId(map: Map<string, string>, chatId: string, id?: string): string | undefined {
    if (id === undefined) return undefined;
    return map.get(`${chatId}:${id}`) ?? id;
  }

  constructor(
    private readonly credentials: TelegramAccountCredentials,
    private readonly publish: PublishPort,
    private readonly options: ProviderOptions,
    private readonly sdk: TelegramAccountSdk = telegramAccountSdk(),
  ) {
    this.dedupe = new Dedupe(options.now);
  }

  onMessage(handler: Channel.MessageHandler): void {
    this.handler = instanceHandler(this.id, handler);
  }

  accountIdentity(): AccountIdentity | undefined {
    return this.identity === undefined ? undefined : { externalId: this.identity };
  }

  start(traceId: string): Promise<void> {
    if (this.starting !== undefined) return this.starting;
    if (this.client !== undefined)
      return Promise.reject(new TelegramAccountError("Telegram instance already started", "session_in_use"));
    const generation = this.generation;
    this.starting = this.open(traceId, generation).catch(async (error: Error) => {
      // An unconfirmed close keeps custody; the start failure stays the cause.
      await this.close(traceId).catch(() => undefined);
      throw error;
    }).finally(() => { this.starting = undefined; });
    return this.starting;
  }

  private async open(traceId: string, generation: number): Promise<void> {
    await this.closing;
    this.checkGeneration(generation);
    this.closing = undefined;
    this.terminal = undefined;
    if (this.options.telegramDataDir === undefined)
      throw new TelegramAccountError("Telegram session directory absent", "session_lost");
    const session = await accountSession(this.options.telegramDataDir);
    if (generation !== this.generation) {
      await session.release();
      this.checkGeneration(generation);
    }
    this.release = session.release;
    const client = this.sdk.client();
    this.client = client;
    this.unsubscribeState = client.onState((state) => this.stateChanged(state));
    this.unsubscribe = client.onMessage((message) => {
      if (this.terminal !== undefined) return;
      if (this.identity === undefined) this.pending.push(message);
      else this.accept(message);
    });
    const result = await client.start({
      apiId: Number(this.credentials.apiId),
      apiHash: this.credentials.apiHash,
      databaseDir: session.databaseDir,
      filesDir: session.filesDir,
    });
    this.checkGeneration(generation);
    if (this.terminal !== undefined)
      throw new TelegramAccountError("Telegram session changed during start", this.terminal);
    if (result.state !== "ready")
      throw new TelegramAccountError(`Telegram requires ${result.state}`, "login_action_required");
    if (!result.userId?.trim()) throw new TelegramAccountError("Telegram identity absent", "session_lost");
    this.identity = result.userId;
    for (const message of this.pending.splice(0)) this.accept(message);
    this.publish(Operational.Events.Info, {
      traceId, time: this.options.now(), component: "server",
      msg: "telegram account instance started", context: { userId: result.userId },
    });
  }

  private checkGeneration(generation: number): void {
    if (generation !== this.generation)
      throw new TelegramAccountError("Telegram start was stopped", "session_lost");
  }

  private accept(message: TelegramAccountMessage): void {
    const userId = this.identity;
    if (userId === undefined) return;
    const inbound = accountInbound(message, userId);
    if (inbound === null) return;
    if (message.threadId !== undefined && message.botThreadId !== undefined)
      this.remember(this.threads, `${message.chatId}:${message.botThreadId}`, message.threadId);
    if (message.botMessageId !== undefined)
      this.remember(this.replies, `${message.chatId}:${message.botMessageId}`, message.messageId);
    if (message.replyToMessageId !== undefined && message.botReplyToMessageId !== undefined)
      this.remember(this.replies, `${message.chatId}:${message.botReplyToMessageId}`, message.replyToMessageId);
    for (const media of message.media) this.sizes.set(media.fileId, media.size);
    const traceId = newTraceId(this.options.id);
    void handoffInbound({
      dedupe: this.dedupe,
      key: `${message.chatId}:${accountLocalEventId(message.messageId)}`,
      traceId,
      now: this.options.now,
      publish: this.publish,
      errorMessage: "telegram account message handling failed",
      rethrowFailure: false,
      handle: () => requireHandler(this.handler, this.id)(inbound),
    });
  }

  private remember(map: Map<string, string>, key: string, value: string): void {
    map.set(key, value);
    if (map.size > 4096) {
      const oldest = map.keys().next().value;
      if (oldest !== undefined) map.delete(oldest);
    }
  }

  async stop(traceId: string): Promise<void> {
    this.generation++;
    const closing = this.close(traceId);
    const starting = this.starting?.then(() => undefined, () => undefined);
    await Promise.all([closing, starting]);
  }

  private close(traceId: string): Promise<void> {
    if (this.closing !== undefined) return this.closing;
    this.identity = undefined;
    this.pending.length = 0;
    this.unsubscribeState?.();
    this.unsubscribeState = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    const client = this.client;
    this.client = undefined;
    const release = this.release;
    this.release = undefined;
    this.closing = (async () => {
      // Custody is released only after the SDK confirms native closure.
      await client?.close().catch((error: Error) => {
        this.publish(Operational.Events.Error, {
          traceId, time: this.options.now(), component: "server",
          msg: "telegram account close unconfirmed; session custody retained",
        });
        throw error;
      });
      await release?.();
      this.publish(Operational.Events.Info, {
        traceId, time: this.options.now(), component: "server",
        msg: "telegram account instance stopped",
      });
    })();
    return this.closing;
  }

  async history(query: Channel.HistoryQuery): Promise<ProviderHistoryResult> {
    const client = this.client;
    if (this.identity === undefined || client === undefined)
      return { status: "refused", reason: this.terminal ?? "not_ready" };
    return client.history(query.chatId, {
        limit: query.limit, ...(query.before === undefined ? {} : { before: query.before }),
      }).then((result): ProviderHistoryResult => ({
        status: "ok",
        page: {
          messages: result.messages.map(historyMessage),
          ...(result.messages.length === 0 || result.before === undefined ? {} : { before: result.before }),
        },
      }), (error: Error): ProviderHistoryResult => {
        this.methodFailure(error);
        return { status: "refused", reason: historyRefusal(error) };
      });
  }

  async download(ref: string, bounds: AttachmentBounds): Promise<MediaStream> {
    const client = this.client;
    if (this.identity === undefined || client === undefined)
      throw new TelegramAccountError("Telegram account is not ready", "session_lost");
    const match = FILE_REF.exec(ref);
    const fileId = match === null ? Number.NaN : Number(match[1]);
    if (!Number.isSafeInteger(fileId)) throw new TelegramAccountError("invalid file reference", "download_failed");
    const size = this.sizes.get(fileId);
    if (size !== undefined && size > bounds.maxBytes)
      throw new AttachmentRefused({ reason: "too_large", maxBytes: bounds.maxBytes });
    const source = await client.download(fileId, { signal: bounds.signal }).catch((error: Error) => {
      this.methodFailure(error);
      throw error;
    });
    if (!Number.isSafeInteger(source.size) || source.size < 0)
      throw new TelegramAccountError("invalid media size", "download_failed");
    if (source.size > bounds.maxBytes)
      throw new AttachmentRefused({ reason: "too_large", maxBytes: bounds.maxBytes });
    return source;
  }

  async deliver(
    externalId: string,
    payload: Outbound.Payload,
    key: string,
    conversation?: Gateway.Conversation,
    sender?: Gateway.IngestSender,
  ): Promise<Outbound.Receipt> {
    return kernelDeliveryReceipt(await this.send(externalId, payload, key, conversation, sender));
  }

  private send(
    externalId: string,
    payload: Outbound.Payload,
    key: string,
    conversation?: Gateway.Conversation,
    sender?: Gateway.IngestSender,
  ): Promise<DeliveryReceipt> {
    const chatId = conversation?.channelId ?? externalId;
    let reason: string | undefined;
    return deliverKeyed(
      this.outbound, key,
      () => {
        // Mutable admission belongs to a new attempt, never a retained receipt.
        const threadId = this.nativeId(this.threads, chatId, conversation?.threadId);
        reason = this.admission(payload, threadId);
        if (reason !== undefined) throw new TelegramAccountError(reason, "not_sent");
        const replyTo = this.nativeId(this.replies, chatId, conversation?.replyToMessageId);
        const client = this.client;
        if (this.identity === undefined || client === undefined)
          throw new TelegramAccountError("Telegram account is not ready", "not_sent");
        return translate(payload, { renderMarkdown: (text) => text, messageLimit: TEXT_LIMIT }, {
        text: (chunk) => accountSend(client, chatId, chunk, replyTo, threadId)
          .catch((error: Error) => {
            this.methodFailure(error);
            throw error;
          }),
        media: {
          limits: TELEGRAM_MEDIA_LIMITS,
          upload: (kind, bytes, caption, meta) =>
            client.send(chatId, {
              kind: kind === "audio" && meta.voice === true ? "voice" : kind,
              bytes: bytes.bytes, name: bytes.name, mime: bytes.mime,
              ...(caption === undefined ? {} : { caption }),
              ...(replyTo === undefined ? {} : { replyTo }),
              ...(threadId === undefined ? {} : { threadId }),
            }).then(({ messageId }) => ({ externalMessageId: messageId }))
              .catch((error: Error) => {
                this.methodFailure(error);
                // The platform's own size refusal names no limit; the receipt keeps what was refused.
                if (error instanceof TelegramAccountError && error.requestRefused && error.code === "media_too_large")
                  reason = `media_too_large ${kind} ${bytes.bytes.byteLength}`;
                throw error;
              }),
        },
        }, this.options.media, sender);
      },
      // An explicit native refusal is definite whatever its recovery code (FILE_TOO_BIG, AUTH_KEY_UNREGISTERED).
      (error) => error instanceof TelegramAccountError && (error.code === "not_sent" || error.requestRefused),
      this.publish, this.options,
    ).then((receipt) => reason === undefined || receipt.value !== "not_sent" ? receipt : { ...receipt, reason });
  }

  private admission(payload: Outbound.Payload, threadId: string | undefined): string | undefined {
    if (threadId !== undefined && !/^(forum|thread|direct|saved):[1-9]\d*$/.test(threadId))
      return "thread_unavailable";
    if (payload.kind === "message" && Outbound.parts(payload).some((part) =>
      part.kind === "image" || part.kind === "file" || part.kind === "audio" || part.kind === "video")
      && this.options.media === undefined)
      return "media_unavailable";
    return undefined;
  }
}
