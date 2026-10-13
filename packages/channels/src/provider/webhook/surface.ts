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
    const verdict = await verifyWebhook(
      body,
      request.headers.get("x-signature"),
      this.credentials.secretRef,
      this.resolveSecret,
    );
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
    const inbound: Channel.InboundMessage = {
      sender: { kind: "external", surface: "webhook", externalId: this.credentials.secretRef },
      facts: {
        eventId: createHash("sha256").update(body).digest("hex"),
        surface: "webhook",
        event: "webhook",
        secretRef: this.credentials.secretRef,
        author: { externalId: this.credentials.secretRef, isBot: true },
        channelId: this.credentials.id,
        addressees: [],
        dm: false,
        payload,
        render: raw,
      },
    };
    if (this.handler === null) return new Response("Handler unavailable", { status: 503 });
    await this.handler(inbound);
    return new Response("OK", { status: 200 });
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
