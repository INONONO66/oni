import { Operational, parseJson } from "@openomni/protocol";
import type { reconnectSchedule } from "../../support/schedule";
import { SocketReconnectShell } from "../../support/socket-shell";
import { newTraceId } from "../../support/trace";
import type { EffectRunner, PublishPort } from "../../types";
import { type SocketEnvelope, SocketEnvelopeSchema } from "./types";

const SLACK_SHELL_MESSAGES = {
  urlFetchFailed: "slack socket url fetch failed, retrying",
  closed: "slack socket closed, reconnecting",
  reconnectFailed: "slack reconnect failed",
  socketError: "slack websocket error",
} as const;

interface SocketCallbacks {
  /** `traceId` is minted per envelope — the first frame of an inbound Slack event (D11 origin). */
  onEvent: (envelope: SocketEnvelope, traceId: string) => void;
}

/**
 * Slack Socket Mode connection. Far simpler than the discord gateway by
 * protocol design: no client heartbeat (Slack pings at the WebSocket layer
 * and the runtime pongs automatically), no resume — every (re)connect fetches
 * a fresh one-shot wss URL via `apps.connections.open`. The two protocol
 * duties are acking every `events_api` or `interactive` envelope immediately (Slack redelivers
 * unacked envelopes) and reconnecting on `disconnect` frames, which Slack
 * sends routinely to refresh connections.
 */
export class SlackSocket {
  private readonly shell: SocketReconnectShell;

  constructor(
    private readonly fetchSocketUrl: (traceId: string) => Promise<string>,
    private readonly callbacks: SocketCallbacks,
    private readonly publish: PublishPort,
    private readonly options: {
      readonly now: () => number;
      readonly id: () => string;
      readonly random: () => number;
      readonly run: EffectRunner;
    },
    schedule?: typeof reconnectSchedule,
  ) {
    this.shell = new SocketReconnectShell(
      publish,
      SLACK_SHELL_MESSAGES,
      (url) => this.openSocket(url),
      options,
      schedule,
    );
  }

  async start(): Promise<void> {
    this.shell.begin();
    await this.shell.connect(() => this.fetchSocketUrl(newTraceId(this.options.id)));
  }

  stop(): void {
    this.shell.stop();
  }

  /**
   * Reconnect with a fresh URL. The fetch rejects during exactly the
   * transient outages that cluster reconnects (#540) — its rejection is one
   * failed attempt of the shell's bounded streak, retried on the schedule.
   */
  private async reconnect(traceId: string): Promise<void> {
    const url = await this.fetchSocketUrl(traceId);
    await this.openSocket(url);
  }

  private openSocket(url: string): Promise<void> {
    return this.shell.openWebSocket(url, (ws, settle) => {
      ws.addEventListener("message", (event) => {
        if (!settle.current()) return;
        const envelope = this.parseEnvelope(String(event.data));
        if (envelope === undefined) return;
        if (envelope.type === "hello") {
          settle.resolveOnce();
          return;
        }
        this.handleEnvelope(envelope, ws);
      });

      ws.addEventListener("close", async (event) => {
        if (!settle.current()) return;
        if (!settle.settled()) {
          // A close before hello fails THIS start() — the caller owns retry
          // policy at boot; a rejected start must not leave a zombie
          // reconnect loop behind.
          settle.rejectOnce(new Error(`slack socket closed before hello: ${event.code}`));
          this.shell.end();
          return;
        }
        if (!this.shell.running) return;
        await this.shell.scheduleReconnect(event.code, (traceId) => this.reconnect(traceId));
      });
    });
  }

  private parseEnvelope(data: string): SocketEnvelope | undefined {
    // One malformed frame must not become an uncaught listener throw.
    const envelope = parseJson(SocketEnvelopeSchema, data);
    if (envelope === undefined) {
      this.shell.warnDrop("slack socket frame was not a valid envelope; dropped");
    }
    return envelope;
  }

  private handleEnvelope(envelope: SocketEnvelope, ws: WebSocket): void {
    // Ack FIRST: Slack redelivers unacked envelopes, and a handler throw
    // must not turn one poisoned event into an infinite redelivery loop —
    // inbound dedupe in the surface covers the at-least-once remainder.
    if (envelope.envelope_id !== undefined && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
    }
    if (envelope.type === "disconnect") {
      // Routine connection refresh: close non-1000 so the close handler reconnects.
      this.publish(Operational.Events.Info, {
        traceId: newTraceId(this.options.id),
        time: this.options.now(),
        component: "server",
        msg: "slack server requested reconnect",
        context: { reason: envelope.reason },
      });
      ws.close(4000);
      return;
    }
    if (envelope.type !== "events_api" && envelope.type !== "interactive") return;
    // Origin: the first frame of an inbound Slack event (D11).
    const traceId = newTraceId(this.options.id);
    try {
      this.callbacks.onEvent(envelope, traceId);
    } catch (err) {
      this.publish(Operational.Events.Error, {
        traceId,
        time: this.options.now(),
        component: "server",
        msg: "slack event dispatch error",
        context: { err: err instanceof Error ? err.message : String(err) },
      });
    }
  }
}
