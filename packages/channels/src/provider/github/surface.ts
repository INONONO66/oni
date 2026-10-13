import { RateLimited } from "../../errors";
import { newTraceId } from "../../support/trace";
import { type Channel, Operational } from "@openomni/protocol";
import { z } from "zod";
import { Dedupe } from "../../support/dedupe";
import { requireHandler } from "../../support/handler-frame";
import { GitHubClient } from "./client";
import { GitHubWebhookPayloadSchemas } from "./types";
import type { EffectRunner, PublishPort } from "../../types";
import { type DeliveryReceipt, DeliveryReconciliation, isNotSent } from "../../support/deliver";
import { authenticateGitHubWebhook } from "../../authn/github";
import type { ChannelAuthnDecisionObserver } from "../../authn/types";

interface GitHubEventContent {
  text: string;
  sender: string;
  isBot: boolean;
  repo: string;
  issueNumber: number;
  issueKind: "issue" | "pr";
}
interface UnsupportedEvent {
  readonly kind: "unsupported_event";
  readonly event: string;
  readonly action: string | null;
  readonly reason: "unsupported_event" | "unsupported_action" | "invalid_payload";
}
function refusal(
  event: string,
  action: string | undefined,
  reason: UnsupportedEvent["reason"],
): UnsupportedEvent {
  return { kind: "unsupported_event", event, action: action ?? null, reason };
}
interface GitHubAuthOptions {
  readonly onDecision?: ChannelAuthnDecisionObserver;
}
const EventActionSchema = z.object({ action: z.string().optional() });
const WebhookBodySchema = z.record(z.string(), z.json());
function actionOf(raw: object): string | undefined {
  const parsed = EventActionSchema.safeParse(raw);
  return parsed.success ? parsed.data.action : undefined;
}
function issueContent(
  text: string,
  user: { login: string },
  payload: z.infer<typeof GitHubWebhookPayloadSchemas.issues>,
): GitHubEventContent {
  return {
    text,
    sender: payload.sender?.login ?? user.login,
    isBot: payload.sender?.type === "Bot",
    repo: payload.repository.full_name,
    issueNumber: payload.issue.number,
    issueKind: payload.issue.pull_request ? "pr" : "issue",
  };
}
function extractContent(event: string, raw: object): GitHubEventContent | UnsupportedEvent {
  const action = actionOf(raw);
  if (event === "issue_comment") {
    if (action !== "created") return refusal(event, action, "unsupported_action");
    const parsed = GitHubWebhookPayloadSchemas.issue_comment.safeParse(raw);
    if (!parsed.success) return refusal(event, action, "invalid_payload");
    return issueContent(parsed.data.comment.body, parsed.data.comment.user, parsed.data);
  }
  if (event === "issues") {
    if (action !== "opened") return refusal(event, action, "unsupported_action");
    const parsed = GitHubWebhookPayloadSchemas.issues.safeParse(raw);
    if (!parsed.success) return refusal(event, action, "invalid_payload");
    // `||`, not `??`: GitHub sends empty-STRING bodies too — an issue opened
    // with no body must fall back to its title so the `issues.opened` event
    // is not silently dropped as empty text.
    return issueContent(
      parsed.data.issue.body || parsed.data.issue.title,
      parsed.data.issue.user,
      parsed.data,
    );
  }
  if (event === "pull_request") {
    if (action !== "opened") return refusal(event, action, "unsupported_action");
    const parsed = GitHubWebhookPayloadSchemas.pull_request.safeParse(raw);
    if (!parsed.success) return refusal(event, action, "invalid_payload");
    return issueContent(
      parsed.data.pull_request.body || parsed.data.pull_request.title,
      parsed.data.pull_request.user,
      {
        ...parsed.data,
        issue: { ...parsed.data.pull_request, pull_request: {} },
      },
    );
  }
  return refusal(event, action, "unsupported_event");
}
type PreparedWebhook = Readonly<{
  traceId: string;
  deliveryId: string | null;
  dedupeToken: symbol | undefined;
  content: GitHubEventContent;
  inbound: Channel.InboundMessage;
}>;
type WebhookPreparation = PreparedWebhook | Readonly<{ response: Response }>;

export class GitHubAdapter implements Channel.Surface {
  readonly id = "github";
  private readonly client: GitHubClient;
  private readonly dedupe: Dedupe;
  private readonly outbound = new DeliveryReconciliation();
  private handler: Channel.MessageHandler | null = null;

  constructor(
    private readonly secret: string,
    readonly config: Channel.Config,
    private readonly publish: PublishPort,
    private readonly options: {
      readonly now: () => number;
      readonly id: () => string;
      readonly run: EffectRunner;
    },
    githubToken?: string,
    private readonly authOptions: GitHubAuthOptions = {},
  ) {
    this.dedupe = new Dedupe(options.now);
    this.client = new GitHubClient(publish, options.now, options.run, githubToken);
  }

  async deliver(
    externalId: string,
    body: string,
    idempotencyKey: string,
  ): Promise<DeliveryReceipt> {
    const target = /^([a-zA-Z0-9-]+\/[a-zA-Z0-9_.-]+)#([1-9][0-9]*)$/.exec(externalId);
    if (target?.[1] === undefined || target[2] === undefined) return { value: "not_sent" };
    const issueNumber = Number(target[2]);
    if (!Number.isSafeInteger(issueNumber) || target[1].endsWith("/.") || target[1].endsWith("/.."))
      return { value: "not_sent" };
    const repo = target[1];
    return this.outbound.run(idempotencyKey, async () => {
      const traceId = newTraceId(this.options.id);
      try {
        return await this.client.postComment(repo, issueNumber, body, traceId, idempotencyKey);
      } catch (error) {
        // Same physical-evidence rule as every other driver: a refused connection is a safe resend.
        const value =
          error instanceof Error &&
          // Same physical-evidence rule as every other driver: a refused connection is a safe resend.
          isNotSent(error, (cause) => cause instanceof RateLimited && cause.status === 429)
            ? "not_sent"
            : "unknown";
        this.publish(Operational.Events.Warn, {
          traceId,
          time: this.options.now(),
          component: "github",
          msg: "GitHub delivery failed",
          context: { error: String(error), value },
        });
        return { value };
      }
    });
  }

  onMessage(handler: Channel.MessageHandler): void {
    this.handler = handler;
  }
  async start(traceId: string): Promise<void> {
    requireHandler(this.handler, "github");
    this.publish(Operational.Events.Info, {
      traceId,
      time: this.options.now(),
      component: "server",
      msg: "github webhook handler ready",
    });
  }
  stop(_traceId: string): void {
    // Webhook transport has no persistent connection.
  }

  async handleWebhook(request: Request): Promise<Response> {
    // Origin: the first frame of an inbound webhook delivery — this ONE mint
    // is the message's trace, carried to the run (D11).
    const traceId = newTraceId(this.options.id);
    const auth = await authenticateGitHubWebhook({
      request,
      secret: this.secret,
      now: this.options.now,
      ...(this.authOptions.onDecision === undefined
        ? {}
        : { onDecision: this.authOptions.onDecision }),
    });
    if (auth.response) return auth.response;
    let body: ReturnType<typeof WebhookBodySchema.safeParse>;
    try {
      body = WebhookBodySchema.safeParse(JSON.parse(auth.body ?? ""));
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }
    const preparation = this.prepareWebhook(request, body, traceId);
    if ("response" in preparation) return preparation.response;
    return this.dispatchWebhook(preparation);
  }

  private observeUnsupported(
    observation: UnsupportedEvent,
    deliveryId: string | null,
    traceId: string,
  ): WebhookPreparation {
    this.publish(Operational.Events.Warn, {
      traceId,
      time: this.options.now(),
      component: "github",
      msg: "github event not ingested",
      context: { ...observation, deliveryId },
    });
    return { response: Response.json(observation) };
  }

  private prepareWebhook(
    request: Request,
    body: ReturnType<typeof WebhookBodySchema.safeParse>,
    traceId: string,
  ): WebhookPreparation {
    const deliveryId = request.headers.get("x-github-delivery");
    const dedupeAcquisition = deliveryId === null ? undefined : this.dedupe.acquire(deliveryId);
    if (dedupeAcquisition?.duplicate)
      return { response: new Response("Already processed", { status: 200 }) };
    const dedupeToken = dedupeAcquisition?.token;
    const event = request.headers.get("x-github-event");
    if (!event) return { response: new Response("Missing event", { status: 400 }) };
    if (!body.success)
      return this.observeUnsupported(
        refusal(event, undefined, "invalid_payload"),
        deliveryId,
        traceId,
      );
    const raw = body.data;
    const eventKey = `${event}.${actionOf(raw)}`;
    this.publish(Operational.Events.Info, {
      // deliveryId: GitHub's own per-delivery id (x-github-delivery) — the
      // natural correlation key between this trace and GitHub's audit log.
      traceId,
      time: this.options.now(),
      component: "server",
      msg: "github event received",
      context: { event: eventKey, deliveryId },
    });
    const content = extractContent(event, raw);
    if ("kind" in content) return this.observeUnsupported(content, deliveryId, traceId);
    if (deliveryId === null || deliveryId.length === 0)
      return { response: new Response("Missing delivery id", { status: 400 }) };
    const addressees = [
      ...new Set(
        [...content.text.matchAll(/@([a-zA-Z0-9][a-zA-Z0-9-]*)/g)].flatMap((match) =>
          match[1] === undefined ? [] : [match[1]],
        ),
      ),
    ];
    const inbound: Channel.InboundMessage = {
      sender: { kind: "external", surface: "github", externalId: content.sender },
      facts: {
        eventId: deliveryId,
        event: "github",
        githubEvent: eventKey,
        author: { externalId: content.sender, isBot: content.isBot },
        surface: "github",
        workspaceId: content.repo,
        channelId: `${content.issueKind}-${content.issueNumber}`,
        addressees: addressees.map((externalId) => ({ externalId })),
        dm: false,
        reply: {
          chain: [],
          threadId: String(content.issueNumber),
          externalConversationId: `github:${content.repo}:${content.issueKind}:${content.issueNumber}`,
        },
        payload: raw,
        render: content.text,
      },
    };
    this.publish(Operational.Events.Debug, {
      traceId,
      time: this.options.now(),
      component: "server",
      msg: "github message received",
      context: { repo: content.repo, issue: content.issueNumber, event: eventKey },
    });
    return { traceId, deliveryId, dedupeToken, content, inbound };
  }

  /** Awaits the inbound handler; a handler throw releases the in-memory delivery claim and returns 500 so GitHub retries. */
  private async dispatchWebhook(prepared: PreparedWebhook): Promise<Response> {
    try {
      await (this.handler as Channel.MessageHandler)(prepared.inbound);
    } catch (err) {
      this.publish(Operational.Events.Error, {
        traceId: prepared.traceId,
        time: this.options.now(),
        component: "server",
        msg: "github message handler error",
        context: {
          repo: prepared.content.repo,
          issue: prepared.content.issueNumber,
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        },
      });
      if (prepared.deliveryId && prepared.dedupeToken !== undefined)
        this.dedupe.forget(prepared.deliveryId, prepared.dedupeToken);
      return new Response("Processing failed", { status: 500 });
    }
    return new Response("OK", { status: 200 });
  }
}
