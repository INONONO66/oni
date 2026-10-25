import { describe, expect, it } from "bun:test";
import { Operational, Outbound } from "@oni/protocol";
import { z } from "zod";
import { DeliveryNotSent, SlackEndpointKeyError } from "../src/errors";
import type { OwnerPosture } from "../src/provider/contract";
import { SlackOwnerError } from "../src/provider/slack/owner-sdk";
import { SlackOwnerAdapter } from "../src/provider/slack/owner";
import { createSlackProvider } from "../src/provider/slack/provider";
import type { PublishPort } from "../src/types";
import { infoCollector } from "./helpers/observation";
import { inboundQueue } from "./helpers/inbound-queue";
import { injectedOptions } from "./helpers/injected";
import { fakeSlackSdk } from "./helpers/slack-sdk";
import {
  FakeSlackOwnerListener,
  fakeSlackOwnerSdk,
  OWNER_DM,
  type OwnerScript,
} from "./helpers/slack-owner-sdk";

const noopPublish: PublishPort = () => undefined;
const CREDENTIALS = { token: "xoxc-1", cookie: "d-cookie" };
const SEND_ONLY: OwnerPosture = { intake: "none", autoReply: false };
const DEFAULT_INTAKE: OwnerPosture = { intake: "mentions_and_dms", autoReply: false };

/** One started Owner instance over the scripted user SDK; send-only unless a posture says otherwise. */
async function started(
  script: OwnerScript = {},
  publish: PublishPort = noopPublish,
  posture: OwnerPosture = SEND_ONLY,
  listener?: FakeSlackOwnerListener,
) {
  const fake = fakeSlackOwnerSdk(script, listener);
  const adapter = new SlackOwnerAdapter(CREDENTIALS, posture, publish, injectedOptions(), fake.sdk);
  const queue = inboundQueue(adapter);
  await adapter.start("boot");
  return { ...fake, adapter, ...queue };
}

/**
 * Frames are handed off in arrival order, so a DM that follows the frames
 * under test proves every earlier frame was decided: what reached the
 * handler before it is exactly the intake.
 */
const SENTINEL = { channel: "D-owner", user: "U7", text: "sentinel", ts: "1799.9" };

/** The user SDK's refusal shapes: a forwarded web-api code, or its own `ok:false` check naming the Slack error. */
const webApi = (message: string, code: string) => new SlackOwnerError(message, code);

/** Drains the queue with the sentinel and asserts nothing else was handed off. */
const onlySentinel = async ({
  listener,
  next,
  inbound,
}: Pick<Awaited<ReturnType<typeof started>>, "listener" | "next" | "inbound">) => {
  const sentinel = next();
  listener.message(SENTINEL);
  await sentinel;
  expect(inbound.map((message) => message.facts.eventId)).toEqual([SENTINEL.ts]);
};

describe("SlackOwnerAdapter: the Owner's own account as the slack:owner instance (#1569)", () => {
  it("logs in with the account session, pins the inner client to one attempt, and verifies the identity before it counts as started", async () => {
    const { infos, publish } = infoCollector();
    const { adapter, client, listener } = await started({}, publish);
    expect(adapter.id).toBe("slack:owner");
    // #1600: the account is the Owner's Slack endpoint, TEAM:USER in workspace TEAM.
    expect(adapter.account()).toEqual({ externalId: "T1:U-owner", workspace: "T1" });
    expect(client.calls.map((call) => call.method)).toEqual(["login", "testAuth"]);
    expect(client.calls[0]?.args).toEqual(["xoxc-1", "d-cookie"]);
    expect(client.client).toEqual({ retryConfig: { retries: 0 }, rejectRateLimitedCalls: true });
    expect(infos).toEqual([
      {
        msg: "slack owner instance started",
        context: { userId: "U-owner", team: "T1", listener: "none" },
      },
    ]);
    expect(listener.started).toBe(0);
    adapter.stop("stop");
    expect(infos.at(-1)?.msg).toBe("slack owner instance stopped");
  });

  it("a refused login fails start, so the instance never counts as mounted", async () => {
    const fake = fakeSlackOwnerSdk({ login: webApi("Cookie is required", "missing_cookie") });
    const adapter = new SlackOwnerAdapter(
      CREDENTIALS,
      SEND_ONLY,
      noopPublish,
      injectedOptions(),
      fake.sdk,
    );
    await expect(adapter.start("boot")).rejects.toMatchObject({ code: "missing_cookie" });
  });

  describe("intake through the account's RTM listener (#1569 lane 6)", () => {
    it("opens the listener over the account client under the default posture and settles on hello", async () => {
      const { infos, publish } = infoCollector();
      const { listener, listenerClient, client, adapter } = await started(
        {},
        publish,
        DEFAULT_INTAKE,
      );
      expect(listener.started).toBe(1);
      expect(listenerClient()).toBe(client);
      expect(infos.at(-1)).toEqual({
        msg: "slack owner instance started",
        context: { userId: "U-owner", team: "T1", listener: "mentions_and_dms" },
      });
      adapter.stop("stop");
      expect(listener.stopped).toBe(1);
    });

    it("a DM to the Owner and a mention of the Owner reach the handler as received by the Owner; the rest of a channel does not", async () => {
      const { listener, next, inbound } = await started({}, noopPublish, DEFAULT_INTAKE);
      const dm = next();
      listener.message({ channel: "D-owner", user: "U7", text: "are you around?", ts: "1700.1" });
      expect(await dm).toMatchObject({
        sender: { kind: "external", surface: "slack", externalId: "T1:U7" },
        facts: {
          eventId: "1700.1",
          event: "message",
          dm: true,
          receivedBy: "owner",
          channelId: "D-owner",
        },
      });
      const mention = next();
      listener.message({
        channel: "C-general",
        user: "U7",
        text: "hey <@U-owner>, thoughts?",
        ts: "1700.2",
      });
      expect(await mention).toMatchObject({
        facts: {
          eventId: "1700.2",
          event: "mention",
          dm: false,
          receivedBy: "owner",
          addressees: [{ externalId: "T1:U-owner" }],
        },
      });
      listener.message({
        channel: "C-general",
        user: "U7",
        text: "unrelated chatter",
        ts: "1700.3",
      });
      const sentinel = next();
      listener.message(SENTINEL);
      await sentinel;
      expect(inbound.map((message) => message.facts.eventId)).toEqual([
        "1700.1",
        "1700.2",
        SENTINEL.ts,
      ]);
    });

    it("the account's own messages are never an outside event, in a DM or a channel", async () => {
      const { listener, next, inbound } = await started({}, noopPublish, DEFAULT_INTAKE);
      listener.message({ channel: "D-owner", user: "U-owner", text: "my own note", ts: "1700.4" });
      listener.message({
        channel: "C-general",
        user: "U-owner",
        text: "<@U-owner> talking to myself",
        ts: "1700.5",
      });
      await onlySentinel({ listener, next, inbound });
    });

    it("a top-level mention of the Owner opens no thread root (the bot's copy carries none); an in-thread message keeps its thread", async () => {
      const { listener, next } = await started({}, noopPublish, DEFAULT_INTAKE);
      const topLevel = next();
      listener.message({ channel: "C-general", user: "U7", text: "<@U-owner> look", ts: "1700.6" });
      expect((await topLevel).facts.reply).toBeUndefined();
      const inThread = next();
      listener.message({
        channel: "C-general",
        user: "U7",
        text: "<@U-owner> again",
        ts: "1700.7",
        thread_ts: "1700.6",
      });
      expect((await inThread).facts.reply).toEqual({ chain: ["1700.6"], threadId: "1700.6" });
    });

    it("a reaction is not intake: the router routes a reaction only as the answer to a request", async () => {
      const { listener, next, inbound } = await started({}, noopPublish, DEFAULT_INTAKE);
      listener.reaction({
        user: "U7",
        reaction: "eyes",
        channel: "D-owner",
        ts: "1700.8",
        itemUser: "U-owner",
      });
      await onlySentinel({ listener, next, inbound });
    });

    it("under `all` everything the account can see is intake, still never its own echo", async () => {
      const { listener, next, inbound } = await started({}, noopPublish, {
        intake: "all",
        autoReply: false,
      });
      listener.message({
        channel: "C-general",
        user: "U7",
        text: "unrelated chatter",
        ts: "1700.9",
      });
      listener.message({ channel: "C-general", user: "U-owner", text: "mine", ts: "1700.10" });
      const sentinel = next();
      listener.message(SENTINEL);
      await sentinel;
      expect(inbound.map((message) => message.facts.eventId)).toEqual(["1700.9", SENTINEL.ts]);
    });

    it("a frame the listener repeats is handed off once", async () => {
      const { listener, next, inbound } = await started({}, noopPublish, DEFAULT_INTAKE);
      listener.message({ channel: "D-owner", user: "U7", text: "once", ts: "1700.12" });
      listener.message({ channel: "D-owner", user: "U7", text: "once", ts: "1700.12" });
      const sentinel = next();
      listener.message(SENTINEL);
      await sentinel;
      expect(inbound.map((message) => message.facts.eventId)).toEqual(["1700.12", SENTINEL.ts]);
    });

    it("a refused RTM connect fails start and leaves no listener behind", async () => {
      const refusing = new FakeSlackOwnerListener((self) =>
        self.emit(
          "error",
          new SlackOwnerError("An API error occurred: invalid_auth", "invalid_auth"),
        ),
      );
      const fake = fakeSlackOwnerSdk({}, refusing);
      const adapter = new SlackOwnerAdapter(
        CREDENTIALS,
        DEFAULT_INTAKE,
        noopPublish,
        injectedOptions(),
        fake.sdk,
      );
      adapter.onMessage(async () => undefined);
      await expect(adapter.start("boot")).rejects.toMatchObject({ code: "invalid_auth" });
      expect(refusing.stopped).toBe(1);
    });

    it("a revoked session after hello is a typed dead surface: custody stops the SDK's endless reopen", async () => {
      const errors: string[] = [];
      const { listener } = await started(
        {},
        (event, data) => {
          if (event.name === Operational.Events.Error.name)
            errors.push(z.object({ msg: z.string() }).parse(data).msg);
        },
        DEFAULT_INTAKE,
      );
      listener.emit(
        "error",
        new SlackOwnerError("An API error occurred: account_inactive", "account_inactive"),
      );
      expect(listener.stopped).toBe(1);
      expect(errors).toEqual(["slack rtm dead: An API error occurred: account_inactive"]);
    });

    it("without a bound handler the instance only sends, whatever the posture", async () => {
      const fake = fakeSlackOwnerSdk();
      const adapter = new SlackOwnerAdapter(
        CREDENTIALS,
        DEFAULT_INTAKE,
        noopPublish,
        injectedOptions(),
        fake.sdk,
      );
      await adapter.start("boot");
      expect(fake.listener.started).toBe(0);
    });
  });

  it("refuses a bare user id: the endpoint key is workspace-mandatory", async () => {
    const { adapter } = await started();
    await expect(adapter.deliver("U7", Outbound.payload("hi"), "k-1")).rejects.toBeInstanceOf(
      SlackEndpointKeyError,
    );
  });

  it("refuses an endpoint of another workspace: the account session is one workspace's, and nothing is attempted", async () => {
    const { adapter, client } = await started();
    await expect(adapter.deliver("T2:U7", Outbound.payload("hi"), "k-1")).rejects.toBeInstanceOf(
      DeliveryNotSent,
    );
    expect(client.of("openConversation")).toEqual([]);
    expect(client.of("sendMessage")).toEqual([]);
  });

  it("delivers a letter into the Owner's direct channel with the person when no conversation is named", async () => {
    const { adapter, client } = await started();
    const receipt = await adapter.deliver("T1:U7", Outbound.payload("hi there"), "k-1");
    expect(receipt).toEqual({ value: "sent", externalMessageId: "1700.1" });
    expect(client.of("openConversation").map((call) => call.args)).toEqual([["U7"]]);
    expect(client.of("sendMessage").map((call) => call.args)).toEqual([
      [OWNER_DM, "hi there", null],
    ]);
  });

  it("delivers into the conversation the person wrote in, threading under their message", async () => {
    const { adapter, client } = await started();
    await adapter.deliver("T1:U7", Outbound.payload("in thread"), "k-2", {
      channelId: "C1",
      replyToMessageId: "1690.5",
    });
    expect(client.of("openConversation")).toEqual([]);
    expect(client.of("sendMessage").map((call) => call.args)).toEqual([
      ["C1", "in thread", "1690.5"],
    ]);
  });

  it("a media part stays as its reference line: the account uploads nothing", async () => {
    const { adapter, client } = await started();
    const payload: Outbound.Payload = {
      kind: "message",
      parts: [
        { kind: "text", text: "see" },
        { kind: "image", ref: "https://example.test/shot.png" },
      ],
    };
    const receipt = await adapter.deliver("T1:U7", payload, "k-3", { channelId: "C1" });
    expect(receipt.value).toBe("sent");
    const texts = client.of("sendMessage").map((call) => String(call.args[1]));
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain("https://example.test/shot.png");
  });

  it("a reaction swaps the Owner's earlier emoji for the new one; a state that already holds is success", async () => {
    const { adapter, client } = await started({
      addReaction: webApi("An API error occurred: already_reacted", "slack_webapi_platform_error"),
      removeReaction: webApi("no_reaction", "no_reaction"),
    });
    const receipt = await adapter.deliver(
      "T1:U7",
      { kind: "react", messageId: "1690.5", emoji: "✅", replaces: "👀" },
      "k-4",
      { channelId: "C1" },
    );
    expect(receipt.value).toBe("sent");
    expect(client.of("removeReaction").map((call) => call.args)).toEqual([
      ["C1", "1690.5", "eyes"],
    ]);
    expect(client.of("addReaction").map((call) => call.args)).toEqual([
      ["C1", "1690.5", "white_check_mark"],
    ]);
  });

  it.each([
    [
      "a refused open",
      {
        openConversation: webApi(
          "An API error occurred: user_not_found",
          "slack_webapi_platform_error",
        ),
      },
      "not_sent",
    ],
    [
      "a platform refusal the SDK checked itself",
      { sendMessage: webApi("channel_not_found", "channel_not_found") },
      "not_sent",
    ],
    [
      "a forwarded platform refusal",
      {
        sendMessage: webApi("An API error occurred: not_in_channel", "slack_webapi_platform_error"),
      },
      "not_sent",
    ],
    [
      "a rate limit after the SDK's bounded retries",
      { sendMessage: webApi("rate limited", "slack_webapi_rate_limited_error") },
      "not_sent",
    ],
    [
      "a connection never established",
      {
        sendMessage: webApi(
          "A request error occurred: getaddrinfo ENOTFOUND slack.com",
          "slack_webapi_request_error",
        ),
      },
      "not_sent",
    ],
    [
      "an http error after the request left",
      {
        sendMessage: webApi(
          "An HTTP protocol error occurred: statusCode = 503",
          "slack_webapi_http_error",
        ),
      },
      "unknown",
    ],
    [
      "a reset mid-request",
      {
        sendMessage: webApi(
          "A request error occurred: read ECONNRESET",
          "slack_webapi_request_error",
        ),
      },
      "unknown",
    ],
    [
      "the SDK's wrapper for an uncoded throw",
      { sendMessage: webApi("Cannot read properties of undefined", "unknown_error") },
      "unknown",
    ],
  ] as const)("%s is proven %s", async (_name, script, value) => {
    const { adapter } = await started(script);
    // The open is reached only when no conversation names the channel.
    const conversation = "openConversation" in script ? undefined : { channelId: "C1" };
    const receipt = await adapter.deliver("T1:U7", Outbound.payload("hi"), "k-5", conversation);
    expect(receipt.value).toBe(value);
  });

  it("the provider's owner arm builds delivery and voice beside the text-only bot arm", () => {
    const owner = fakeSlackOwnerSdk();
    const provider = createSlackProvider(fakeSlackSdk().sdk, owner.sdk);
    expect(provider.owner?.capabilities).toEqual({
      deliver: true,
      react: true,
      media: false,
      typing: false,
      voice: true,
    });
    expect(provider.owner?.credentials.safeParse(CREDENTIALS).success).toBe(true);
    expect(
      provider.owner?.credentials.safeParse({ botToken: "xoxb-1", appToken: "xapp-1" }).success,
    ).toBe(false);
    expect(provider.owner?.credentials.safeParse({ ...CREDENTIALS, extra: 1 }).success).toBe(false);
    const runtime = provider.owner?.create(CREDENTIALS, SEND_ONLY, noopPublish, injectedOptions());
    expect(runtime?.surface.id).toBe("slack:owner");
    expect(runtime?.deliveryRoute).toBeDefined();
    expect(runtime?.voiceRoute).toBeDefined();
    expect(runtime?.webhookHandler).toBeUndefined();
    expect(runtime?.typingRoute).toBeUndefined();
  });
});

it("#1600: a Slack Owner instance names no account before it started", () => {
  const fake = fakeSlackOwnerSdk({});
  const adapter = new SlackOwnerAdapter(
    CREDENTIALS,
    DEFAULT_INTAKE,
    noopPublish,
    injectedOptions(),
    fake.sdk,
  );
  expect(adapter.account()).toBeUndefined();
});
