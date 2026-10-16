import { describe, expect, it } from "bun:test";
import { Operational, Outbound } from "@openomni/protocol";
import { DeliveryNotSent, SlackEndpointKeyError } from "../src/errors";
import { SlackOwnerError } from "../src/provider/slack/owner-sdk";
import { SlackOwnerAdapter } from "../src/provider/slack/owner";
import { createSlackProvider } from "../src/provider/slack/provider";
import type { PublishPort } from "../src/types";
import { injectedOptions } from "./helpers/injected";
import { fakeSlackSdk } from "./helpers/slack-sdk";
import { fakeSlackOwnerSdk, OWNER_DM, type OwnerScript } from "./helpers/slack-owner-sdk";

const noopPublish: PublishPort = () => undefined;
const CREDENTIALS = { token: "xoxc-1", cookie: "d-cookie" };

/** One started Owner instance over the scripted user SDK. */
async function started(script: OwnerScript = {}, publish: PublishPort = noopPublish) {
  const fake = fakeSlackOwnerSdk(script);
  const adapter = new SlackOwnerAdapter(CREDENTIALS, {}, publish, injectedOptions(), fake.sdk);
  await adapter.start("boot");
  return { ...fake, adapter };
}

/** The user SDK's refusal shapes: a forwarded web-api code, or its own `ok:false` check naming the Slack error. */
const webApi = (message: string, code: string) => new SlackOwnerError(message, code);

describe("SlackOwnerAdapter: the Owner's own account as the slack:owner instance (#1569)", () => {
  it("logs in with the account session, pins the inner client to one attempt, and verifies the identity before it counts as started", async () => {
    const infos: Pick<ReturnType<typeof Operational.Events.Info.schema.parse>, "msg" | "context">[] = [];
    const { adapter, client } = await started({}, (event, data) => {
      if (event.name !== Operational.Events.Info.name) return;
      const { msg, context } = Operational.Events.Info.schema.parse(data);
      infos.push(context === undefined ? { msg } : { msg, context });
    });
    expect(adapter.id).toBe("slack:owner");
    expect(client.calls.map((call) => call.method)).toEqual(["login", "testAuth"]);
    expect(client.calls[0]?.args).toEqual(["xoxc-1", "d-cookie"]);
    expect(client.client).toEqual({ retryConfig: { retries: 0 }, rejectRateLimitedCalls: true });
    expect(infos).toEqual([
      { msg: "slack owner instance started", context: { userId: "U-owner", team: "T1", listener: "none" } },
    ]);
    adapter.stop("stop");
    expect(infos.at(-1)?.msg).toBe("slack owner instance stopped");
  });

  it("a refused login fails start, so the instance never counts as mounted", async () => {
    const fake = fakeSlackOwnerSdk({ login: webApi("Cookie is required", "missing_cookie") });
    const adapter = new SlackOwnerAdapter(CREDENTIALS, {}, noopPublish, injectedOptions(), fake.sdk);
    await expect(adapter.start("boot")).rejects.toMatchObject({ code: "missing_cookie" });
  });

  it("refuses a bare user id: the endpoint key is workspace-mandatory", async () => {
    const { adapter } = await started();
    await expect(adapter.deliver("U7", Outbound.payload("hi"), "k-1")).rejects.toBeInstanceOf(
      SlackEndpointKeyError,
    );
  });

  it("refuses an endpoint of another workspace: the account session is one workspace's, and nothing is attempted", async () => {
    const { adapter, client } = await started();
    await expect(adapter.deliver("T2:U7", Outbound.payload("hi"), "k-1")).rejects.toBeInstanceOf(DeliveryNotSent);
    expect(client.of("openConversation")).toEqual([]);
    expect(client.of("sendMessage")).toEqual([]);
  });

  it("delivers a letter into the Owner's direct channel with the person when no conversation is named", async () => {
    const { adapter, client } = await started();
    const receipt = await adapter.deliver("T1:U7", Outbound.payload("hi there"), "k-1");
    expect(receipt).toEqual({ value: "sent", externalMessageId: "1700.1" });
    expect(client.of("openConversation").map((call) => call.args)).toEqual([["U7"]]);
    expect(client.of("sendMessage").map((call) => call.args)).toEqual([[OWNER_DM, "hi there", null]]);
  });

  it("delivers into the conversation the person wrote in, threading under their message", async () => {
    const { adapter, client } = await started();
    await adapter.deliver("T1:U7", Outbound.payload("in thread"), "k-2", {
      channelId: "C1",
      replyToMessageId: "1690.5",
    });
    expect(client.of("openConversation")).toEqual([]);
    expect(client.of("sendMessage").map((call) => call.args)).toEqual([["C1", "in thread", "1690.5"]]);
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
    expect(client.of("removeReaction").map((call) => call.args)).toEqual([["C1", "1690.5", "eyes"]]);
    expect(client.of("addReaction").map((call) => call.args)).toEqual([["C1", "1690.5", "white_check_mark"]]);
  });

  it.each([
    ["a refused open", { openConversation: webApi("An API error occurred: user_not_found", "slack_webapi_platform_error") }, "not_sent"],
    ["a platform refusal the SDK checked itself", { sendMessage: webApi("channel_not_found", "channel_not_found") }, "not_sent"],
    ["a forwarded platform refusal", { sendMessage: webApi("An API error occurred: not_in_channel", "slack_webapi_platform_error") }, "not_sent"],
    ["a rate limit after the SDK's bounded retries", { sendMessage: webApi("rate limited", "slack_webapi_rate_limited_error") }, "not_sent"],
    ["a connection never established", { sendMessage: webApi("A request error occurred: getaddrinfo ENOTFOUND slack.com", "slack_webapi_request_error") }, "not_sent"],
    ["an http error after the request left", { sendMessage: webApi("An HTTP protocol error occurred: statusCode = 503", "slack_webapi_http_error") }, "unknown"],
    ["a reset mid-request", { sendMessage: webApi("A request error occurred: read ECONNRESET", "slack_webapi_request_error") }, "unknown"],
    ["the SDK's wrapper for an uncoded throw", { sendMessage: webApi("Cannot read properties of undefined", "unknown_error") }, "unknown"],
  ] as const)("%s is proven %s", async (_name, script, value) => {
    const { adapter } = await started(script);
    // The open is reached only when no conversation names the channel.
    const conversation = "openConversation" in script ? undefined : { channelId: "C1" };
    const receipt = await adapter.deliver("T1:U7", Outbound.payload("hi"), "k-5", conversation);
    expect(receipt.value).toBe(value);
  });

  it("the provider's owner arm builds the same instance with delivery only, beside the bot arm", () => {
    const owner = fakeSlackOwnerSdk();
    const provider = createSlackProvider(fakeSlackSdk().sdk, owner.sdk);
    expect(provider.owner?.capabilities).toEqual({ deliver: true, react: true, media: false, typing: false });
    expect(provider.owner?.credentials.safeParse(CREDENTIALS).success).toBe(true);
    expect(provider.owner?.credentials.safeParse({ botToken: "xoxb-1", appToken: "xapp-1" }).success).toBe(false);
    expect(provider.owner?.credentials.safeParse({ ...CREDENTIALS, extra: 1 }).success).toBe(false);
    const runtime = provider.owner?.create(CREDENTIALS, {}, noopPublish, injectedOptions());
    expect(runtime?.surface.id).toBe("slack:owner");
    expect(runtime?.deliveryRoute).toBeDefined();
    expect(runtime?.webhookHandler).toBeUndefined();
    expect(runtime?.typingRoute).toBeUndefined();
  });
});
