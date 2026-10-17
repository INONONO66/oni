import { createHash } from "node:crypto";
import { type Channel, Operational } from "@openomni/protocol";
import type { PublishPort } from "../../types";
import type { SecretRefPort, WebhookCredentials, WebhookRefusal } from "./types";
import { verifyWebhook } from "./verify";

export class WebhookAdapter implements Channel.Surface {
  readonly id = "webhook";
  private handler: Channel.MessageHandler | null = null;

  constructor(
    private readonly credentials: WebhookCredentials,
    readonly config: Channel.Config,
    private readonly publish: PublishPort,
    private readonly options: { readonly now: () => number; readonly id: () => string },
    private readonly resolveSecret: SecretRefPort,
  ) {}

  onMessage(handler: Channel.MessageHandler): void {
    this.handler = handler;
  }
  async start(_traceId: string): Promise<void> {
    // HTTP calls enter through the webhook handler.
  }
  stop(_traceId: string): void {
    // HTTP calls have no persistent transport.
  }

  async handleWebhook(request: Request): Promise<Response> {
    const body = new Uint8Array(await request.arrayBuffer());
    const verdict = await verifyWebhook(body, request.headers.get("x-signature"), this.credentials, this.resolveSecret);
    if ("refused" in verdict) {
      this.publishRefusal(verdict);
      return Response.json(verdict, { status: 401 });
    }
    const raw = new TextDecoder().decode(body);
    // The payload keeps its parsed structure (or the raw string when it is
    // not JSON); `render` always carries the raw body as delivered, so no
    // downstream consumer ever sees a re-stringified copy of a parse.
    let payload: Channel.InboundMessage["facts"]["payload"] = raw;
    if (request.headers.get("content-type")?.includes("application/json")) {
      try {
        payload = JSON.parse(raw);
      } catch {
        return new Response("Invalid JSON", { status: 400 });
      }
    }
    // The principal a delivery speaks as: the vault row that verified it, else the declaration itself.
    const principal = this.credentials.secretRef ?? `webhook:${this.credentials.id}`;
    const inbound: Channel.InboundMessage = {
      sender: { kind: "external", surface: "webhook", externalId: principal },
      facts: {
        eventId: createHash("sha256").update(body).digest("hex"),
        surface: "webhook",
        event: "webhook",
        ...(this.credentials.secretRef === undefined ? {} : { secretRef: this.credentials.secretRef }),
        author: { externalId: principal, isBot: true },
        channelId: this.credentials.id,
        addressees: [],
        dm: false,
        payload,
        render: raw,
      },
    };
    if (this.handler === null) return new Response("Handler unavailable", { status: 503 });
    return this.dispatch(inbound);
  }

  /**
   * Awaits the inbound handler (#1600 lane R3; the first cut let a throw
   * escape and reset the connection). A perimeter refusal is this surface's
   * own verdict — answered 200 so the sender never redelivers what the
   * Owner's policy refused; a failure answers 500 so it can.
   */
  private async dispatch(inbound: Channel.InboundMessage): Promise<Response> {
    try {
      await (this.handler as Channel.MessageHandler)(inbound);
      return new Response("OK", { status: 200 });
    } catch (error) {
      const refused = error instanceof Error && /refused/i.test(error.name);
      this.publish(refused ? Operational.Events.Warn : Operational.Events.Error, {
        traceId: this.options.id(),
        time: this.options.now(),
        component: "server",
        msg: refused ? "webhook event not ingested" : "webhook message handler error",
        context: { webhookId: this.credentials.id, error: error instanceof Error ? error.message : String(error) },
      });
      return refused ? new Response("Not ingested", { status: 200 }) : new Response("Processing failed", { status: 500 });
    }
  }

  private publishRefusal(refusal: WebhookRefusal): void {
    this.publish(Operational.Events.Warn, {
      traceId: this.options.id(),
      time: this.options.now(),
      component: "server",
      msg: "webhook signature refused",
      context: { webhookId: this.credentials.id, ...refusal },
    });
  }
}
