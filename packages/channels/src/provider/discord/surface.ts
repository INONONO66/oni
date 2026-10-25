import { newTraceId } from "../../support/trace";
import { type Channel, type Gateway, Operational, type Outbound } from "@oni/protocol";
import type { z } from "zod";
import { handoffInbound } from "../../support/inbound-handoff";
import { requireHandler } from "../../support/handler-frame";
import type { DeliveryReceipt } from "../../support/deliver";
import { type ListenerCustody, listenerCustody } from "../../support/sdk-listener";
import { type DiscordDelivery, deliverThroughDiscord, discordDmChannel } from "./delivery";
import { DiscordHandlerMissingError, VoiceJoinRefused } from "../../errors";
import { DiscordNormalizer, discordCall } from "./normalizer";
import {
  DISCORD_INTENTS,
  type DiscordBotApi,
  type DiscordBotEventMap,
  type DiscordSdk,
  classifyDiscordFailure,
  discordSdk,
  DiscordVoiceError,
} from "./sdk";
import type { DiscordBotEvents, DiscordVoiceHandle, DiscordVoiceStateUpdate } from "./sdk";
import type { PcmVoiceHandle, ProviderVoiceRoute, VoiceEvent } from "../voice";
import {
  type DiscordMessage,
  type DiscordReaction,
  type DiscordInteraction,
  DiscordInteractionSchema,
  DiscordMessageSchema,
  DiscordReactionSchema,
} from "./types";
import type { PublishPort } from "../../types";
import type { ProviderOptions } from "../contract";
import { BotState, botClient } from "../bot-state";

function voiceRefused(reason: VoiceJoinRefused["reason"], detail: string): VoiceJoinRefused {
  return new VoiceJoinRefused({ reason, surface: "discord", detail });
}

/**
 * Discord over the agent-messenger bot SDK's gateway listener (#1569): the
 * SDK owns identify/resume, heartbeats and reconnects; this surface owns the
 * bot identity (from READY), facts-only normalization, inbound dedupe,
 * interaction acks, delivery custody and rendering. Every request rides the
 * SDK client with retries disabled.
 */
export class DiscordAdapter extends BotState implements Channel.Surface {
  readonly id = "discord:bot";
  private readonly bot: DiscordBotApi;
  private readonly ready: Promise<void>;
  private custody: ListenerCustody | null = null;
  private normalizer: DiscordNormalizer | null = null;
  private listener: DiscordBotEvents | null = null;
  private sessionId: string | null = null;
  private readonly live = new Map<string, PcmVoiceHandle>();
  private readonly joining = new Set<string>();
  private readonly lastChannel = new Map<string, Map<string, {
    channel: string | null; sequence: number; sessionId: string;
  }>>();

  constructor(
    token: string,
    readonly config: Channel.Config,
    private readonly publish: PublishPort,
    private readonly options: ProviderOptions,
    private readonly sdk: DiscordSdk = discordSdk(),
  ) {
    super(options.now);
    const client = botClient(sdk, token);
    this.bot = client.bot;
    this.ready = client.ready;
  }

  /** Settles on READY; an error or close before it fails this start and leaves no listener. */
  async start(_traceId: string): Promise<void> {
    if (!this.handler) {
      throw new DiscordHandlerMissingError({
        message: "[discord] No message handler registered. Call onMessage() before start().",
      });
    }
    await this.ready;
    const listener = this.sdk.listener(this.bot, { intents: DISCORD_INTENTS });
    const custody = listenerCustody<DiscordBotEventMap>(listener, {
      label: "discord gateway",
      publish: this.publish,
      now: this.options.now,
      id: this.options.id,
      // The SDK's own start() stays pending across a recoverable pre-READY close
      // and rejects on its connect timeout, so a close before READY is its call.
      failOnCloseBeforeConnected: false,
      // The SDK stops itself on 4004/4010-4014 and reports only this error.
      terminal: (error) => /non-recoverable code/.test(error.message),
      // READY (initial connect AND every re-identify) binds the bot identity
      // the normalizer filters and keys on — deliberately its own trace.
      onConnected: ({ user, sessionId }) => {
        this.normalizer = new DiscordNormalizer(user.id);
        this.sessionId = sessionId;
        this.publish(Operational.Events.Info, {
          traceId: newTraceId(this.options.id),
          time: this.options.now(),
          component: "server",
          msg: "discord bot started",
          context: { username: user.username, botId: user.id },
        });
      },
    });
    listener.on("voice_state_update", (state, sequence) => {
      void this.handleVoiceState(state, sequence);
    });
    listener.on("message_create", (event) => {
      this.dispatch(
        "MESSAGE_CREATE",
        DiscordMessageSchema.safeParse(event),
        newTraceId(this.options.id),
      );
    });
    listener.on("message_reaction_add", (event) => {
      this.dispatch(
        "MESSAGE_REACTION_ADD",
        DiscordReactionSchema.safeParse(event),
        newTraceId(this.options.id),
      );
    });
    listener.on("interaction_create", (event) => {
      // Only component taps carry a custom_id; slash commands and the rest are not consumed.
      if (event.data === undefined || typeof event.data.custom_id !== "string") return;
      const traceId = newTraceId(this.options.id);
      const interaction = DiscordInteractionSchema.safeParse(event);
      if (!interaction.success) {
        this.warn(traceId, "discord INTERACTION_CREATE payload malformed; dropped");
        return;
      }
      // Defer the interaction before any potentially slow inbound handoff;
      // a refused ack drops the tap rather than answering a dead token later.
      void this.bot
        .respondToInteraction(interaction.data.id, interaction.data.token, 6)
        .then(() => this.handleMessageCreate(interaction.data, traceId))
        .catch((error) => {
          this.warn(traceId, "discord interaction acknowledgment failed; dropped", {
            err: String(error),
          });
        });
    });
    this.custody = custody;
    this.listener = listener;
    try {
      await custody.start();
    } catch (error) {
      this.custody = null;
      this.listener = null;
      throw error;
    }
  }

  async stop(traceId: string): Promise<void> {
    this.sessionId = null;
    this.lastChannel.clear();
    try {
      const leaves = await Promise.allSettled([...this.live.values()].map((handle) => handle.leave()));
      for (const result of leaves) {
        if (result.status === "rejected") throw result.reason;
      }
    } finally {
      this.live.clear();
      this.custody?.stop();
      this.custody = null;
      this.listener = null;
      this.publish(Operational.Events.Info, {
        traceId,
        time: this.options.now(),
        component: "server",
        msg: "discord bot stopped",
      });
    }
  }

  private async handleVoiceState(state: DiscordVoiceStateUpdate, sequence: number | null): Promise<void> {
    const listener = this.listener;
    const sessionId = this.sessionId;
    const selfId = listener?.botUserId();
    if (!this.custody || !sessionId || !selfId || sequence === null || !state.guild_id ||
        state.user_id === selfId) return;
    const guild = this.lastChannel.get(state.guild_id) ??
      new Map<string, { channel: string | null; sequence: number; sessionId: string }>();
    const previous = guild.get(state.user_id);
    if (previous?.sessionId === sessionId && previous.sequence >= sequence) return;
    if (state.channel_id === null) {
      guild.set(state.user_id, { channel: null, sequence, sessionId });
      return;
    }
    if (previous?.channel === state.channel_id) {
      guild.set(state.user_id, { channel: state.channel_id, sequence, sessionId });
      return;
    }
    try {
      if ((await this.bot.getUser(state.user_id)).bot === true) return;
    } catch (error) {
      this.warn(newTraceId(this.options.id), "discord voice author lookup failed; dropped",
        { err: String(error) });
      return;
    }
    const latest = guild.get(state.user_id);
    if (this.listener !== listener || this.sessionId !== sessionId || listener?.botUserId() !== selfId ||
        (latest?.sessionId === sessionId && latest.sequence >= sequence)) return;
    if (!this.lastChannel.has(state.guild_id)) {
      if (this.lastChannel.size >= 64) this.lastChannel.delete(this.lastChannel.keys().next().value ?? "");
      this.lastChannel.set(state.guild_id, guild);
    }
    if (guild.size >= 256 && !guild.has(state.user_id))
      guild.delete(guild.keys().next().value ?? "");
    guild.set(state.user_id, { channel: state.channel_id, sequence, sessionId });
    const inbound = discordCall(state, sequence, sessionId, selfId);
    if (inbound === null) return;
    const traceId = newTraceId(this.options.id);
    void handoffInbound({
      dedupe: this.dedupe,
      key: inbound.facts.eventId,
      traceId, now: this.options.now, publish: this.publish,
      errorMessage: "discord call handling failed", rethrowFailure: false,
      handle: () => this.handleIncoming(inbound, inbound.facts.channelId, traceId),
    });
  }

  async joinVoice(input: Parameters<ProviderVoiceRoute>[0]): Promise<PcmVoiceHandle> {
    if (!input.speakerExternalId) throw voiceRefused("address_incomplete", "speakerExternalId is required");
    const listener = this.listener;
    if (!listener || !this.sessionId || !listener.botUserId())
      throw voiceRefused("not_started", "Discord gateway is not READY");
    const guild = input.workspaceId ?? await this.guildOf(input.channelId);
    if (this.live.has(guild) || this.joining.has(guild))
      throw voiceRefused("busy", `voice already active in guild ${guild}`);
    this.joining.add(guild);
    try {
      const raw = await this.sdk.joinVoice(guild, input.channelId, {
        listener, speakerId: input.speakerExternalId,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      if (this.listener !== listener || this.sessionId === null || !listener.botUserId()) {
        await raw.leave();
        throw voiceRefused("not_started", "Discord gateway stopped during voice join");
      }
      const handle = this.adaptVoice(raw, guild);
      this.live.set(guild, handle);
      return handle;
    } catch (error) {
      if (!(error instanceof DiscordVoiceError)) throw error;
      let reason: VoiceJoinRefused["reason"];
      switch (error.code) {
        case "voice_aborted": reason = "aborted"; break;
        case "voice_join_failed": reason = "join_failed"; break;
        case "voice_not_ready": reason = "not_started"; break;
        case "voice_busy": reason = "busy"; break;
      }
      throw voiceRefused(reason, error.message);
    } finally {
      this.joining.delete(guild);
    }
  }

  private async guildOf(channelId: string): Promise<string> {
    try {
      const channel = await this.bot.getChannel(channelId);
      if (channel.type !== 2 || !channel.guild_id)
        throw voiceRefused("address_incomplete", "channel is not a guild voice channel");
      return channel.guild_id;
    } catch (error) {
      if (error instanceof VoiceJoinRefused) throw error;
      throw voiceRefused("address_incomplete", `channel lookup failed: ${String(error)}`);
    }
  }

  private adaptVoice(raw: DiscordVoiceHandle, guild: string): PcmVoiceHandle {
    const live = this.live;
    const queue: VoiceEvent[] = [];
    let wake = Promise.withResolvers<void>();
    let done = false;
    const push = (event: VoiceEvent) => {
      queue.push(event);
      wake.resolve();
    };
    void (async () => {
      try {
        for await (const event of raw.events) {
          if (event.type === "disconnected" || event.type === "error") live.delete(guild);
          push(event.type === "speaker_left"
            ? { type: "speaker_left", externalId: event.userId } : event);
        }
      } catch (error) {
        push({ type: "error", reason: String(error) });
      } finally {
        done = true;
        live.delete(guild);
        wake.resolve();
      }
    })();
    return {
      pcmIn: raw.pcmIn,
      pcmOut: raw.pcmOut,
      events: (async function* (): AsyncIterable<VoiceEvent> {
        while (!done || queue.length > 0) {
          const event = queue.shift();
          if (event !== undefined) yield event;
          else {
            await wake.promise;
            wake = Promise.withResolvers<void>();
          }
        }
      })(),
      async leave() {
        try {
          await raw.leave();
        } finally {
          live.delete(guild);
        }
      },
    };
  }

  private dispatch<T extends DiscordMessage | DiscordReaction>(
    event: "MESSAGE_CREATE" | "MESSAGE_REACTION_ADD",
    parsed: z.ZodSafeParseResult<T>,
    traceId: string,
  ): void {
    if (!parsed.success) {
      this.warn(traceId, `discord ${event} payload malformed; dropped`);
      return;
    }
    this.handleMessageCreate(parsed.data, traceId);
  }

  private warn(traceId: string, msg: string, context?: Record<string, string>): void {
    this.publish(Operational.Events.Warn, {
      traceId,
      time: this.options.now(),
      component: "server",
      msg,
      ...(context === undefined ? {} : { context }),
    });
  }

  /** Existing-agent delivery through the shared Discord path (`delivery.ts`). */
  deliver(
    externalId: string,
    payload: Outbound.Payload,
    idempotencyKey: string,
    conversation?: Gateway.Conversation,
  ): Promise<DeliveryReceipt> {
    return deliverThroughDiscord(this.delivery(), externalId, payload, idempotencyKey, conversation);
  }

  /** A DM channel is created once per turn, not once per pulse. */
  async openTyping(
    externalId: string,
    conversation?: Gateway.Conversation,
  ): Promise<Gateway.Conversation> {
    if (conversation !== undefined) return conversation;
    await this.ready;
    return {
      channelId: await discordDmChannel(this.bot, externalId),
    };
  }

  typing(conversation: Gateway.Conversation): Promise<void> {
    return this.bot.triggerTyping(conversation.channelId);
  }

  private delivery(): DiscordDelivery {
    return {
      client: this.bot,
      ready: this.ready,
      classify: classifyDiscordFailure,
      outbound: this.outbound,
      publish: this.publish,
      options: this.options,
    };
  }

  private handleMessageCreate(
    message: DiscordMessage | DiscordReaction | DiscordInteraction,
    traceId: string,
  ): void {
    const normalizer = this.normalizer;
    if (!normalizer) return;
    void handoffInbound({
      dedupe: this.dedupe,
      key:
        "token" in message
          ? message.id
          : "message_id" in message
            ? `${message.message_id}:${message.emoji.name}:${message.user_id}`
            : message.id,
      traceId,
      now: this.options.now,
      publish: this.publish,
      errorMessage: "discord message handling failed",
      rethrowFailure: false,
      handle: async () => {
        const inbound = normalizer.normalize(message);
        if (inbound) await this.handleIncoming(inbound, message.channel_id, traceId);
      },
    });
  }

  private async handleIncoming(
    inbound: Channel.InboundMessage,
    channelId: string,
    traceId: string,
  ): Promise<void> {
    this.publish(Operational.Events.Debug, {
      traceId,
      time: this.options.now(),
      component: "server",
      msg: "discord message received",
      context: { channelId },
    });
    await requireHandler(this.handler, "discord")(inbound);
  }
}
