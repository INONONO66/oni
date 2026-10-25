import { type Channel, type Gateway, Operational, type Outbound, type PlainValue } from "@oni/protocol";
import { Effect } from "effect";
import { ChannelsFailure, DeliveryNotSent, SlackEndpointKeyError, VoiceJoinRefused } from "../../errors";
import { Dedupe } from "../../support/dedupe";
import { type DeliveryReceipt, DeliveryReconciliation, deliverKeyed } from "../../support/deliver";
import { requireHandler } from "../../support/handler-frame";
import { handoffInbound } from "../../support/inbound-handoff";
import { type ListenerCustody, listenerCustody } from "../../support/sdk-listener";
import { newTraceId } from "../../support/trace";
import { translate } from "../../support/translate";
import type { PublishPort } from "../../types";
import type { AccountIdentity, OwnerPosture, ProviderOptions } from "../contract";
import type { PcmVoiceHandle, ProviderVoiceRoute, VoiceEvent } from "../voice";
import { slackEmojiName } from "./emoji";
import { SLACK_RENDER } from "./format";
import { SlackNormalizer, slackCall } from "./normalizer";
import {
  SlackHuddleError,
  type SlackHuddleHandle,
  type SlackOwnerApi,
  type SlackOwnerEventMap,
  type SlackOwnerEvents,
  type SlackOwnerSdk,
  slackOwnerSdk,
} from "./owner-sdk";
import { classifySlackFailure, isSettledState, isSlackTerminal, singleAttempt } from "./sdk";
import { SlackMessageEventSchema } from "./types";

type HuddleChanged = SlackOwnerEventMap["user_huddle_changed"][0];
type RoomJoined = SlackOwnerEventMap["sh_room_join"][0];

const JOIN_REASONS: Record<SlackHuddleError["code"], VoiceJoinRefused["reason"]> = {
  voice_not_ready: "not_started",
  voice_busy: "busy",
  voice_aborted: "aborted",
  voice_join_failed: "join_failed",
};

function voiceRefused(reason: VoiceJoinRefused["reason"], detail: string): VoiceJoinRefused {
  return new VoiceJoinRefused({ reason, surface: "slack:owner", detail });
}

function joinRefusal(error: Error): VoiceJoinRefused {
  return error instanceof SlackHuddleError
    ? voiceRefused(JOIN_REASONS[error.code], safeVoiceReason(error.detail, "voice_join_failed"))
    : voiceRefused("join_failed", "voice_join_failed");
}

function safeVoiceReason(reason: string, fallback: string): string {
  return /^[a-z][a-z0-9_]{0,63}$/.test(reason) ? reason : fallback;
}

/** Slack decimal timestamps are compared as decimal strings, without losing precision to Number. */
function newer(left: string, right: string): boolean {
  const [li = "", lf = ""] = left.split(".");
  const [ri = "", rf = ""] = right.split(".");
  if (li.length !== ri.length) return li.length > ri.length;
  if (li !== ri) return li > ri;
  return lf.padEnd(Math.max(lf.length, rf.length), "0") >
    rf.padEnd(Math.max(lf.length, rf.length), "0");
}

function conversation(channelId: string): boolean {
  return /^[CDG][A-Z0-9]+$/.test(channelId);
}

/**
 * Slack as the Owner's own account (#1569 lanes 5 and 6): the `slack:owner`
 * instance, logged in with the vault-opened `{token xoxc, cookie d}` the QR
 * login produced. Delivery posts where an authenticated Owner-origin turn
 * said `as: owner` and the instance's declaration grants outbound. Intake is
 * the account's RTM listener under the declared posture: by default a DM to
 * the Owner or a mention of the Owner reaches the Resident, received by the
 * Owner; the account's own messages never do. Reactions are not intake: the
 * router routes a reaction only as the answer to a request, and nothing
 * the Owner's account receives is one. Custody is the bot surface's: one
 * physical attempt per idempotency key on a pinned inner client,
 * `sent | not_sent | unknown` from the SDK's error shapes.
 */
export class SlackOwnerAdapter implements Channel.Surface {
  readonly id = "slack:owner";

  private readonly client: SlackOwnerApi;
  private readonly sdk: SlackOwnerSdk;
  private readonly outbound = new DeliveryReconciliation();
  private readonly dedupe: Dedupe;
  private handler: Channel.MessageHandler | null = null;
  private custody: ListenerCustody | null = null;
  private normalizer: SlackNormalizer | null = null;

  constructor(
    private readonly credentials: { readonly token: string; readonly cookie: string },
    readonly posture: OwnerPosture,
    private readonly publish: PublishPort,
    private readonly options: ProviderOptions,
    sdk: SlackOwnerSdk = slackOwnerSdk(),
  ) {
    this.sdk = sdk;
    this.client = sdk.client();
    this.dedupe = new Dedupe(options.now);
  }

  /** The surface contract's config: an Owner instance carries its posture instead. */
  readonly config: Channel.Config = {};

  onMessage(handler: Channel.MessageHandler): void {
    this.handler = handler;
  }

  /** The workspace the authenticated session belongs to; every endpoint this instance delivers to must name it. */
  private team: string | null = null;
  private userId: string | null = null;
  private generation = 0;
  private readyGeneration: number | null = null;
  private joining: { readonly controller: AbortController; readonly settled: Promise<void> } | null = null;
  private live: PcmVoiceHandle | null = null;
  private readonly rooms = new Map<string, string | null>();
  private readonly pendingRooms = new Map<string, HuddleChanged>();
  private pendingTimer: (() => void) | null = null;
  private currentRoom: string | null = null;
  private lastHuddleTs: string | null = null;

  /**
   * The account identity is verified before the instance counts as mounted;
   * a refused login fails this start. Under an intake posture the RTM
   * listener then opens, settling on the SDK's first `connected` (hello) and
   * failing this start on an error before it.
   */
  async start(traceId: string): Promise<void> {
    const generation = ++this.generation;
    this.readyGeneration = null;
    const requireCurrent = () => {
      if (this.generation !== generation)
        throw new ChannelsFailure({ operation: "slack owner.start", cause: "start superseded" });
    };
    let started = false;
    try {
      await this.client.login(this.credentials);
      requireCurrent();
      singleAttempt(this.client);
      const identity = await this.client.testAuth();
      requireCurrent();
      this.team = identity.team_id;
      this.userId = identity.user_id;
      this.normalizer = new SlackNormalizer({ botUserId: identity.user_id, team: identity.team_id });
      const listens = this.posture.intake !== "none" && this.handler !== null;
      if (listens) await this.listen();
      requireCurrent();
      this.readyGeneration = generation;
      this.publish(Operational.Events.Info, {
        traceId,
        time: this.options.now(),
        component: "server",
        msg: "slack owner instance started",
        context: {
          userId: identity.user_id,
          team: identity.team_id,
          listener: listens ? this.posture.intake : "none",
        },
      });
      started = true;
    } finally {
      if (!started && this.generation === generation) {
        this.readyGeneration = null;
        this.team = null;
        this.userId = null;
        this.normalizer = null;
        this.custody?.stop();
        this.custody = null;
      }
    }
  }

  /** The account's Slack identity (#1600), the shape a Slack endpoint takes: `TEAM:USER` in workspace `TEAM`. */
  account(): AccountIdentity | undefined {
    if (this.team === null || this.userId === null) return undefined;
    return { externalId: `${this.team}:${this.userId}`, workspace: this.team };
  }

  private async listen(): Promise<void> {
    const listener = this.sdk.listener(this.client);
    const custody = listenerCustody<SlackOwnerEventMap>(listener, {
      label: "slack rtm",
      publish: this.publish,
      now: this.options.now,
      id: this.options.id,
      // The SDK's start() resolves before hello and reopens on its own; a
      // close before the first hello is this start's failure to report.
      failOnCloseBeforeConnected: true,
      terminal: isSlackTerminal,
    });
    this.wire(listener);
    this.custody = custody;
    try {
      await custody.start();
    } catch (error) {
      // Custody stopped the SDK's reconnect timer; a failed start owns nothing.
      this.custody = null;
      throw error;
    }
  }

  async stop(traceId: string): Promise<void> {
    this.generation += 1;
    this.readyGeneration = null;
    this.team = null;
    this.userId = null;
    this.normalizer = null;
    const pending = this.joining;
    pending?.controller.abort();
    try {
      if (pending !== null) await pending.settled;
      if (this.live !== null) await this.live.leave();
    } finally {
      this.live = null;
      this.rooms.clear();
      this.clearPending();
      this.currentRoom = null;
      this.lastHuddleTs = null;
      this.custody?.stop();
      this.custody = null;
    }
    this.publish(Operational.Events.Info, {
      traceId, time: this.options.now(), component: "server", msg: "slack owner instance stopped",
    });
  }

  /** Binds the consumed RTM frames; hello, errors and closes are the custody wrapper's. */
  private wire(listener: SlackOwnerEvents): void {
    listener.on("disconnected", () => {
      this.rooms.clear();
      this.clearPending();
    });
    listener.on("sh_room_join", (event) => this.roomJoined(event));
    listener.on("user_huddle_changed", (event) => this.huddleChanged(event));
    listener.on("message", (frame) => {
      // RTM frames carry no `channel_type`; a direct channel is a `D…` id.
      const event = SlackMessageEventSchema.safeParse({
        ...frame,
        ...(frame.channel.startsWith("D") ? { channel_type: "im" } : {}),
      });
      if (event.success) this.handleFrame(event.data, `${frame.channel}:${frame.ts}`);
    });
  }

  private clearPending(): void {
    this.pendingTimer?.();
    this.pendingTimer = null;
    this.pendingRooms.clear();
  }

  private roomJoined(event: RoomJoined): void {
    if (event.user !== this.userId || event.room.has_ended || !conversation(event.huddle.channel_id)) return;
    if (this.rooms.get(event.room.id) === null) return;
    const previous = this.rooms.get(event.room.id);
    if (previous !== undefined && previous !== event.huddle.channel_id) {
      if (this.pendingRooms.has(event.room.id)) this.clearPending();
      this.rooms.set(event.room.id, null);
      this.publish(Operational.Events.Warn, {
        traceId: newTraceId(this.options.id), time: this.options.now(),
        component: "server", msg: "huddle_channel_unresolved",
      });
      return;
    }
    if (this.rooms.size >= 32 && previous === undefined)
      this.rooms.delete(this.rooms.keys().next().value ?? "");
    this.rooms.set(event.room.id, event.huddle.channel_id);
    const pending = this.pendingRooms.get(event.room.id);
    if (pending !== undefined) {
      this.clearPending();
      this.emitHuddle(pending, event.huddle.channel_id);
    }
  }

  private huddleChanged(event: HuddleChanged): void {
    if (event.user.id !== this.userId || event.user.team_id !== this.team) return;
    const profile = event.user.profile;
    if (profile.huddle_state !== "in_a_huddle") {
      if (profile.huddle_state !== "not_in_a_huddle") return;
      if (profile.huddle_state_call_id == null &&
          (this.lastHuddleTs === null || newer(event.event_ts, this.lastHuddleTs))) {
        this.lastHuddleTs = event.event_ts;
        this.currentRoom = null;
        this.clearPending();
      }
      return;
    }
    const room = profile.huddle_state_call_id;
    if (!room || (this.lastHuddleTs !== null && !newer(event.event_ts, this.lastHuddleTs))) return;
    this.lastHuddleTs = event.event_ts;
    if (room === this.currentRoom) return;
    this.currentRoom = room;
    this.clearPending();
    if (this.rooms.get(room) === null) return;
    // The browser is this same account: its RTM transition is tracked but is
    // never replayed as a new invitation after this call leaves.
    if (this.joining !== null || this.live !== null) return;
    const channel = this.rooms.get(room);
    if (channel !== undefined && channel !== null) {
      this.emitHuddle(event, channel);
    } else {
      this.pendingRooms.set(room, event);
      const cancelled = Promise.withResolvers<void>();
      const cancel = () => cancelled.resolve();
      this.pendingTimer = cancel;
      void this.options.run(Effect.raceFirst(
        Effect.as(Effect.sleep(10_000), true),
        Effect.as(Effect.promise(() => cancelled.promise), false),
      )).then((expired) => {
        if (!expired || this.pendingTimer !== cancel) return;
        this.clearPending();
        this.publish(Operational.Events.Warn, {
          traceId: newTraceId(this.options.id), time: this.options.now(),
          component: "server", msg: "huddle_channel_unresolved",
        });
      });
    }
  }

  private emitHuddle(event: HuddleChanged, channel: string): void {
    if (event.user.profile.huddle_state_call_id !== this.currentRoom ||
        this.joining !== null || this.live !== null) return;
    const team = this.team;
    const ownerUserId = this.userId;
    if (team === null || ownerUserId === null) return;
    const inbound = slackCall(event, {
      team, ownerUserId, channelId: channel, dm: channel.startsWith("D"),
    });
    if (inbound === null || this.posture.intake === "none") return;
    void handoffInbound({
      dedupe: this.dedupe, key: inbound.facts.eventId,
      traceId: newTraceId(this.options.id), now: this.options.now,
      publish: this.publish, errorMessage: "slack owner huddle handling failed",
      rethrowFailure: false,
      handle: () => requireHandler(this.handler, "slack:owner")(inbound),
    });
  }

  async joinVoice(input: Parameters<ProviderVoiceRoute>[0]): Promise<PcmVoiceHandle> {
    if (input.surface !== this.id || !conversation(input.channelId) ||
        !input.speakerExternalId || input.workspaceId !== undefined && input.workspaceId !== this.team)
      throw voiceRefused("address_incomplete", "voice_address_invalid");
    const team = this.team;
    const userId = this.userId;
    if (team === null || userId === null || this.readyGeneration !== this.generation)
      throw voiceRefused("not_started", "owner_not_started");
    if (input.speakerExternalId !== `${team}:${userId}`)
      throw voiceRefused("address_incomplete", "speaker_mismatch");
    if (input.signal?.aborted)
      throw voiceRefused("aborted", "join_aborted");
    if (this.joining !== null || this.live !== null)
      throw voiceRefused("busy", "voice_busy");
    const generation = this.generation;
    const controller = new AbortController();
    const abort = () => controller.abort();
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted) controller.abort();
    const finished = Promise.withResolvers<void>();
    void finished.promise.catch(() => undefined);
    const reservation = { controller, settled: finished.promise };
    this.joining = reservation;
    try {
      const raw = await this.sdk.joinHuddle(team, input.channelId, {
        credentials: this.credentials, speakerId: userId, signal: controller.signal,
      }).catch((error: Error) => { throw joinRefusal(error); });
      if (this.generation !== generation || controller.signal.aborted) {
        await Promise.resolve().then(() => raw.leave()).catch((error: Error) => {
          const refusal = joinRefusal(error);
          finished.reject(refusal);
          throw refusal;
        });
        throw voiceRefused(controller.signal.aborted ? "aborted" : "not_started", "join_stopped");
      }
      const handle = this.adaptVoice(raw, team, userId);
      this.live = handle;
      return handle;
    } finally {
      input.signal?.removeEventListener("abort", abort);
      if (this.joining === reservation) this.joining = null;
      finished.resolve();
    }
  }

  private adaptVoice(raw: SlackHuddleHandle, team: string, userId: string): PcmVoiceHandle {
    const release = () => {
      if (this.live?.pcmIn === raw.pcmIn) this.live = null;
    };
    let leaving: Promise<void> | null = null;
    const leave = (): Promise<void> => {
      leaving ??= Promise.resolve().then(() => raw.leave()).finally(release);
      return leaving;
    };
    const startLeave = () => {
      // The retained promise is awaited by stop(); handle rejection here only
      // when no caller is awaiting the fire-and-forget terminal cleanup.
      void leave().catch(() => undefined);
    };
    return {
      pcmIn: raw.pcmIn, pcmOut: raw.pcmOut,
      events: (async function* (): AsyncGenerator<VoiceEvent, void, void> {
        try {
          for await (const event of raw.events) {
            if (event.type === "disconnected" || event.type === "error" ||
                event.type === "speaker_left" && event.userId === userId) startLeave();
            yield event.type === "speaker_left"
              ? { type: "speaker_left", externalId: `${team}:${event.userId}` } satisfies VoiceEvent
              : event.type === "disconnected" || event.type === "error"
                ? { type: event.type, reason: safeVoiceReason(event.reason, `voice_${event.type}`) } satisfies VoiceEvent
                : event;
          }
        } catch {
          startLeave();
          yield { type: "error", reason: "voice_event_failed" } satisfies VoiceEvent;
        } finally {
          startLeave();
        }
      })(),
      leave,
    };
  }

  /**
   * One frame under the posture: the normalizer keeps the account's own
   * messages out and names a mention of the Owner; `mentions_and_dms` then
   * admits a DM or that mention. A top-level mention of the Owner opens no
   * thread root of its own: the bot's copy of the same message carries
   * none, and one physical message binds to one conversation whichever
   * instance observed it.
   */
  private handleFrame(event: PlainValue, key: string): void {
    const normalizer = this.normalizer;
    if (normalizer === null) return;
    const traceId = newTraceId(this.options.id);
    void handoffInbound({
      dedupe: this.dedupe,
      key,
      traceId,
      now: this.options.now,
      publish: this.publish,
      errorMessage: "slack owner message handling failed",
      rethrowFailure: false,
      handle: async () => {
        const frame = SlackMessageEventSchema.parse(event);
        const inbound = normalizer.normalize(frame);
        if (inbound === null || !this.admits(inbound)) return;
        const { reply, ...facts } = inbound.facts;
        await requireHandler(this.handler, "slack:owner")({
          ...inbound,
          facts: {
            ...facts,
            ...(frame.thread_ts === undefined || reply === undefined ? {} : { reply }),
            receivedBy: "owner",
          },
        });
      },
    });
  }

  private admits(inbound: Channel.InboundMessage): boolean {
    if (this.posture.intake === "all") return true;
    return inbound.facts.dm || inbound.facts.event === "mention";
  }

  /**
   * Delivery as the Owner: the registered ActorEndpoint externalId is the
   * workspace-mandatory `TEAM:USER` pair; without a conversation the Owner's
   * direct channel with that user is opened first. Media parts stay as their
   * reference lines (no upload through the account); reactions are the
   * Owner's own.
   */
  async deliver(
    externalId: string,
    payload: Outbound.Payload,
    idempotencyKey: string,
    conversation?: Gateway.Conversation,
  ): Promise<DeliveryReceipt> {
    const [team, user] = externalId.split(":");
    if (!(team && user)) {
      throw new SlackEndpointKeyError({
        message: `slack endpoint externalId must be "TEAM:USER", got "${externalId}"`,
      });
    }
    // The account session is one workspace's; an endpoint elsewhere is not a
    // send the Owner's account can make, and nothing is attempted.
    if (this.team === null)
      throw new DeliveryNotSent({ operation: "slack.owner", cause: "instance not started" });
    if (team !== this.team)
      throw new DeliveryNotSent({
        operation: "slack.owner",
        cause: `endpoint workspace ${team} is not the account's workspace ${this.team}`,
      });
    const threadTs = conversation?.threadId ?? conversation?.replyToMessageId;
    return deliverKeyed(
      this.outbound,
      idempotencyKey,
      async () => {
        const channelId =
          conversation?.channelId ??
          (await this.client.openConversation(user).then(
            (opened) => opened.channel_id,
            (error) => {
              throw new DeliveryNotSent({ operation: "slack.openConversation", cause: String(error) });
            },
          ));
        return await translate(
          payload,
          SLACK_RENDER,
          {
            text: async (chunk) =>
              (await this.call(() => this.client.sendMessage(channelId, chunk, threadTs)))?.ts,
            react: async (messageId, emoji, replaces) => {
              const name = slackEmojiName(emoji);
              const replaced = replaces === undefined ? undefined : slackEmojiName(replaces);
              if (name === undefined || (replaces !== undefined && replaced === undefined))
                throw new DeliveryNotSent({
                  operation: "slack.react",
                  cause: `no slack name for ${name === undefined ? emoji : replaces}`,
                });
              if (replaced !== undefined)
                await this.call(
                  () => this.client.removeReaction(channelId, messageId, replaced),
                  ["no_reaction"],
                );
              await this.call(
                () => this.client.addReaction(channelId, messageId, name),
                ["already_reacted"],
              );
            },
          },
          this.options.media,
        );
      },
      (error) => classifySlackFailure(error) === "rejected",
      this.publish,
      this.options,
    );
  }

  /** One SDK call under custody's evidence rule (the bot surface's `call`, over the Owner seam's error shape). */
  private async call<T>(
    operation: () => Promise<T>,
    settled: readonly string[] = [],
  ): Promise<T | undefined> {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      if (isSettledState(error, settled)) return undefined;
      if (classifySlackFailure(error) === "not_connected")
        throw new DeliveryNotSent({ operation: "slack.api", cause: String(error) });
      throw error;
    }
  }
}
