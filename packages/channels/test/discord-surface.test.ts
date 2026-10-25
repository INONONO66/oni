import { describe, expect, it } from "bun:test";
import { Operational } from "@oni/protocol";
import { z } from "zod";
import { DiscordAdapter } from "../src/provider/discord/surface";
import { DISCORD_INTENTS, DiscordVoiceError, type DiscordVoiceHandle } from "../src/provider/discord/sdk";
import { VoiceJoinRefused } from "../src/errors";
import type { PublishPort } from "../src/types";
import { bounded } from "./helpers/bounded";
import { inboundQueue } from "./helpers/inbound-queue";
import { FakeDiscordListener, READY, emptyVoiceStream, fakeDiscordSdk } from "./helpers/discord-sdk";
import { injectedOptions } from "./helpers/injected";

const noopPublish: PublishPort = () => undefined;
/** One started adapter over the scripted SDK listener, with an inbound queue. */
async function started(publish: PublishPort = noopPublish, listener?: FakeDiscordListener) {
  const fake = fakeDiscordSdk(listener);
  const adapter = new DiscordAdapter("token", {}, publish, injectedOptions(), fake.sdk);
  const queue = inboundQueue(adapter);
  await adapter.start("boot");
  return { ...fake, adapter, ...queue };
}

describe("DiscordAdapter over the agent-messenger gateway listener", () => {
  it("logs in with the bot token, identifies with the consumed intents, and binds the bot identity on READY", async () => {
    const infos: string[] = [];
    const { client, listener, next, adapter } = await started((event, data) => {
      if (event.name === Operational.Events.Info.name)
        infos.push(z.object({ msg: z.string() }).parse(data).msg);
    });
    expect(client.logins).toEqual(["token"]);
    expect(listener.intents).toBe(DISCORD_INTENTS);
    expect(listener.started).toBe(1);
    expect(infos).toContain("discord bot started");
    const facts = next();
    listener.dispatch("MESSAGE_CREATE", {
      id: "message",
      channel_id: "dm",
      author: { id: "user", username: "Sender" },
      content: "hello <@bot>",
      mentions: [{ id: "bot", username: "oni" }],
    });
    expect(await facts).toMatchObject({
      sender: { kind: "external", externalId: "user" },
      facts: { eventId: "message", render: "hello <@bot>", event: "mention", dm: true },
    });
    await adapter.stop("stop");
    expect(listener.stopped).toBe(1);
  });

  it("drops the bot's own gateway echo and delivers a reaction as facts", async () => {
    const { listener, next, inbound } = await started();
    listener.dispatch("MESSAGE_CREATE", {
      id: "echo",
      channel_id: "dm",
      author: { id: READY.user.id, username: "oni", bot: true },
      content: "my own post",
    });
    const facts = next();
    listener.dispatch("MESSAGE_REACTION_ADD", {
      user_id: "user",
      message_id: "message",
      channel_id: "dm",
      emoji: { name: "👍" },
    });
    expect(await facts).toMatchObject({
      sender: { externalId: "user" },
      facts: { event: "reaction", render: "👍", eventId: "message:👍:user" },
    });
    expect(inbound).toHaveLength(1);
  });

  it("acknowledges a component interaction through the API before handoff and warn-drops a refusal", async () => {
    const calls: string[] = [];
    const warned = Promise.withResolvers<string>();
    const { client, listener, next, inbound } = await started((event, data) => {
      const observed = z
        .object({ msg: z.string(), context: z.object({ err: z.string().optional() }).optional() })
        .parse(data);
      // The handoff's first observation; it must follow the ack's physical call.
      if (
        event.name === Operational.Events.Debug.name &&
        observed.msg === "discord message received"
      )
        calls.push("handoff");
      if (event.name !== Operational.Events.Warn.name) return;
      if (observed.msg === "discord interaction acknowledgment failed; dropped")
        warned.resolve(observed.context?.err ?? "");
    });
    const interaction = (id: string) => ({
      id,
      token: "token",
      channel_id: "dm",
      user: { id: "user", username: "Sender" },
      data: { custom_id: "approve", component_type: 2 },
      message: {
        id: "sent",
        components: [{ components: [{ custom_id: "approve", label: "Approve" }] }],
      },
    });
    const entered = Promise.withResolvers<void>();
    const ack = Promise.withResolvers<void>();
    const respond = client.respondToInteraction.bind(client);
    client.respondToInteraction = async (id, token, type) => {
      calls.push(`ack:${type}`);
      entered.resolve();
      await ack.promise;
      await respond(id, token, type);
      calls.push("ack-complete");
    };
    const facts = next();
    listener.dispatch("INTERACTION_CREATE", interaction("accepted"));
    await bounded(entered.promise);
    expect(inbound).toHaveLength(0);
    expect(calls).toEqual(["ack:6"]);
    ack.resolve();
    expect(await facts).toMatchObject({
      facts: {
        event: "postback",
        render: "Approve",
        postback: { id: "approve", label: "Approve", messageRef: "sent" },
      },
    });
    client.fail("respondToInteraction:refused", new Error("refused"));
    listener.dispatch("INTERACTION_CREATE", interaction("refused"));
    expect(await bounded(warned.promise)).not.toContain("/refused/token/");
    expect(client.calls.map(({ method }) => method)).toEqual([
      "respondToInteraction",
      "respondToInteraction",
    ]);
    expect(calls).toEqual(["ack:6", "ack-complete", "handoff", "ack:6"]);
    expect(client.calls.map(({ type }) => type)).toEqual([6, 6]);
  });

  it("ignores interactions that are not component taps without calling the API", async () => {
    const { client, listener, inbound } = await started();
    listener.dispatch("INTERACTION_CREATE", {
      id: "slash",
      token: "token",
      channel_id: "dm",
      user: { id: "user", username: "Sender" },
      data: { name: "deploy" },
    });
    expect(client.calls).toHaveLength(0);
    expect(inbound).toHaveLength(0);
  });

  it("warns and drops a malformed dispatch", async () => {
    const warns: string[] = [];
    const { listener } = await started((event, data) => {
      if (event.name === Operational.Events.Warn.name)
        warns.push(z.object({ msg: z.string() }).parse(data).msg);
    });
    listener.dispatch("MESSAGE_CREATE", { nope: true });
    listener.dispatch("MESSAGE_REACTION_ADD", { nope: true });
    expect(warns).toEqual([
      "discord MESSAGE_CREATE payload malformed; dropped",
      "discord MESSAGE_REACTION_ADD payload malformed; dropped",
    ]);
  });

  it("fails start on an error before READY and leaves no listener behind", async () => {
    const listener = new FakeDiscordListener((self) => {
      self.emit("error", new Error("Discord gateway closed with non-recoverable code 4004"));
    });
    const fake = fakeDiscordSdk(listener);
    const adapter = new DiscordAdapter("token", {}, noopPublish, injectedOptions(), fake.sdk);
    adapter.onMessage(async () => undefined);
    await expect(adapter.start("boot")).rejects.toThrow("non-recoverable code 4004");
    expect(listener.stopped).toBe(1);
  });

  it("leaves a close before READY to the SDK's own reconnect and settles start on the READY that follows", async () => {
    const seen: string[] = [];
    const listener = new FakeDiscordListener((self) => {
      self.emit("disconnected");
      self.emit("connected", READY);
    });
    const { adapter } = await started((event, data) => {
      seen.push(`${event.name}:${z.object({ msg: z.string() }).parse(data).msg}`);
    }, listener);
    expect(listener.stopped).toBe(0);
    expect(seen).toEqual([`${Operational.Events.Info.name}:discord bot started`]);
    await adapter.stop("stop");
  });

  it("fails start when the SDK's own start rejects (connect timeout), leaving no listener behind", async () => {
    const listener = new FakeDiscordListener(() => undefined);
    listener.start = async () => {
      listener.started += 1;
      throw new Error("Discord gateway did not become ready within 1000ms");
    };
    const fake = fakeDiscordSdk(listener);
    const adapter = new DiscordAdapter("token", {}, noopPublish, injectedOptions(), fake.sdk);
    adapter.onMessage(async () => undefined);
    await expect(adapter.start("boot")).rejects.toThrow("did not become ready");
    expect(listener.stopped).toBe(1);
  });

  it("rebinds the bot identity on a resume READY: the new id is filtered, the old id is now a sender", async () => {
    const { listener, next, inbound } = await started();
    listener.emit("disconnected");
    listener.emit("connected", { user: { id: "bot2", username: "oni" }, sessionId: "s2" });
    listener.dispatch("MESSAGE_CREATE", {
      id: "own",
      channel_id: "dm",
      author: { id: "bot2", username: "oni", bot: true },
      content: "echo under the new id",
    });
    const fromOldId = next();
    listener.dispatch("MESSAGE_CREATE", {
      id: "old-id",
      channel_id: "dm",
      author: { id: READY.user.id, username: "someone-else" },
      content: "the previous bot id is just a user now",
    });
    expect(await fromOldId).toMatchObject({
      sender: { externalId: READY.user.id },
      facts: { eventId: "old-id" },
    });
    const facts = next();
    listener.dispatch("MESSAGE_CREATE", {
      id: "after-resume",
      channel_id: "dm",
      author: { id: "user", username: "Sender" },
      content: "still here",
    });
    expect((await facts).facts.eventId).toBe("after-resume");
    expect(inbound.map((message) => message.facts.eventId)).toEqual(["old-id", "after-resume"]);
  });

  it("a non-recoverable close after READY is a typed dead surface, not a warning", async () => {
    const errors: string[] = [];
    const { listener } = await started((event, data) => {
      if (event.name === Operational.Events.Error.name)
        errors.push(z.object({ msg: z.string() }).parse(data).msg);
    });
    listener.emit("error", new Error("Discord gateway closed with non-recoverable code 4014"));
    expect(listener.stopped).toBe(1);
    expect(errors).toEqual([
      "discord gateway dead: Discord gateway closed with non-recoverable code 4014",
    ]);
  });
});

const state = (channel_id: string | null, user_id = "owner", guild_id?: string) => ({
  ...(guild_id === undefined ? {} : { guild_id }), channel_id, user_id, session_id: "voice-session",
  deaf: false, mute: false, self_deaf: false, self_mute: false, self_video: false, suppress: false,
});

function fakeVoice(events?: DiscordVoiceHandle["events"]) {
  const left = { count: 0 };
  const ended = Promise.withResolvers<void>();
  const handle: DiscordVoiceHandle = {
    pcmIn: emptyVoiceStream(),
    pcmOut: { write: async () => undefined },
    events: events ?? (async function* () {
      await ended.promise;
      yield { type: "ready" } as const;
    })(),
    leave: async () => { left.count += 1; ended.resolve(); },
  };
  return { handle, left };
}

describe("Discord bot voice route and call facts", () => {
  it("dispatches one exact call fact per join or move, without replay, departure, echo or missing guild", async () => {
    const { client, listener, next, inbound, adapter } = await started();
    const first = next();
    const joined = state("voice-one", "owner", "guild");
    listener.emit("voice_state_update", joined, 42);
    expect(await first).toEqual({
      sender: { kind: "external", surface: "discord", externalId: "owner" },
      facts: {
        eventId: "call:guild:owner:session:42", event: "call", surface: "discord",
        workspaceId: "guild", channelId: "voice-one",
        author: { externalId: "owner", isBot: false }, addressees: [{ externalId: "bot" }],
        dm: false, payload: joined, render: "joined voice channel voice-one",
      },
    });
    listener.emit("voice_state_update", joined, 43);
    listener.emit("connected", READY);
    listener.emit("voice_state_update", joined, 44);
    listener.emit("voice_state_update", state("stale", "owner", "guild"), 41);
    listener.emit("voice_state_update", state(null, "owner", "guild"), 45);
    listener.emit("voice_state_update", state("voice-two", "bot", "guild"), 46);
    listener.emit("voice_state_update", state("voice-two", "owner"), 47);
    client.getUser = async () => ({ bot: true });
    listener.emit("voice_state_update", state("voice-two", "another-bot", "guild"), 49);
    client.getUser = async () => ({ bot: false });
    expect(inbound).toHaveLength(1);
    const second = next();
    listener.emit("voice_state_update", state("voice-two", "owner", "guild"), 48);
    expect((await second).facts.eventId).toBe("call:guild:owner:session:48");
    expect(inbound).toHaveLength(2);
    await adapter.stop("stop");
  });

  it("requires a speaker and started READY listener, and resolves only guild voice channels", async () => {
    const fake = fakeDiscordSdk();
    const adapter = new DiscordAdapter("token", {}, noopPublish, injectedOptions(), fake.sdk);
    adapter.onMessage(async () => undefined);
    const address = { surface: "discord", channelId: "channel", speakerExternalId: "owner" };
    await expect(adapter.joinVoice(address)).rejects.toEqual(
      new VoiceJoinRefused({ reason: "not_started", surface: "discord", detail: "Discord gateway is not READY" }));
    await adapter.start("boot");
    await expect(adapter.joinVoice({ ...address, speakerExternalId: undefined })).rejects.toMatchObject({
      _tag: "VoiceJoinRefused", reason: "address_incomplete", detail: "speakerExternalId is required",
    });
    const voice = fakeVoice();
    fake.sdk.joinVoice = async () => voice.handle;
    const joined = await adapter.joinVoice(address);
    expect(fake.client.calls).toContainEqual({ method: "getChannel", channelId: "channel" });
    await joined.leave();
    fake.client.getChannel = async () => ({ guild_id: "guild", type: 0 });
    await expect(adapter.joinVoice(address)).rejects.toMatchObject({
      reason: "address_incomplete", detail: "channel is not a guild voice channel",
    });
    fake.client.fail("getChannel", new Error("REST refused"));
    fake.client.getChannel = async () => { throw new Error("REST refused"); };
    await expect(adapter.joinVoice(address)).rejects.toMatchObject({
      reason: "address_incomplete", detail: "channel lookup failed: Error: REST refused",
    });
    await adapter.stop("stop");
  });

  it("maps each fork refusal exactly and fences a second live guild join until leave", async () => {
    const fake = fakeDiscordSdk();
    const adapter = new DiscordAdapter("token", {}, noopPublish, injectedOptions(), fake.sdk);
    adapter.onMessage(async () => undefined);
    await adapter.start("boot");
    const address = { surface: "discord", channelId: "channel", workspaceId: "guild",
      speakerExternalId: "owner" };
    for (const [code, reason] of [
      ["voice_aborted", "aborted"], ["voice_join_failed", "join_failed"],
      ["voice_not_ready", "not_started"], ["voice_busy", "busy"],
    ] as const) {
      fake.sdk.joinVoice = async () => { throw new DiscordVoiceError(code); };
      await expect(adapter.joinVoice(address)).rejects.toMatchObject({
        _tag: "VoiceJoinRefused", reason, surface: "discord", detail: code,
      });
    }
    const voice = fakeVoice();
    fake.sdk.joinVoice = async () => voice.handle;
    await adapter.joinVoice(address);
    await expect(adapter.joinVoice(address)).rejects.toMatchObject({ reason: "busy" });
    await adapter.stop("stop");
    expect(voice.left.count).toBe(1);
    expect(fake.listener.stopped).toBe(1);
  });

  it("maps speaker_left and other handle events and releases a completed handle", async () => {
    const fake = fakeDiscordSdk();
    const adapter = new DiscordAdapter("token", {}, noopPublish, injectedOptions(), fake.sdk);
    adapter.onMessage(async () => undefined);
    await adapter.start("boot");
    const voice = fakeVoice((async function* () {
      yield { type: "ready" } as const;
      yield { type: "speaker_left", userId: "owner" } as const;
      yield { type: "disconnected", reason: "closed" } as const;
      yield { type: "error", reason: "failed" } as const;
    })());
    fake.sdk.joinVoice = async () => voice.handle;
    const address = { surface: "discord", channelId: "channel", workspaceId: "guild",
      speakerExternalId: "owner" };
    const handle = await adapter.joinVoice(address);
    const events: import("../src/provider/voice").VoiceEvent[] = [];
    for await (const event of handle.events) events.push(event);
    expect(events).toEqual([
      { type: "ready" }, { type: "speaker_left", externalId: "owner" },
      { type: "disconnected", reason: "closed" }, { type: "error", reason: "failed" },
    ]);
    await adapter.joinVoice(address);
    await adapter.stop("stop");
  });

  it("releases a disconnected handle even without an event consumer", async () => {
    const fake = fakeDiscordSdk();
    const adapter = new DiscordAdapter("token", {}, noopPublish, injectedOptions(), fake.sdk);
    adapter.onMessage(async () => undefined);
    await adapter.start("boot");
    const terminated = Promise.withResolvers<void>();
    const consumed = Promise.withResolvers<void>();
    const first = fakeVoice((async function* () {
      await terminated.promise;
      yield { type: "disconnected", reason: "closed" } as const;
      consumed.resolve();
    })());
    const second = fakeVoice();
    let joins = 0;
    fake.sdk.joinVoice = async () => (++joins === 1 ? first.handle : second.handle);
    const address = { surface: "discord", channelId: "voice", workspaceId: "guild",
      speakerExternalId: "owner" };
    await adapter.joinVoice(address);
    terminated.resolve();
    await consumed.promise;
    await adapter.joinVoice(address);
    await adapter.stop("stop");
    expect(joins).toBe(2);
    expect(second.left.count).toBe(1);
  });

  it("refuses while disconnected and releases a join that finishes after stop", async () => {
    const fake = fakeDiscordSdk();
    const adapter = new DiscordAdapter("token", {}, noopPublish, injectedOptions(), fake.sdk);
    adapter.onMessage(async () => undefined);
    await adapter.start("boot");
    const address = { surface: "discord", channelId: "channel", workspaceId: "guild",
      speakerExternalId: "owner" };
    fake.listener.emit("disconnected");
    await expect(adapter.joinVoice(address)).rejects.toMatchObject({ reason: "not_started" });
    fake.listener.emit("connected", READY);
    const pending = Promise.withResolvers<DiscordVoiceHandle>();
    fake.sdk.joinVoice = async () => pending.promise;
    const joining = adapter.joinVoice(address);
    const refused = joining.then(() => "joined", (error: VoiceJoinRefused) => error);
    await expect(adapter.joinVoice(address)).rejects.toMatchObject({ reason: "busy" });
    await adapter.stop("stop");
    const voice = fakeVoice();
    pending.resolve(voice.handle);
    expect(await refused).toMatchObject({ reason: "not_started" });
    expect(voice.left.count).toBe(1);
  });

  it("stops the listener after attempting every live leave even if one fails", async () => {
    const fake = fakeDiscordSdk();
    const adapter = new DiscordAdapter("token", {}, noopPublish, injectedOptions(), fake.sdk);
    adapter.onMessage(async () => undefined);
    await adapter.start("boot");
    const left: string[] = [];
    const secondLeave = Promise.withResolvers<void>();
    const secondStarted = Promise.withResolvers<void>();
    fake.sdk.joinVoice = async (guild) => {
      const ended = Promise.withResolvers<void>();
      return {
        pcmIn: emptyVoiceStream(), pcmOut: { write: async () => undefined },
        events: (async function* () { await ended.promise; yield { type: "ready" } as const; })(),
        leave: async () => {
          left.push(guild);
          if (guild === "one") {
            ended.resolve();
            throw new Error("leave refused");
          }
          secondStarted.resolve();
          await secondLeave.promise;
          ended.resolve();
        },
      };
    };
    await adapter.joinVoice({ surface: "discord", channelId: "voice", workspaceId: "one",
      speakerExternalId: "owner" });
    await adapter.joinVoice({ surface: "discord", channelId: "voice", workspaceId: "two",
      speakerExternalId: "owner" });
    const stopping = adapter.stop("stop");
    const refused = stopping.then(() => "stopped", (error: Error) => error);
    await secondStarted.promise;
    expect(fake.listener.stopped).toBe(0);
    secondLeave.resolve();
    expect(await refused).toMatchObject({ message: "leave refused" });
    expect(left).toEqual(["one", "two"]);
    expect(fake.listener.stopped).toBe(1);
  });
});
