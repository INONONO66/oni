import { createHmac, timingSafeEqual } from "node:crypto";
import { type Channel, Operational, Outbound } from "@oni/protocol";
import { ChannelsFailure, RateLimited } from "../../errors";
import { Dedupe } from "../../support/dedupe";
import { type DeliveryReceipt, DeliveryReconciliation, isNotSent } from "../../support/deliver";
import { requireHandler } from "../../support/handler-frame";
import { newTraceId } from "../../support/trace";
import type { EffectRunner, PublishPort } from "../../types";
import type { OwnerPosture } from "../contract";
import { LinearClient } from "./client";
import { type LinearOwnerCredentials, LinearWebhookEnvelope, LinearWebhookPayloadSchemas } from "./types";

/**
 * How far from the injected clock a delivery's `webhookTimestamp` may be,
 * either way: the minute Linear's own reference handler allows. A retry
 * Linear makes later carries whatever stamp Linear gives it; one past the
 * window is refused as stale, as that handler refuses it.
 */
export const LINEAR_REPLAY_WINDOW_MS = 60_000;

interface LinearEventContent {
  readonly text: string;
  readonly sender: string;
  readonly isBot: boolean;
  readonly issueId: string;
  readonly issueKey: string;
  readonly messageId: string;
  readonly kind: "issue" | "comment";
}

/** An integration or bot acted: the envelope's actor is not a user, or the entity names a bot actor. */
function actedByBot(envelope: LinearWebhookEnvelope, botActor: string | null | undefined): boolean {
  if (typeof botActor === "string") return true;
  const type = envelope.actor?.type;
  return typeof type === "string" && type !== "user";
}
interface UnsupportedEvent {
  readonly kind: "unsupported_event";
  readonly type: string;
  readonly action: string;
  readonly reason: "unsupported_event" | "unsupported_action" | "invalid_payload";
}
function refusal(type: string, action: string, reason: UnsupportedEvent["reason"]): UnsupportedEvent {
  return { kind: "unsupported_event", type, action, reason };
}

/** `Linear-Signature` is the hex HMAC-SHA256 of the raw body under the webhook's signing secret; compared by bytes, in constant time. */
function verifySignature(body: Uint8Array, header: string | null, secret: string): boolean {
  if (header === null) return false;
  const presented = Buffer.from(header);
  const digest = Buffer.from(createHmac("sha256", secret).update(body).digest("hex"));
  return presented.length === digest.length && timingSafeEqual(presented, digest);
}

/** The two events the surface reads: a new issue (title and description) and a new comment (its body). */
function extractContent(envelope: LinearWebhookEnvelope): LinearEventContent | UnsupportedEvent {
  if (envelope.action !== "create") return refusal(envelope.type, envelope.action, "unsupported_action");
  if (envelope.type === "Issue") {
    const parsed = LinearWebhookPayloadSchemas.Issue.safeParse(envelope.data);
    if (!parsed.success) return refusal(envelope.type, envelope.action, "invalid_payload");
    const description = parsed.data.description ?? "";
    return {
      kind: "issue",
      text: description === "" ? parsed.data.title : `${parsed.data.title}\n\n${description}`,
      sender: envelope.actor?.id ?? parsed.data.creatorId ?? "linear",
      isBot: actedByBot(envelope, parsed.data.botActor),
      issueId: parsed.data.id,
      issueKey: parsed.data.identifier ?? parsed.data.id,
      messageId: parsed.data.id,
    };
  }
  if (envelope.type === "Comment") {
    const parsed = LinearWebhookPayloadSchemas.Comment.safeParse(envelope.data);
    if (!parsed.success) return refusal(envelope.type, envelope.action, "invalid_payload");
    const issueId = parsed.data.issueId ?? parsed.data.issue?.id;
    // A comment on a document or a project update is not an issue's.
    if (issueId === undefined || issueId === null) return refusal(envelope.type, envelope.action, "unsupported_event");
    return {
      kind: "comment",
      text: parsed.data.body,
      sender: envelope.actor?.id ?? parsed.data.userId ?? "linear",
      isBot: actedByBot(envelope, parsed.data.botActor),
      issueId,
      issueKey: parsed.data.issue?.identifier ?? issueId,
      messageId: parsed.data.id,
    };
  }
  return refusal(envelope.type, envelope.action, "unsupported_event");
}

type PreparedWebhook = Readonly<{
  traceId: string;
  deliveryId: string;
  dedupeToken: symbol | undefined;
  content: LinearEventContent;
  inbound: Channel.InboundMessage;
}>;
type WebhookPreparation = PreparedWebhook | Readonly<{ response: Response }>;

/**
 * Linear as the Owner's own account (#1569 lane 9b): the `linear:owner`
 * instance — a personal API key is a person's, so there is no bot account
 * to declare. Ingress is the workspace webhook for new issues and comments
 * (signed, within Linear's own minute of replay window, deduplicated by
 * delivery) under the declared posture: `all` reads every
 * new issue and comment; `mentions_and_dms` reads the comments that mention
 * the Owner (the platform has no DMs, and a new issue is intake only under
 * `all`); `none` answers without reading. The account's own actions are
 * never an outside event — the key's user, read from `viewer` at start
 * (the start fails closed when a key cannot say who it is), else the
 * declared `ownerUserId`. A perimeter refusal is answered 200 (Linear must
 * not redeliver a message the router refused); a failure 500 so it does.
 * Replies as the Owner land as comments on the issue the conversation
 * names, under the reply door's Owner path.
 */
export class LinearAdapter implements Channel.Surface {
  readonly id = "linear:owner";
  /** The surface contract's config: an Owner instance carries its posture instead. */
  readonly config: Channel.Config = {};
  private readonly client: LinearClient;
  private readonly dedupe: Dedupe;
  private readonly outbound = new DeliveryReconciliation();
  private handler: Channel.MessageHandler | null = null;
  private ownerUserId: string | undefined;
  private ownerNames: string[] = [];

  constructor(
    private readonly credentials: LinearOwnerCredentials,
    readonly posture: OwnerPosture,
    private readonly publish: PublishPort,
    private readonly options: { readonly now: () => number; readonly id: () => string; readonly run: EffectRunner },
  ) {
    this.dedupe = new Dedupe(options.now);
    this.client = new LinearClient(publish, options.now, options.run, credentials.token);
    this.ownerUserId = credentials.ownerUserId;
  }

  /** A comment on the issue carries the payload's text reading; a reaction has no comment to land in and is not sent. */
  async deliver(issueId: string, payload: Outbound.Payload, idempotencyKey: string): Promise<DeliveryReceipt> {
    if (payload.kind === "react") return { value: "not_sent" };
    const body = Outbound.text(payload);
    return this.outbound.run(idempotencyKey, async () => {
      const traceId = newTraceId(this.options.id);
      try {
        return await this.client.createComment(issueId, body, traceId, idempotencyKey);
      } catch (error) {
        // Same physical-evidence rule as every other driver: a refused connection is a safe resend.
        const value =
          error instanceof Error && isNotSent(error, (cause) => cause instanceof RateLimited && cause.status === 429)
            ? "not_sent"
            : "unknown";
        this.publish(Operational.Events.Warn, {
          traceId,
          time: this.options.now(),
          component: "linear",
          msg: "Linear delivery failed",
          context: { error: String(error), value },
        });
        return { value };
      }
    });
  }

  onMessage(handler: Channel.MessageHandler): void {
    this.handler = handler;
  }

  /** The key's own user is what tells the Owner's actions apart; a key that cannot say fails the start. */
  async start(traceId: string): Promise<void> {
    requireHandler(this.handler, "linear:owner");
    if (this.credentials.token !== undefined) {
      const me = await this.client.viewer(traceId);
      if (me === undefined)
        throw new ChannelsFailure({ operation: "linear.owner.start", cause: "the api key cannot name its own user" });
      this.ownerUserId = this.credentials.ownerUserId ?? me.id;
      this.ownerNames = [me.name, me.displayName].flatMap((name) => (name === undefined || name === "" ? [] : [name]));
    }
    // #1600 lane R3: under the default posture only a mention of the Owner is intake; with nothing naming the Owner the instance would mount deaf.
    if (this.ownerUserId === undefined && this.posture.intake === "mentions_and_dms")
      throw new ChannelsFailure({
        operation: "linear.owner.start",
        cause: "no api key and no ownerUserId: under mentions_and_dms nothing can name the Owner",
      });
    this.publish(Operational.Events.Info, {
      traceId,
      time: this.options.now(),
      component: "server",
      msg: "linear owner instance started",
      context: { ownerUserId: this.ownerUserId ?? "unknown", intake: this.posture.intake },
    });
  }

  stop(_traceId: string): void {
    // Webhook transport has no persistent connection.
  }

  async handleWebhook(request: Request): Promise<Response> {
    const traceId = newTraceId(this.options.id);
    const body = new Uint8Array(await request.arrayBuffer());
    const signature = request.headers.get("linear-signature");
    if (signature === null) return new Response("Missing signature", { status: 401 });
    if (!verifySignature(body, signature, this.credentials.secret))
      return new Response("Invalid signature", { status: 401 });
    const envelope = this.readEnvelope(body);
    if (envelope === undefined) return new Response("Invalid payload", { status: 400 });
    if (Math.abs(this.options.now() - envelope.webhookTimestamp) > LINEAR_REPLAY_WINDOW_MS)
      return new Response("Stale timestamp", { status: 401 });
    if (this.posture.intake === "none") return new Response("Intake off", { status: 200 });
    const preparation = this.prepareWebhook(request, envelope, traceId);
    if ("response" in preparation) return preparation.response;
    return this.dispatchWebhook(preparation);
  }

  private readEnvelope(body: Uint8Array): LinearWebhookEnvelope | undefined {
    try {
      const parsed = LinearWebhookEnvelope.safeParse(JSON.parse(new TextDecoder().decode(body)));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  private observeUnsupported(observation: UnsupportedEvent, deliveryId: string, traceId: string): WebhookPreparation {
    this.publish(Operational.Events.Warn, {
      traceId,
      time: this.options.now(),
      component: "linear",
      msg: "linear event not ingested",
      context: { ...observation, deliveryId },
    });
    return { response: Response.json(observation) };
  }

  /** Whether the Owner is named: by user id, or by `@` and either name the key reports. */
  private mentionsOwner(text: string): boolean {
    if (this.ownerUserId !== undefined && text.includes(this.ownerUserId)) return true;
    return this.ownerNames.some((name) => text.includes(`@${name}`));
  }

  private prepareWebhook(request: Request, envelope: LinearWebhookEnvelope, traceId: string): WebhookPreparation {
    const content = extractContent(envelope);
    // Linear's own delivery id correlates the trace with its audit log; the entity id stands in when it is absent.
    const deliveryId =
      request.headers.get("linear-delivery") ??
      `${envelope.type}:${envelope.action}:${"kind" in content && content.kind === "unsupported_event" ? envelope.webhookTimestamp : content.messageId}`;
    const acquisition = this.dedupe.acquire(deliveryId);
    if (acquisition.duplicate) return { response: new Response("Already processed", { status: 200 }) };
    if (content.kind === "unsupported_event") return this.observeUnsupported(content, deliveryId, traceId);
    if (this.ownerUserId !== undefined && content.sender === this.ownerUserId)
      return { response: new Response("Own action", { status: 200 }) };
    const mentioned = this.mentionsOwner(content.text);
    if (this.posture.intake !== "all" && !(content.kind === "comment" && mentioned))
      return { response: new Response("Not addressed to the Owner", { status: 200 }) };
    this.publish(Operational.Events.Info, {
      traceId,
      time: this.options.now(),
      component: "server",
      msg: "linear event received",
      context: { event: `${envelope.type}.${envelope.action}`, issue: content.issueKey, deliveryId },
    });
    const inbound: Channel.InboundMessage = {
      sender: { kind: "external", surface: "linear", externalId: content.sender },
      facts: {
        eventId: deliveryId,
        event: mentioned ? "mention" : "linear",
        author: { externalId: content.sender, isBot: content.isBot },
        surface: "linear",
        ...(envelope.organizationId === undefined || envelope.organizationId === null ? {} : { workspaceId: envelope.organizationId }),
        channelId: content.issueId,
        addressees: mentioned && this.ownerUserId !== undefined ? [{ externalId: this.ownerUserId }] : [],
        dm: false,
        receivedBy: "owner",
        reply: {
          chain: [],
          threadId: content.issueId,
          externalConversationId: `linear:${content.issueId}`,
        },
        payload: envelope,
        render: content.text,
      },
    };
    return { traceId, deliveryId, dedupeToken: acquisition.token, content, inbound };
  }

  /**
   * Awaits the inbound handler. The router's refusal is this surface's
   * verdict too — answered 200, so Linear does not redeliver what the
   * perimeter refused; a failure releases the delivery claim and answers
   * 500 so Linear retries.
   */
  private async dispatchWebhook(prepared: PreparedWebhook): Promise<Response> {
    try {
      await (this.handler as Channel.MessageHandler)(prepared.inbound);
    } catch (error) {
      if (error instanceof Error && /refused/i.test(error.name)) {
        this.publish(Operational.Events.Warn, {
          traceId: prepared.traceId,
          time: this.options.now(),
          component: "linear",
          msg: "linear event not ingested",
          context: { issue: prepared.content.issueKey, reason: error.message },
        });
        return new Response("Not ingested", { status: 200 });
      }
      this.publish(Operational.Events.Error, {
        traceId: prepared.traceId,
        time: this.options.now(),
        component: "server",
        msg: "linear message handler error",
        context: {
          issue: prepared.content.issueKey,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      if (prepared.dedupeToken !== undefined) this.dedupe.forget(prepared.deliveryId, prepared.dedupeToken);
      return new Response("Processing failed", { status: 500 });
    }
    return new Response("OK", { status: 200 });
  }
}
