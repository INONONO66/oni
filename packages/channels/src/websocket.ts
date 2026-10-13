import { z } from "zod";
import { Effect } from "effect";
import { decodeChannelFailure, DeliveryNotSent, InvalidInbound, type ChannelError } from "./errors";
import { newTraceId } from "./support/trace";
import { Channel, Gateway, Ingress, Operational, SessionFork, SessionRead } from "@openomni/protocol";
import { authenticateWebSocketUpgrade } from "./authn/websocket";
import type { ChannelAuthnDecisionObserver } from "./authn/types";
import type { PublishPort } from "./types";

export type WebSocketMessageHandler = (
  message: Channel.InboundMessage,
) => Effect.Effect<void, ChannelError> | Effect.Effect<Gateway.IngestResult, ChannelError>;

export type WebSocketFrameOutcome =
  | Ingress.AutomationRequest
  | Ingress.AutomationRefused
  | z.infer<typeof SessionRead.Receipt>
  | SessionRead.Bound
  | SessionRead.Request
  | SessionFork.Request
  | { readonly type: "receipt"; readonly inputId: string; readonly result: Gateway.IngestResult }
  | WebSocketKeyRefusal;

/** A keyless text frame is refused at the perimeter; no deduplication key is ever minted for it. */
type WebSocketKeyRefusal = {
  readonly admitted: false;
  readonly reason: "missing_key";
};

export interface WebSocketConfig {
  /** Injected wall clock; the perimeter never reads ambient time. */
  now: () => number;
  /** Injected id minter; the perimeter never reads ambient entropy. */
  id: () => string;
  token?: string;
  onAuthDecision?: ChannelAuthnDecisionObserver;
  /** Compose with the same gateway.ingest used by ordinary channel messages. */
  onRequestAnswer?: (
    sender: Gateway.IngestSender & { kind: "external" },
    answer: Gateway.RequestAnswer,
  ) => Effect.Effect<Gateway.IngestResult, ChannelError>;
}

export interface WsConnectionData {
  /** Trusted session binding, set by the host, never decoded from a client frame. */
  sessionId?: string;
  surfaceKey: string;
  authenticated: boolean;
  /** Declared actor address or a connection-local deliverable address. */
  externalId: string;
}

export interface WsConnection {
  data: WsConnectionData;
  send(msg: string): void;
}

interface WebSocketUpgradeOptions {
  data: WsConnectionData;
}

const RequestAnswerFrame = Gateway.RequestAnswer.extend({
  type: z.literal("request_answer"),
  kind: z.json().optional(),
}).transform(
  (frame): Gateway.RequestAnswer => ({
    kind: "request_answer",
    inputId: frame.inputId,
    request: frame.request,
    decision: frame.decision,
    credential: frame.credential,
  }),
);
const TextFrame = z
  .object({
    type: z
      .json()
      .optional()
      .refine((type) => type !== "request_answer" && type !== "session_read" && type !== "session_fork"),
    text: z.string().min(1),
    eventId: z.string().min(1).optional().catch(undefined),
    replyToId: z.string().min(1).optional().catch(undefined),
  })
  .transform((frame) => ({
    kind: "message" as const,
    text: frame.text,
    eventId: frame.eventId,
    replyToId: frame.replyToId,
  }));
const WebSocketFrame = z.union([SessionRead.Request, SessionFork.Request, RequestAnswerFrame, TextFrame]);

export class WebSocketHandler {
  /**
   * Live connections by declared externalId, last-wins: a reconnect replaces
   * the previous socket as the delivery target. Everyone on this socket is
   * already behind the owner-tier upgrade gate, so the declaration is an
   * address, not an authentication.
   */
  private readonly connections = new Map<string, WsConnection>();

  constructor(
    private readonly handler: WebSocketMessageHandler,
    private readonly publish: PublishPort,
    private readonly config: WebSocketConfig,
  ) {}

  /**
   * Outbound delivery to a declared connection. Mints the platform message id
   * the client must echo back as `replyToId` — returning it lets the send
   * kernel re-key the request's correlation to it.
   */
  push(
    externalId: string,
    body: string,
    idempotencyKey: string,
  ): {
    value: "accepted";
    externalMessageId: string;
  } {
    const connection = this.connections.get(externalId);
    if (connection === undefined) {
      throw new DeliveryNotSent({
        operation: "websocket.push",
        cause: `no live websocket connection for actor ${externalId}`,
      });
    }
    const messageId = idempotencyKey;
    connection.send(JSON.stringify({ type: "message", messageId, text: body }));
    return { value: "accepted", externalMessageId: messageId };
  }

  get ws() {
    const self = this;
    return {
      open(ws: WsConnection) {
        self.connections.set(ws.data.externalId, ws);
        self.publish(Operational.Events.Info, {
          traceId: newTraceId(self.config.id),
          time: self.config.now(),
          component: "server",
          msg: "websocket connection opened",
          context: { surfaceKey: ws.data.surfaceKey },
        });
      },
      close(ws: WsConnection) {
        const externalId = ws.data.externalId;
        if (self.connections.get(externalId) === ws) {
          self.connections.delete(externalId);
        }
        self.publish(Operational.Events.Info, {
          traceId: newTraceId(self.config.id),
          time: self.config.now(),
          component: "server",
          msg: "websocket connection closed",
          context: { surfaceKey: ws.data.surfaceKey },
        });
      },
    };
  }

  handleUpgrade(
    req: Request,
    server: { upgrade(req: Request, options: WebSocketUpgradeOptions): boolean },
  ): Response | undefined {
    const auth = authenticateWebSocketUpgrade({
      request: req,
      publish: this.publish,
      now: this.config.now,
      id: this.config.id,
      ...(this.config.token !== undefined ? { token: this.config.token } : {}),
      ...(this.config.onAuthDecision !== undefined
        ? { onDecision: this.config.onAuthDecision }
        : {}),
    });
    if (auth.response) return auth.response;
    const hasConfiguredToken = this.config.token !== undefined && this.config.token.length > 0;
    const authenticated = hasConfiguredToken && auth.verdict.verdict === "allow";

    // An actor declaration binds this connection to a registered identity
    // (delegated instructions are pushed to it, its replies settle requests), so
    // it requires the shared token — unlike plain owner chat, which loopback
    // trust covers. On a tokenless bind the declaration is simply not taken.
    const declaredId = authenticated
      ? new URL(req.url).searchParams.get("actor")?.trim()
      : undefined;
    const externalId = declaredId || `connection:${this.config.id()}`;
    // Bun 1.3.6 writes an explicit response protocol twice. Narrow the offer
    // AFTER authentication so Bun negotiates only the selected, non-secret protocol.
    if (auth.protocol !== undefined) req.headers.set("sec-websocket-protocol", auth.protocol);
    const ok = server.upgrade(req, {
      // `ws::dm:<uuid>` — empty namespace, so no workspace is derived and
      // actor endpoints registered as plain channel "ws" resolve.
      data: {
        surfaceKey: Channel.SurfaceKey.fromChannel({
          surface: "ws",
          namespace: "",
          kind: "dm",
          id: this.config.id(),
        }),
        authenticated,
        externalId,
      } satisfies WsConnectionData,
    });
    if (ok) return undefined;
    return new Response("WebSocket upgrade failed", { status: 400 });
  }

  handleFrame(
    connection: WsConnectionData,
    data: string | Buffer,
  ): Effect.Effect<WebSocketFrameOutcome, ChannelError> {
    return Effect.gen({ self: this }, function* () {
      yield* Effect.try({
        try: () => this.publish(Operational.Events.Debug, {
          traceId: newTraceId(this.config.id),
          time: this.config.now(),
          component: "server",
          msg: "websocket message received",
          context: { surfaceKey: connection.surfaceKey },
        }),
        catch: decodeChannelFailure("websocket.observe"),
      });
      const raw = typeof data === "string" ? data : new TextDecoder().decode(data);
      const parsed = yield* decodeFrame(raw);
      // The app owns the read; the perimeter only decodes and transports it.
      if ("type" in parsed) return parsed;
      const sender = {
        kind: "external",
        surface: "ws",
        externalId: connection.externalId,
      } as const;
      if (parsed.kind === "request_answer") {
        if (this.config.onRequestAnswer === undefined) {
          return yield* new InvalidInbound({
            operation: "websocket.frame",
            reason: "request_answer_unavailable",
          });
        }
        const result = yield* this.config.onRequestAnswer(sender, parsed);
        return { type: "receipt", inputId: parsed.inputId, result };
      }
      // A frame without a platform event key is refused: the perimeter never
      // fabricates a deduplication key for keyless input (#1245).
      if (parsed.eventId === undefined) {
        return { admitted: false, reason: "missing_key" } satisfies WebSocketKeyRefusal;
      }
      const result = yield* this.handler({
        sender,
        facts: {
          eventId: parsed.eventId,
          surface: "ws",
          channelId: connection.surfaceKey,
          addressees: [],
          dm: true,
          ...(parsed.replyToId !== undefined ? { reply: { chain: [parsed.replyToId] } } : {}),
          payload: { websocket: { authenticated: connection.authenticated } },
          render: parsed.text,
        },
      });
      if (result === undefined) return { type: "receipt", status: "accepted" };
      // Frozen frame: the accepted receipt keeps exactly its base two-key
      // shape. The durable binding rides the additive session_bound frame:
      // the receipt goes out here, first, on the inbound socket; the caller
      // then sends the returned session_bound frame on that same socket.
      this.connections
        .get(connection.externalId)
        ?.send(JSON.stringify({ type: "receipt", status: "accepted" }));
      return { type: "session_bound", result };
    });
  }
}

function decodeFrame(raw: string): Effect.Effect<
  z.infer<typeof WebSocketFrame> | Ingress.AutomationRequest | Ingress.AutomationRefused, InvalidInbound
> {
  return Effect.gen(function* () {
    const document = yield* Effect.try({
      try: () => z.record(z.string(), z.json()).safeParse(JSON.parse(raw)),
      catch: decodeChannelFailure("websocket.decode"),
    }).pipe(Effect.mapError((failure) => new InvalidInbound({
      operation: "websocket.frame", reason: "invalid_json", cause: failure.cause,
    })));
    if (!document.success) {
      return yield* new InvalidInbound({ operation: "websocket.frame", reason: "invalid_frame" });
    }
    if (Ingress.AutomationRequest.options.some((schema) => schema.shape.type.value === document.data.type)) {
      const request = Ingress.AutomationRequest.safeParse(document.data);
      if (request.success) return request.data;
      const refused = Ingress.AutomationRefused.safeParse({
        type: `${document.data.type}_refused`, requestId: document.data.requestId,
        reason: "invalid_record", detail: "Invalid automation request",
        issues: request.error.issues.map((issue) => ({
          path: issue.path.map(String), message: issue.message, code: issue.code,
        })),
      });
      if (refused.success) return refused.data;
      return yield* new InvalidInbound({ operation: "websocket.frame", reason: "invalid_frame" });
    }
    const frame = WebSocketFrame.safeParse(document.data);
    if (!frame.success) {
      return yield* new InvalidInbound({
        operation: "websocket.frame",
        reason: document.data.type === "request_answer" ? "invalid_request_answer" : "text_required",
      });
    }
    return frame.data;
  });
}
