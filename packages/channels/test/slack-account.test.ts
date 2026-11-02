import { describe, expect, it } from "bun:test";
import { Operational, Outbound } from "@oni/protocol";
import { z } from "zod";
import { DeliveryNotSent, SlackEndpointKeyError } from "../src/errors.js";
import { SlackAccountError } from "../src/provider/slack/account-sdk.js";
import { SlackAccountAdapter } from "../src/provider/slack/account.js";
import { createSlackProvider } from "../src/provider/slack/provider.js";
import type { PublishPort } from "../src/types.js";
import { infoCollector } from "./helpers/observation.js";
import { inboundQueue } from "./helpers/inbound-queue.js";
import { injectedOptions } from "./helpers/injected.js";
import { fakeSlackSdk } from "./helpers/slack-sdk.js";
import {
  FakeSlackAccountListener,
  fakeSlackAccountSdk,
  ACCOUNT_DM,
  type AccountScript,
} from "./helpers/slack-account-sdk.js";

const noopPublish: PublishPort = () => undefined;
const CREDENTIALS = { token: "xoxc-1", cookie: "d-cookie" };

/** One started Account instance over the scripted user SDK; send-only unless a posture says otherwise. */
async function started(
  script: AccountScript = {},
  publish: PublishPort = noopPublish,
  listener?: FakeSlackAccountListener,
) {
  const fake = fakeSlackAccountSdk(script, listener);
  const adapter = new SlackAccountAdapter(CREDENTIALS, publish, injectedOptions(), fake.sdk);
  const queue = inboundQueue(adapter);
  await adapter.start("boot");
  return { ...fake, adapter, ...queue };
}

/**
 * Frames are handed off in arrival order, so a DM that follows the frames
 * under test proves every earlier frame was decided: what reached the
 * handler before it is exactly the ingress.
 */
const SENTINEL = { channel: "D-account", user: "U7", text: "sentinel", ts: "1799.9" };

/** The user SDK's refusal shapes: a forwarded web-api code, or its own `ok:false` check naming the Slack error. */
const webApi = (message: string, code: string) => new SlackAccountError(message, code);

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

describe("SlackAccountAdapter: a user account as the slack:account instance (#1569)", () => {
  it("logs in with the account session, pins the inner client to one attempt, and verifies the identity before it counts as started", async () => {
    const { infos, publish } = infoCollector();
    const { adapter, client, listener } = await started({}, publish);
    expect(adapter.id).toBe("channel:test:main");
    // #1600: the account is the Account's Slack endpoint, TEAM:USER in workspace TEAM.
    expect(adapter.account()).toEqual({ externalId: "T1:U-account", workspace: "T1" });
    expect(client.calls.map((call) => call.method)).toEqual(["login", "testAuth"]);
    expect(client.calls[0]?.args).toEqual(["xoxc-1", "d-cookie"]);
    expect(client.client).toEqual({ retryConfig: { retries: 0 }, rejectRateLimitedCalls: true });
    expect(infos).toEqual([
      {
        msg: "slack account instance started",
        context: { userId: "U-account", team: "T1", listener: true },
      },
    ]);
    expect(listener.started).toBe(1);
    adapter.stop("stop");
    expect(infos.at(-1)?.msg).toBe("slack account instance stopped");
  });

  it("a refused login fails start, so the instance never counts as mounted", async () => {
    const fake = fakeSlackAccountSdk({ login: webApi("Cookie is required", "missing_cookie") });
    const adapter = new SlackAccountAdapter(
      CREDENTIALS,
      noopPublish,
      injectedOptions(),
      fake.sdk,
    );
    await expect(adapter.start("boot")).rejects.toMatchObject({ code: "missing_cookie" });
  });

  describe("ingress through the account's RTM listener (#1569 lane 6)", () => {
    it("opens the listener over the account client under the default posture and settles on hello", async () => {
      const { infos, publish } = infoCollector();
      const { listener, listenerClient, client, adapter } = await started(
        {},
        publish,
        );
      expect(listener.started).toBe(1);
      expect(listenerClient()).toBe(client);
      expect(infos.at(-1)).toEqual({
        msg: "slack account instance started",
        context: { userId: "U-account", team: "T1", listener: true },
      });
      adapter.stop("stop");
      expect(listener.stopped).toBe(1);
    });

    it("a DM to the Account and a mention of the Account reach the handler as received by the Account; unaddressed messages also reach the router", async () => {
      const { listener, next, inbound } = await started({}, noopPublish, );
      const dm = next();
      listener.message({ channel: "D-account", user: "U7", text: "are you around?", ts: "1700.1" });
      expect(await dm).toMatchObject({
        sender: { kind: "external", surface: "slack", externalId: "T1:U7" },
        facts: {
          eventId: "1700.1",
          event: "message",
          dm: true,
          channelId: "D-account",
        },
      });
      const mention = next();
      listener.message({
        channel: "C-general",
        user: "U7",
        text: "hey <@U-account>, thoughts?",
        ts: "1700.2",
      });
      expect(await mention).toMatchObject({
        facts: {
          eventId: "1700.2",
          event: "mention",
          dm: false,
          addressees: [{ externalId: "T1:U-account" }],
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
        "1700.3",
        SENTINEL.ts,
      ]);
    });

    it("the account's own messages are never an outside event, in a DM or a channel", async () => {
      const { listener, next, inbound } = await started({}, noopPublish, );
      listener.message({ channel: "D-account", user: "U-account", text: "my own note", ts: "1700.4" });
      listener.message({
        channel: "C-general",
        user: "U-account",
        text: "<@U-account> talking to myself",
        ts: "1700.5",
      });
      await onlySentinel({ listener, next, inbound });
    });

    it("a top-level mention of the Account opens no thread root (the bot's copy carries none); an in-thread message keeps its thread", async () => {
      const { listener, next } = await started({}, noopPublish, );
      const topLevel = next();
      listener.message({ channel: "C-general", user: "U7", text: "<@U-account> look", ts: "1700.6" });
      expect((await topLevel).facts.reply).toBeUndefined();
      const inThread = next();
      listener.message({
        channel: "C-general",
        user: "U7",
        text: "<@U-account> again",
        ts: "1700.7",
        thread_ts: "1700.6",
      });
      expect((await inThread).facts.reply).toEqual({ chain: ["1700.6"], threadId: "1700.6" });
    });

    it("a reaction is not ingress: the router routes a reaction only as the answer to a request", async () => {
      const { listener, next, inbound } = await started({}, noopPublish, );
      listener.reaction({
        user: "U7",
        reaction: "eyes",
        channel: "D-account",
        ts: "1700.8",
        itemUser: "U-account",
      });
      await onlySentinel({ listener, next, inbound });
    });

    it("under `all` everything the account can see is ingress, still never its own echo", async () => {
      const { listener, next, inbound } = await started({}, noopPublish, );
      listener.message({
        channel: "C-general",
        user: "U7",
        text: "unrelated chatter",
        ts: "1700.9",
      });
      listener.message({ channel: "C-general", user: "U-account", text: "mine", ts: "1700.10" });
      const sentinel = next();
      listener.message(SENTINEL);
      await sentinel;
      expect(inbound.map((message) => message.facts.eventId)).toEqual(["1700.9", SENTINEL.ts]);
    });

    it("a frame the listener repeats is handed off once", async () => {
      const { listener, next, inbound } = await started({}, noopPublish, );
      listener.message({ channel: "D-account", user: "U7", text: "once", ts: "1700.12" });
      listener.message({ channel: "D-account", user: "U7", text: "once", ts: "1700.12" });
      const sentinel = next();
      listener.message(SENTINEL);
      await sentinel;
      expect(inbound.map((message) => message.facts.eventId)).toEqual(["1700.12", SENTINEL.ts]);
    });

    it("a refused RTM connect fails start and leaves no listener behind", async () => {
      const refusing = new FakeSlackAccountListener((self) =>
        self.emit(
          "error",
          new SlackAccountError("An API error occurred: invalid_auth", "invalid_auth"),
        ),
      );
      const fake = fakeSlackAccountSdk({}, refusing);
      const adapter = new SlackAccountAdapter(
        CREDENTIALS,
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
        );
      listener.emit(
        "error",
        new SlackAccountError("An API error occurred: account_inactive", "account_inactive"),
      );
      expect(listener.stopped).toBe(1);
      expect(errors).toEqual(["slack rtm dead: An API error occurred: account_inactive"]);
    });

    it("without a bound handler the instance only sends, whatever the posture", async () => {
      const fake = fakeSlackAccountSdk();
      const adapter = new SlackAccountAdapter(
        CREDENTIALS,
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

  it("delivers a letter into the Account's direct channel with the person when no conversation is named", async () => {
    const { adapter, client } = await started();
    const receipt = await adapter.deliver("T1:U7", Outbound.payload("hi there"), "k-1");
    expect(receipt).toEqual({ value: "sent", externalMessageId: "1700.1" });
    expect(client.of("openConversation").map((call) => call.args)).toEqual([["U7"]]);
    expect(client.of("sendMessage").map((call) => call.args)).toEqual([
      [ACCOUNT_DM, "hi there", null],
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

  it("a reaction swaps the Account's earlier emoji for the new one; a state that already holds is success", async () => {
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

  it("the provider's account arm builds delivery and voice beside the text-only bot arm", () => {
    const account = fakeSlackAccountSdk();
    const provider = createSlackProvider(fakeSlackSdk().sdk, account.sdk);
    expect(provider.account?.capabilities).toEqual({
      deliver: true,
      react: true,
      media: false,
      typing: false,
      voice: true,
    });
    expect(provider.account?.credentials.safeParse(CREDENTIALS).success).toBe(true);
    expect(
      provider.account?.credentials.safeParse({ botToken: "xoxb-1", appToken: "xapp-1" }).success,
    ).toBe(false);
    expect(provider.account?.credentials.safeParse({ ...CREDENTIALS, extra: 1 }).success).toBe(false);
    const runtime = provider.account?.create(CREDENTIALS, noopPublish, injectedOptions());
    expect(runtime?.surface.id).toBe("channel:test:main");
    expect(runtime?.deliveryRoute).toBeDefined();
    expect(runtime?.voiceRoute).toBeDefined();
    expect(runtime?.webhookHandler).toBeUndefined();
    expect(runtime?.typingRoute).toBeUndefined();
  });
});

it("#1600: a Slack Account instance names no account before it started", () => {
  const fake = fakeSlackAccountSdk({});
  const adapter = new SlackAccountAdapter(
    CREDENTIALS,
    noopPublish,
    injectedOptions(),
    fake.sdk,
  );
  expect(adapter.account()).toBeUndefined();
});
