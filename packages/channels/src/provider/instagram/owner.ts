import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Channel, type Gateway, Operational, type Outbound } from "@oni/protocol";
import { ChannelsFailure } from "../../errors";
import { Dedupe } from "../../support/dedupe";
import { type DeliveryReceipt, DeliveryReconciliation, deliverKeyed } from "../../support/deliver";
import { requireHandler } from "../../support/handler-frame";
import { handoffInbound } from "../../support/inbound-handoff";
import { type ListenerCustody, listenerCustody, RECONNECT_ATTEMPT_BOUND } from "../../support/sdk-listener";
import { newTraceId } from "../../support/trace";
import { translate } from "../../support/translate";
import type { PublishPort } from "../../types";
import type { AccountIdentity, OwnerPosture, ProviderOptions } from "../contract";
import { INSTAGRAM_RENDER } from "./format";
import {
  type InstagramMessage,
  type InstagramOwnerApi,
  type InstagramOwnerEventMap,
  type InstagramOwnerSdk,
  instagramOwnerSdk,
} from "./owner-sdk";

/** The vault-opened account session: the SDK's session state as the login helper sealed it. */
export interface InstagramOwnerCredentials {
  readonly session: string;
}

/** The inbox poll cadence when the realtime channel is down (the SDK's own default). */
const POLL_INTERVAL_MS = 5_000;

/**
 * The one code the SDK's listener gives a refused inbox read: it folds every
 * non-ok answer (`login_required`, `checkpoint_required`, an outage alike)
 * into it and discards the platform's reason, on both transports.
 */
const INBOX_REFUSED = "inbox_error";

/** Refusals proving nothing was posted: the platform said no, or the request never left. */
const REJECTED = new Set(["rate_limited", "send_failed", "not_authenticated"]);

function instagramCode(error: Error): string | undefined {
  const code = (error as Error & { readonly code?: string | number }).code;
  return error.name === "InstagramError" && code !== undefined ? String(code) : undefined;
}

/**
 * Instagram as the Owner's own account (#1569 lane 7): the `instagram:owner`
 * instance — the platform has no bot account. Intake is the account's inbox
 * through the SDK's hybrid listener (realtime, polling fallback: a realtime
 * failure at boot hands over to polling, whose `connected` settles the
 * start) under the declared posture: every inbox message is a DM to the
 * Owner, so `mentions_and_dms` and `all` both read the whole inbox and
 * `none` mounts no listener; the account's own messages (`is_outgoing`) are
 * never an outside event. The SDK reports a session the platform no longer
 * honours and an inbox outage with one code, so a streak of refused reads as
 * long as custody's own bound, with no message or reconnect between, is the
 * typed dead surface (the poller never re-emits `connected`, so it would
 * otherwise poll a dead session forever). Delivery posts into the person's thread, or opens the
 * direct thread with them when no conversation is named; one physical
 * attempt per idempotency key (the SDK retries nothing), a platform
 * refusal is `not_sent`, a lost response is `unknown`. No media upload, no
 * reactions, no typing.
 */
export class InstagramOwnerAdapter implements Channel.Surface {
  readonly id = "instagram:owner";
  /** The surface contract's config: an Owner instance carries its posture instead. */
  readonly config: Channel.Config = {};

  private readonly client: InstagramOwnerApi;
  private readonly sdk: InstagramOwnerSdk;
  private readonly dedupe: Dedupe;
  private readonly outbound = new DeliveryReconciliation();
  private custody: ListenerCustody | null = null;
  private handler: Channel.MessageHandler | null = null;
  private userId: string | null = null;
  /** Refused inbox reads since the last message or reconnect. */
  private inboxRefusals = 0;

  constructor(
    private readonly credentials: InstagramOwnerCredentials,
    readonly posture: OwnerPosture,
    private readonly publish: PublishPort,
    private readonly options: ProviderOptions,
    sdk: InstagramOwnerSdk = instagramOwnerSdk(),
  ) {
    this.sdk = sdk;
    this.client = sdk.client();
    this.dedupe = new Dedupe(options.now);
  }

  onMessage(handler: Channel.MessageHandler): void {
    this.handler = handler;
  }

  /**
   * Restores the vault-opened session through a file the SDK reads once
   * (removed before anything else runs) and clears the session path so the
   * SDK persists nothing; the session must name the account. Under an
   * intake posture the inbox listener then opens.
   */
  /** The account's Instagram user pk (#1600), the shape an Instagram endpoint takes. */
  account(): AccountIdentity | undefined {
    return this.userId === null ? undefined : { externalId: this.userId };
  }

  async start(traceId: string): Promise<void> {
    await this.restoreSession();
    const userId = this.client.getUserId();
    if (userId === null)
      throw new ChannelsFailure({ operation: "instagram.owner.start", cause: "the session names no account" });
    this.userId = userId;
    const listens = this.posture.intake !== "none" && this.handler !== null;
    if (listens) await this.listen();
    this.publish(Operational.Events.Info, {
      traceId,
      time: this.options.now(),
      component: "server",
      msg: "instagram owner instance started",
      context: { userId, listener: listens ? this.posture.intake : "none" },
    });
  }

  private async restoreSession(): Promise<void> {
    const directory = await mkdtemp(join(tmpdir(), "oni-instagram-"));
    const path = join(directory, "session.json");
    try {
      await writeFile(path, this.credentials.session, { mode: 0o600 });
      await this.client.loadSession(path);
    } finally {
      await rm(directory, { recursive: true, force: true });
      this.client.setSessionPath("");
    }
  }

  private async listen(): Promise<void> {
    const listener = this.sdk.listener(this.client, { pollInterval: POLL_INTERVAL_MS });
    let realtimeFailed = false;
    const custody = listenerCustody<InstagramOwnerEventMap>(listener, {
      label: "instagram inbox",
      publish: this.publish,
      now: this.options.now,
      id: this.options.id,
      // The SDK's hybrid start() resolves before any transport is up and
      // never rejects; a close before `connected` is this start's failure.
      failOnCloseBeforeConnected: true,
      // The hybrid tries realtime first: its failure is the one error before
      // `connected` the SDK recovers from, by polling. A refused inbox read,
      // or any second error, is the poller's own first cycle failing.
      recoverableBeforeConnected: (error) => {
        if (realtimeFailed || instagramCode(error) === INBOX_REFUSED) return false;
        realtimeFailed = true;
        return true;
      },
      onConnected: () => {
        this.inboxRefusals = 0;
      },
      terminal: (error) => this.refusedInbox(error),
    });
    listener.on("message", (message) => {
      this.inboxRefusals = 0;
      this.handleMessage(message);
    });
    this.custody = custody;
    try {
      await custody.start();
    } catch (error) {
      this.custody = null;
      throw error;
    }
  }

  /** A refused inbox read counts toward the streak that ends the surface; any other error is the SDK's to recover from. */
  private refusedInbox(error: Error): boolean {
    if (instagramCode(error) !== INBOX_REFUSED) return false;
    this.inboxRefusals += 1;
    return this.inboxRefusals >= RECONNECT_ATTEMPT_BOUND;
  }

  stop(traceId: string): void {
    this.custody?.stop();
    this.custody = null;
    this.publish(Operational.Events.Info, {
      traceId,
      time: this.options.now(),
      component: "server",
      msg: "instagram owner instance stopped",
    });
  }

  /** One inbox message: the account's own are never outside events; every other one is a DM to the Owner. */
  private handleMessage(message: InstagramMessage): void {
    if (message.is_outgoing || message.from === this.userId) return;
    const text = message.text ?? "";
    const attachments =
      message.media_url === undefined
        ? []
        : [{ kind: message.type === "media" || message.type === "raven_media" ? ("image" as const) : ("file" as const), ref: message.media_url }];
    if (text === "" && attachments.length === 0) return;
    const traceId = newTraceId(this.options.id);
    void handoffInbound({
      dedupe: this.dedupe,
      key: message.id,
      traceId,
      now: this.options.now,
      publish: this.publish,
      errorMessage: "instagram owner message handling failed",
      rethrowFailure: false,
      handle: async () => {
        await requireHandler(this.handler, "instagram:owner")({
          sender: { kind: "external", surface: "instagram", externalId: message.from },
          facts: {
            eventId: message.id,
            event: "message",
            author: { externalId: message.from, isBot: false },
            surface: "instagram",
            channelId: message.thread_id,
            addressees: [],
            dm: true,
            receivedBy: "owner",
            payload: { ...message },
            render: text,
            ...(attachments.length === 0 ? {} : { attachments }),
          },
        });
      },
    });
  }

  /**
   * Delivery as the Owner: the registered ActorEndpoint externalId is the
   * person's user id; the conversation names their thread, else the direct
   * thread with them is opened by the send itself.
   */
  deliver(
    externalId: string,
    payload: Outbound.Payload,
    idempotencyKey: string,
    conversation?: Gateway.Conversation,
  ): Promise<DeliveryReceipt> {
    const threadId = conversation?.channelId;
    return deliverKeyed(
      this.outbound,
      idempotencyKey,
      async () =>
        await translate(payload, INSTAGRAM_RENDER, {
          text: async (chunk) => {
            const sent =
              threadId === undefined
                ? await this.client.sendMessageToUser(externalId, chunk)
                : await this.client.sendMessage(threadId, chunk);
            return sent.id;
          },
        }),
      (error) => {
        const code = instagramCode(error);
        return code !== undefined && REJECTED.has(code);
      },
      this.publish,
      this.options,
    );
  }
}
