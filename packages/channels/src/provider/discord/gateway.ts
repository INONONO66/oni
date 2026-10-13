import { newTraceId } from "../../support/trace";
import { Operational, parseJson } from "@openomni/protocol";
import type { reconnectSchedule } from "../../support/schedule";
import { SocketReconnectShell, type SocketSettle } from "../../support/socket-shell";
import type { EffectRunner, PublishPort } from "../../types";
import { GatewayHeartbeat } from "./heartbeat";
import {
  type GatewayFrame,
  GatewayFrameSchema,
  GatewayOp,
  HelloDataSchema,
  Intents,
  ReadyDataSchema,
} from "./types";

const DISCORD_SHELL_MESSAGES = {
  urlFetchFailed: "discord gateway url fetch failed, retrying",
  closed: "discord connection closed, reconnecting",
  reconnectFailed: "discord reconnect failed",
  socketError: "discord websocket error",
} as const;

interface GatewayCallbacks {
  /** `traceId` is minted per dispatch — the first frame of an inbound gateway event (D11 origin). */
  onDispatch: (event: string, data: object, traceId: string) => void;
  onReady: (info: { botId: string; botUsername: string }) => void;
}

/**
 * Accept a READY resume URL only when it points at a Discord gateway origin
 * (`wss://*.discord.gg`) or the same origin the trusted gateway-URL fetch
 * connected to; anything else returns null, which falls back to a freshly
 * fetched gateway URL on the next reconnect.
 */
function validResumeUrl(raw: string, trustedOrigin: string | null): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  const host = parsed.hostname;
  const discordGateway =
    parsed.protocol === "wss:" && (host === "discord.gg" || host.endsWith(".discord.gg"));
  if (!(discordGateway || parsed.origin === trustedOrigin)) return null;
  return `${raw}?v=10&encoding=json`;
}

/** Owns session/resume state and routes protocol frames to the socket and heartbeat owners. */
export class DiscordGateway {
  private readonly heartbeat: GatewayHeartbeat;
  private sequence: number | null = null;
  private sessionId: string | null = null;
  private resumeUrl: string | null = null;
  /** Origin of the last trusted (fetched, not payload-provided) gateway URL. */
  private gatewayOrigin: string | null = null;
  private readonly shell: SocketReconnectShell;

  constructor(
    private readonly token: string,
    private readonly fetchGatewayUrl: () => Promise<string>,
    private readonly callbacks: GatewayCallbacks,
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
      DISCORD_SHELL_MESSAGES,
      (url) => this.openSocket(url),
      options,
      schedule,
    );
    this.heartbeat = new GatewayHeartbeat(
      () => this.sendGateway({ op: GatewayOp.HEARTBEAT, d: this.sequence }),
      () => this.shell.closeSocket(4000),
      options.run,
    );
  }

  async start(): Promise<void> {
    this.heartbeat.stop();
    this.shell.begin();
    await this.shell.connect(this.fetchGatewayUrl);
  }

  stop(): void {
    this.heartbeat.stop();
    this.shell.stop();
  }

  private async reconnect(): Promise<void> {
    // A resumable session skips the URL fetch; either path's rejection is one
    // failed attempt of the shell's bounded reconnect streak.
    const url = this.resumeUrl && this.sessionId ? this.resumeUrl : await this.fetchGatewayUrl();
    await this.openSocket(url);
  }

  private openSocket(url: string): Promise<void> {
    try {
      this.gatewayOrigin = new URL(url).origin;
    } catch {
      this.gatewayOrigin = null;
    }
    return this.shell.openWebSocket(url, (ws, settle) => this.wireSocket(ws, settle));
  }

  private wireSocket(ws: WebSocket, settle: SocketSettle): void {
    ws.addEventListener("message", (event) => {
      if (!settle.current()) return;
      // One malformed frame must not become an uncaught listener throw;
      // drop it — the gateway's own heartbeat/close handling recovers.
      const frame = parseJson(GatewayFrameSchema, String(event.data));
      if (frame === undefined) {
        this.shell.warnDrop("discord gateway frame was not a valid op envelope; dropped");
        return;
      }
      if (this.handlePayload(frame)) settle.resolveOnce();
    });

    ws.addEventListener("close", async (event) => {
      if (!settle.current()) return;
      this.heartbeat.stop();
      settle.rejectOnce(new Error(`WebSocket closed before ready: ${event.code}`));
      if (FATAL_CLOSE_CODES.has(event.code)) {
        this.shell.end();
        this.publish(Operational.Events.Error, {
          traceId: newTraceId(this.options.id),
          time: this.options.now(),
          component: "server",
          msg: "discord gateway fatal close code",
          context: { code: event.code },
        });
        return;
      }
      if (this.shell.running) {
        await this.shell.scheduleReconnect(event.code, () => this.reconnect());
      }
    });
  }

  /** Routes one gateway payload; returns true when the connection is ready. */
  private handlePayload(frame: GatewayFrame): boolean {
    // typeof guard, not `!== null`: a MISSING s would otherwise assign
    // undefined, and `seq: undefined` in RESUME gets dropped by
    // JSON.stringify — the same serialization class as the #520 token bug.
    if (typeof frame.s === "number") this.sequence = frame.s;
    const d = frame.d;
    switch (frame.op) {
      case GatewayOp.HELLO: {
        const hello = HelloDataSchema.safeParse(d);
        // A malformed interval falls to the clamp's floor rather than dropping
        // the frame — HELLO must always answer with IDENTIFY/RESUME.
        this.heartbeat.start(hello.success ? hello.data.heartbeat_interval : Number.NaN);
        if (this.sessionId && this.sequence !== null) {
          this.sendGateway({
            op: GatewayOp.RESUME,
            d: { token: this.token, session_id: this.sessionId, seq: this.sequence },
          });
        } else {
          this.identify();
        }
        return false;
      }
      case GatewayOp.HEARTBEAT:
        // Server-requested heartbeat: the docs require an immediate beat,
        // else the server closes the connection.
        this.sendGateway({ op: GatewayOp.HEARTBEAT, d: this.sequence });
        return false;
      case GatewayOp.HEARTBEAT_ACK:
        this.heartbeat.acknowledge();
        return false;
      // The op notice and the close→reconnect chain it triggers carry two
      // ids on purpose: threading the notice's id through instance state
      // could leak it across UNRELATED close events, which is worse than an
      // orphaned chain head (#653 review).
      case GatewayOp.RECONNECT:
        this.publish(Operational.Events.Info, {
          traceId: newTraceId(this.options.id),
          time: this.options.now(),
          component: "server",
          msg: "discord server requested reconnect",
        });
        this.shell.closeSocket(4000);
        return false;
      case GatewayOp.INVALID_SESSION: {
        const resumable = d === true;
        this.publish(Operational.Events.Warn, {
          traceId: newTraceId(this.options.id),
          time: this.options.now(),
          component: "server",
          msg: "discord invalid session",
          context: { resumable },
        });
        if (!resumable) {
          this.sessionId = null;
          this.sequence = null;
        }
        this.shell.closeSocket(4000);
        return false;
      }
      case GatewayOp.DISPATCH:
        return frame.t != null && typeof d === "object" && d !== null
          ? this.handleDispatch(frame.t, d)
          : false;
      default:
        return false;
    }
  }

  private handleDispatch(event: string, data: object): boolean {
    if (event === "READY") {
      const ready = ReadyDataSchema.safeParse(data);
      if (!ready.success) {
        this.publish(Operational.Events.Warn, {
          traceId: newTraceId(this.options.id),
          time: this.options.now(),
          component: "server",
          msg: "discord READY payload malformed; dropped",
        });
        return false;
      }
      this.sessionId = ready.data.session_id;
      // The resume URL arrives in a server payload; pin it to Discord's
      // gateway origin before it can ever become a socket target, so a
      // spoofed READY cannot redirect the resume connection elsewhere.
      this.resumeUrl = validResumeUrl(ready.data.resume_gateway_url, this.gatewayOrigin);
      this.callbacks.onReady({ botId: ready.data.user.id, botUsername: ready.data.user.username });
      return true;
    }
    if (event === "RESUMED") {
      this.publish(Operational.Events.Info, {
        traceId: newTraceId(this.options.id),
        time: this.options.now(),
        component: "server",
        msg: "discord session resumed",
      });
      return true;
    }
    // Origin: the first frame of an inbound gateway event — this ONE mint is
    // the message's trace, carried through the surface to the run (D11).
    const traceId = newTraceId(this.options.id);
    try {
      this.callbacks.onDispatch(event, data, traceId);
    } catch (err) {
      this.publish(Operational.Events.Error, {
        traceId,
        time: this.options.now(),
        component: "server",
        msg: "discord dispatch error",
        context: {
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        },
      });
    }
    return false;
  }

  private identify(): void {
    this.sendGateway({
      op: GatewayOp.IDENTIFY,
      d: {
        token: this.token,
        intents:
          Intents.GUILDS |
          Intents.GUILD_MESSAGES |
          Intents.GUILD_MESSAGE_REACTIONS |
          Intents.DIRECT_MESSAGES |
          Intents.DIRECT_MESSAGE_REACTIONS |
          Intents.MESSAGE_CONTENT,
        properties: { os: "linux", browser: "openomni", device: "openomni" },
      },
    });
  }

  private sendGateway(payload: object): void {
    this.shell.sendJson(payload);
  }
}

const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
