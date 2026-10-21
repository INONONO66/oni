import { describe, expect, it } from "bun:test";
import { injectedOptions } from "./helpers/injected";
import { type Channel, type Gateway, Operational, Outbound } from "@oni/protocol";
import { SlackAdapter } from "../src/provider/slack/surface";
import { SlackBotError } from "../src/provider/slack/sdk";
import { SlackEndpointKeyError, SlackHandlerMissingError } from "../src/errors";
import type { PublishPort } from "../src/types";
import { bounded } from "./helpers/bounded";
import {
  DM_CHANNEL,
  FakeSlackListener,
  type FakeSlackScript,
  fakeSlackSdk,
  platformError,
} from "./helpers/slack-sdk";

const noopPublish: PublishPort = () => undefined;
const CREDENTIALS = { botToken: "xoxb-1", appToken: "xapp-1" };

/** One started adapter over the scripted SDK, its inbound promise armed. */
async function started(script: FakeSlackScript = {}, publish: PublishPort = noopPublish) {
  const fake = fakeSlackSdk(script);
  const adapter = new SlackAdapter(CREDENTIALS, {}, publish, injectedOptions(), fake.sdk);
  const inbound: Channel.InboundMessage[] = [];
  const waiters: Array<(message: Channel.InboundMessage) => void> = [];
  const next = () => {
    const waiter = Promise.withResolvers<Channel.InboundMessage>();
    waiters.push(waiter.resolve);
    return bounded(waiter.promise);
  };
  adapter.onMessage(async (message) => {
    inbound.push(message);
    waiters.shift()?.(message);
  });
  await adapter.start("trace-start");
  return { ...fake, adapter, inbound, next };
}

describe("SlackAdapter over the agent-messenger bot SDK", () => {
  it("logs in, pins the inner client to one attempt, builds the listener with the app token, and settles start on the first hello", async () => {
    const { adapter, client, listener, listenerArgs } = await started();
    expect(client.calls.map((call) => call.method)).toEqual(["login", "testAuth"]);
    expect(client.calls[0]?.args).toEqual(["xoxb-1"]);
    expect(client.client).toEqual({ retryConfig: { retries: 0 }, rejectRateLimitedCalls: true });
    expect(listenerArgs()).toEqual({ client, appToken: "xapp-1" });
    expect(listener.started).toBe(1);
    adapter.stop("trace-stop");
    expect(listener.stopped).toBe(1);
  });

  it("refuses to start without a handler", async () => {
    const adapter = new SlackAdapter(
      CREDENTIALS,
      {},
      noopPublish,
      injectedOptions(),
      fakeSlackSdk().sdk,
    );
    await expect(adapter.start("trace-1")).rejects.toBeInstanceOf(SlackHandlerMissingError);
  });

  it("fails start on a socket error before hello and leaves no listener behind", async () => {
    const warned = Promise.withResolvers<void>();
    const listener = new FakeSlackListener(() => {
      listener.emit("error", new SlackBotError("bad app token", "invalid_app_token_type"));
    });
    const fake = fakeSlackSdk({}, listener);
    const adapter = new SlackAdapter(
      CREDENTIALS,
      {},
      (event) => {
        if (event.name === Operational.Events.Warn.name) warned.resolve();
      },
      injectedOptions(),
      fake.sdk,
    );
    adapter.onMessage(async () => undefined);
    await expect(adapter.start("boot")).rejects.toMatchObject({ code: "invalid_app_token_type" });
    await bounded(warned.promise);
    expect(listener.stopped).toBe(1);
  });

  it("fails start when the socket closes before hello, and a later close only reports", async () => {
    const listener = new FakeSlackListener(() => {
      listener.emit("disconnected");
    });
    const fake = fakeSlackSdk({}, listener);
    const adapter = new SlackAdapter(CREDENTIALS, {}, noopPublish, injectedOptions(), fake.sdk);
    adapter.onMessage(async () => undefined);
    await expect(adapter.start("boot")).rejects.toMatchObject({ _tag: "ChannelsFailure" });
    expect(listener.stopped).toBe(1);

    const closes: string[] = [];
    const live = await started({}, (event, data) => {
      if (event.name === Operational.Events.Info.name)
        closes.push(Operational.Events.Info.schema.parse(data).msg);
    });
    live.listener.emit("disconnected");
    expect(closes).toContain("slack socket closed, sdk reconnecting");
    expect(live.listener.stopped).toBe(0);
  });

  it("a terminal disconnect or revoked token after hello is a typed dead surface", async () => {
    const errors: string[] = [];
    const live = await started({}, (event, data) => {
      if (event.name === Operational.Events.Error.name)
        errors.push(Operational.Events.Error.schema.parse(data).msg);
    });
    live.listener.emit("error", new SlackBotError("transient", "slack_webapi_request_error"));
    expect(live.listener.stopped).toBe(0);
    live.listener.emit(
      "error",
      new SlackBotError(
        "Slack closed the Socket Mode session: link_disabled",
        "disconnect_terminal",
      ),
    );
    expect(live.listener.stopped).toBe(1);
    expect(errors).toEqual([
      "slack socket dead: Slack closed the Socket Mode session: link_disabled",
    ]);
  });

  it("a revoked token on a reopen after hello is a typed dead surface, as the web-api forwards it", async () => {
    const errors: string[] = [];
    const live = await started({}, (event, data) => {
      if (event.name === Operational.Events.Error.name)
        errors.push(Operational.Events.Error.schema.parse(data).msg);
    });
    live.listener.emit("disconnected");
    // The seam maps the refused apps.connections.open onto its Slack error code (see slack-sdk.test).
    live.listener.emit(
      "error",
      new SlackBotError("An API error occurred: invalid_auth", "invalid_auth"),
    );
    expect(live.listener.stopped).toBe(1);
    expect(errors).toEqual(["slack socket dead: An API error occurred: invalid_auth"]);
  });

  it("a streak of refused reopens after hello is reported unreachable once while the SDK keeps trying", async () => {
    const errors: string[] = [];
    const live = await started({}, (event, data) => {
      if (event.name === Operational.Events.Error.name)
        errors.push(Operational.Events.Error.schema.parse(data).msg);
    });
    live.listener.emit("disconnected");
    for (let attempt = 0; attempt < 12; attempt += 1)
      live.listener.emit(
        "error",
        new SlackBotError("A request error occurred: ENOTFOUND", "slack_webapi_request_error"),
      );
    expect(live.listener.stopped).toBe(0);
    expect(errors).toEqual(["slack socket unreachable: 10 failures without a reconnect"]);
  });

  /**
   * The ack must precede the handoff, not merely share its emit: the first
   * synchronous act of the handoff is the dedupe claim, which reads the
   * injected clock, so a clock that snapshots the acked list observes order.
   */
  async function startedWithAckSnapshots(publish: PublishPort = noopPublish) {
    const fake = fakeSlackSdk();
    const snapshots: string[][] = [];
    const options = injectedOptions();
    const adapter = new SlackAdapter(
      CREDENTIALS,
      {},
      publish,
      {
        ...options,
        now: () => {
          snapshots.push([...fake.listener.acked]);
          return options.now();
        },
      },
      fake.sdk,
    );
    const inbound: Channel.InboundMessage[] = [];
    const arrived = Promise.withResolvers<Channel.InboundMessage>();
    adapter.onMessage(async (message) => {
      inbound.push(message);
      arrived.resolve(message);
    });
    await adapter.start("trace-start");
    snapshots.length = 0;
    return { ...fake, adapter, inbound, snapshots, arrived: bounded(arrived.promise) };
  }

  it("acks an envelope before handing a channel message over as ingress facts", async () => {
    const { listener, snapshots, arrived } = await startedWithAckSnapshots();
    listener.eventsApi("env-1", {
      type: "message",
      channel: "C123",
      channel_type: "channel",
      user: "U77",
      text: "<@UBOT> tracking number",
      ts: "1710.0002",
      thread_ts: "1710.0001",
    });
    expect(listener.acked).toEqual(["env-1"]);
    // The dedupe claim (first act of the handoff) already saw the ack.
    expect(snapshots[0]).toEqual(["env-1"]);
    expect(await arrived).toMatchObject({
      sender: { externalId: "T9:U77" },
      facts: { workspaceId: "T9", channelId: "C123", reply: { chain: ["1710.0001"] } },
    });
  });

  it("acks an event type it does not consume, or cannot parse, without handing it over", async () => {
    const { listener, inbound } = await started();
    listener.eventsApi("env-join", { type: "member_joined_channel", channel: "C1", user: "U1" });
    // Shapes the facts schema refuses still get their ack: Slack redelivers unacked envelopes forever.
    listener.eventsApi("env-shape", { type: "channel_created", channel: { id: "C9", name: "x" } });
    listener.eventsApi("env-ts", { type: "message", channel: "C1", user: "U1", text: "x", ts: 12 });
    listener.eventsApi("env-2", {
      type: "message",
      channel: "C1",
      user: "U1",
      text: "x",
      ts: "2.0",
    });
    await bounded(Promise.resolve());
    expect(listener.acked).toEqual(["env-join", "env-shape", "env-ts", "env-2"]);
    expect(inbound.map((message) => message.facts.eventId)).toEqual(["2.0"]);
  });

  it("acks a slash command and ignores a bare envelope without an ack", async () => {
    const { listener, inbound } = await started();
    listener.slashCommand("env-slash", { command: "/omni", text: "status" });
    listener.bareEnvelope({ type: "unknown", envelope_id: "e-raw" });
    await bounded(Promise.resolve());
    expect(listener.acked).toEqual(["env-slash"]);
    expect(inbound).toHaveLength(0);
  });

  it("acks a malformed or non-block_actions interactive envelope and warn-drops it", async () => {
    const warns: string[] = [];
    const { listener, inbound } = await started({}, (event, data) => {
      if (event.name === Operational.Events.Warn.name)
        warns.push(Operational.Events.Warn.schema.parse(data).msg);
    });
    listener.interactive("env-bad", { type: "view_submission" });
    listener.interactive("env-shape", {
      type: "block_actions",
      user: "x",
      channel: [],
      actions: {},
    });
    await bounded(Promise.resolve());
    expect(listener.acked).toEqual(["env-bad", "env-shape"]);
    expect(inbound).toHaveLength(0);
    expect(warns).toEqual([
      "slack interactive payload not a block action; dropped",
      "slack interactive payload not a block action; dropped",
    ]);
  });

  it("routes an interactive button tap through the inbound handler, acked first", async () => {
    const { listener, snapshots, arrived } = await startedWithAckSnapshots();
    listener.interactive("button-env", {
      type: "block_actions",
      user: { id: "U77" },
      channel: { id: "D123" },
      actions: [{ action_id: "approve", action_ts: "12.34", text: { text: "Approve" } }],
      container: { message_ts: "10.00" },
    });
    expect(listener.acked).toEqual(["button-env"]);
    expect(snapshots[0]).toEqual(["button-env"]);
    expect(await arrived).toMatchObject({
      sender: { externalId: "T9:U77" },
      facts: {
        event: "postback",
        render: "Approve",
        postback: { id: "approve", label: "Approve", messageRef: "10.00" },
        addressees: [{ externalId: "T9:UBOT" }],
        dm: true,
      },
    });
  });

  const threadCases: Array<{
    name: string;
    script: FakeSlackScript;
    ts: string;
    thread_ts: string;
    fetched: boolean;
    context: Gateway.IngressFacts["context"];
  }> = [
    {
      name: "an in-thread message carries the thread's earlier messages, the bot's own as assistant",
      script: {
        threadReplies: async () => [
          { ts: "1710.0001", user: "U77", text: "deploy is red" },
          { ts: "1710.0002", user: "UBOT", text: "looking" },
          { ts: "1710.0003", user: "U77", text: "" },
          { ts: "1710.0004", username: "ci", text: "build green" },
          { ts: "1710.0006", user: "U78", text: "later, not seen yet" },
        ],
      },
      ts: "1710.0005",
      thread_ts: "1710.0001",
      fetched: true,
      context: {
        thread: [
          { author: "<@U77>", text: "deploy is red" },
          { author: "assistant", text: "looking" },
          { author: "bot ci", text: "build green" },
        ],
      },
    },
    {
      name: "a thread root is not fetched",
      script: { threadReplies: async () => [{ ts: "1710.0001", user: "U77", text: "x" }] },
      ts: "1710.0001",
      thread_ts: "1710.0001",
      fetched: false,
      context: undefined,
    },
    {
      name: "a failing history call still delivers the message, without history",
      script: { fail: { getThreadReplies: () => platformError("missing_scope") } },
      ts: "1710.0005",
      thread_ts: "1710.0001",
      fetched: true,
      context: undefined,
    },
  ];
  it.each(threadCases)("$name (#1490)", async ({ script, ts, thread_ts, fetched, context }) => {
    const { client, listener, next } = await started(script);
    const facts = next();
    listener.eventsApi("env-thread", {
      type: "message",
      channel: "C123",
      channel_type: "channel",
      user: "U77",
      text: "still red?",
      ts,
      thread_ts,
    });
    const message = await facts;
    expect(message.facts.context).toEqual(context);
    expect(message.facts.render).toBe("still red?");
    expect(
      client.calls.filter((call) => call.method === "getThreadReplies").map((call) => call.args),
    ).toEqual(fetched ? [["C123", thread_ts, { limit: 21 }]] : []);
  });

  it("releases failed ingress for platform redelivery", async () => {
    const failed = Promise.withResolvers<void>();
    const retried = Promise.withResolvers<void>();
    let attempts = 0;
    const fake = fakeSlackSdk();
    const adapter = new SlackAdapter(
      CREDENTIALS,
      {},
      (event) => {
        if (event.name === Operational.Events.Error.name) failed.resolve();
      },
      injectedOptions(),
      fake.sdk,
    );
    adapter.onMessage(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("delivery refused");
      retried.resolve();
    });
    await adapter.start("boot");
    const event = {
      type: "message",
      channel: "C123",
      channel_type: "channel",
      user: "U77",
      text: "hello",
      ts: "1.2",
    };
    fake.listener.eventsApi("retry", event);
    await bounded(failed.promise);
    fake.listener.eventsApi("retry", event);
    await bounded(retried.promise);
    expect(attempts).toBe(2);
    expect(fake.listener.acked).toEqual(["retry", "retry"]);
  });

  it("drops a duplicate envelope after a successful handoff", async () => {
    const { listener, inbound } = await started();
    const event = { type: "message", channel: "C123", user: "U77", text: "once", ts: "7.7" };
    listener.eventsApi("dup-1", event);
    await bounded(Promise.resolve());
    listener.eventsApi("dup-2", event);
    await bounded(Promise.resolve());
    expect(inbound).toHaveLength(1);
    expect(listener.acked).toEqual(["dup-1", "dup-2"]);
  });

  it("opens the bot's direct channel for a conversation-less delivery and rejects an unscoped endpoint before any call", async () => {
    const fake = fakeSlackSdk();
    const adapter = new SlackAdapter(CREDENTIALS, {}, noopPublish, injectedOptions(), fake.sdk);
    expect(await adapter.deliver("T9:U5", Outbound.payload("direct note"), "message-1")).toEqual({
      value: "sent",
      externalMessageId: "999.1",
    });
    expect(fake.client.calls).toEqual([
      { method: "openDm", args: ["U5"] },
      { method: "postMessage", args: [DM_CHANNEL, "direct note", {}] },
    ]);
    await expect(
      adapter.deliver("U5", Outbound.payload("no workspace"), "message-2"),
    ).rejects.toBeInstanceOf(SlackEndpointKeyError);
    expect(fake.client.calls).toHaveLength(2);
  });

  it("a refused direct-channel open is a proven not_sent that permits another attempt", async () => {
    let opens = 0;
    const fake = fakeSlackSdk({
      fail: {
        openDm: () => {
          opens += 1;
          return platformError(opens === 1 ? "user_not_found" : "never");
        },
      },
    });
    const adapter = new SlackAdapter(CREDENTIALS, {}, noopPublish, injectedOptions(), fake.sdk);
    expect(await adapter.deliver("T9:U5", Outbound.payload("hi"), "dm-key")).toEqual({
      value: "not_sent",
    });
    expect(fake.client.of("postMessage")).toHaveLength(0);
    await adapter.deliver("T9:U5", Outbound.payload("hi"), "dm-key");
    expect(fake.client.of("openDm")).toHaveLength(2);
  });

  it("posts into the conversation's thread instead of a DM (#1490)", async () => {
    const fake = fakeSlackSdk();
    const adapter = new SlackAdapter(CREDENTIALS, {}, noopPublish, injectedOptions(), fake.sdk);
    const receipt = await adapter.deliver("T9:U5", Outbound.payload("in thread"), "message-3", {
      channelId: "C123",
      replyToMessageId: "1710.0002",
    });
    expect(receipt).toEqual({ value: "sent", externalMessageId: "999.1" });
    expect(fake.client.calls).toEqual([
      { method: "postMessage", args: ["C123", "in thread", { thread_ts: "1710.0002" }] },
    ]);
  });

  const failureCases: Array<{ name: string; error: () => Error; value: "not_sent" | "unknown" }> = [
    {
      name: "a platform refusal is not_sent",
      error: () => platformError("channel_not_found"),
      value: "not_sent",
    },
    {
      name: "a typed rate-limit refusal is not_sent",
      error: () => new SlackBotError("rate limited", "slack_webapi_rate_limited_error", 3),
      value: "not_sent",
    },
    {
      name: "a refused connection is not_sent",
      error: () =>
        new SlackBotError(
          "A request error occurred: connect ECONNREFUSED 1.2.3.4:443",
          "slack_webapi_request_error",
        ),
      value: "not_sent",
    },
    {
      name: "a reset connection is unknown",
      error: () =>
        new SlackBotError("A request error occurred: socket hang up", "slack_webapi_request_error"),
      value: "unknown",
    },
    {
      name: "a non-200 http answer is unknown",
      error: () =>
        new SlackBotError(
          "An HTTP protocol error occurred: statusCode = 502",
          "slack_webapi_http_error",
        ),
      value: "unknown",
    },
    { name: "an untyped failure is unknown", error: () => new Error("boom"), value: "unknown" },
    {
      name: "an SDK code raised after the request is unknown",
      error: () => new SlackBotError("Cannot read properties of undefined", "unknown_error"),
      value: "unknown",
    },
  ];
  it.each(failureCases)("$name", async ({ error, value }) => {
    const fake = fakeSlackSdk({ fail: { postMessage: error } });
    const adapter = new SlackAdapter(CREDENTIALS, {}, noopPublish, injectedOptions(), fake.sdk);
    expect(await adapter.deliver("T9:U5", Outbound.payload("hi"), `key-${value}`)).toEqual({
      value,
    });
  });

  type ChunkOutcome = "accepted" | "missing" | "forbidden" | "network";
  const chunkCases: Array<{
    name: string;
    outcomes: ChunkOutcome[];
    value: "sent" | "not_sent" | "unknown";
    acceptedChunks: { index: number; externalMessageId: string }[];
    reason?: "missing_receipt" | "send_failed";
  }> = [
    { name: "accepted", outcomes: ["accepted", "accepted"], value: "sent", acceptedChunks: [] },
    {
      name: "missing-first",
      outcomes: ["missing", "accepted"],
      value: "unknown",
      acceptedChunks: [{ index: 2, externalMessageId: "chunk-2" }],
      reason: "missing_receipt",
    },
    {
      name: "missing-final",
      outcomes: ["accepted", "missing"],
      value: "unknown",
      acceptedChunks: [{ index: 1, externalMessageId: "chunk-1" }],
      reason: "missing_receipt",
    },
    { name: "all-missing", outcomes: ["missing", "missing"], value: "unknown", acceptedChunks: [] },
    {
      name: "first-forbidden",
      outcomes: ["forbidden", "accepted"],
      value: "not_sent",
      acceptedChunks: [],
    },
    {
      name: "partial-forbidden",
      outcomes: ["accepted", "forbidden", "accepted"],
      value: "unknown",
      acceptedChunks: [{ index: 1, externalMessageId: "chunk-1" }],
      reason: "send_failed",
    },
    {
      name: "partial-network",
      outcomes: ["accepted", "network"],
      value: "unknown",
      acceptedChunks: [{ index: 1, externalMessageId: "chunk-1" }],
      reason: "send_failed",
    },
    {
      name: "network-first",
      outcomes: ["network", "accepted"],
      value: "unknown",
      acceptedChunks: [],
    },
  ];
  it.each(
    chunkCases,
  )("a multi-chunk letter preserves $name chunk evidence through the SDK", async ({
    outcomes,
    value,
    acceptedChunks,
    reason,
  }) => {
    const partial: object[] = [];
    const publish: PublishPort = (event, data) => {
      if (event.name !== Operational.Events.Warn.name) return;
      const warning = Operational.Events.Warn.schema.parse(data);
      if (warning.context?.delivery === "partial") partial.push(warning.context);
    };
    const fake = fakeSlackSdk({
      post: (call) => {
        const outcome = outcomes[call - 1];
        if (outcome === "forbidden") return platformError("not_in_channel");
        if (outcome === "network")
          return new SlackBotError(
            "A request error occurred: read ECONNRESET",
            "slack_webapi_request_error",
          );
        if (outcome === "missing") return {};
        if (outcome !== "accepted") return new Error("unexpected extra physical send");
        return { ts: `chunk-${call}` };
      },
    });
    const adapter = new SlackAdapter(CREDENTIALS, {}, publish, injectedOptions(), fake.sdk);
    const content = "X".repeat(4000 * (outcomes.length - 1) + 1);
    const receipt = await adapter.deliver("T9:U5", Outbound.payload(content), "chunked");
    const failureIndex = outcomes.findIndex(
      (outcome) => outcome !== "accepted" && outcome !== "missing",
    );
    const expectedChunks = failureIndex === -1 ? outcomes.length : failureIndex + 1;
    expect(fake.client.of("postMessage")).toHaveLength(expectedChunks);
    expect(receipt).toEqual(value === "sent" ? { value, externalMessageId: "chunk-2" } : { value });
    expect(partial).toEqual(
      reason === undefined
        ? []
        : [
            {
              delivery: "partial",
              idempotencyKey: "chunked",
              acceptedChunks,
              attemptedChunks: expectedChunks,
              totalChunks: outcomes.length,
              reason,
            },
          ],
    );
    // Custody: only a proven not_sent permits another physical attempt under the same key.
    const again = await adapter.deliver("T9:U5", Outbound.payload(content), "chunked");
    if (value === "not_sent") {
      expect(fake.client.of("postMessage").length).toBeGreaterThan(expectedChunks);
    } else {
      expect(again).toEqual(receipt);
      expect(fake.client.of("postMessage")).toHaveLength(expectedChunks);
    }
  });

  it("resends under the same key only after a proven not_sent", async () => {
    let attempt = 0;
    const fake = fakeSlackSdk({
      fail: {
        postMessage: () => {
          attempt += 1;
          return attempt === 1 ? platformError("ratelimited") : new Error("never thrown");
        },
      },
    });
    const adapter = new SlackAdapter(CREDENTIALS, {}, noopPublish, injectedOptions(), fake.sdk);
    expect(await adapter.deliver("T9:U5", Outbound.payload("hi"), "same-key")).toEqual({
      value: "not_sent",
    });
    expect(await adapter.deliver("T9:U5", Outbound.payload("hi"), "same-key")).toEqual({
      value: "unknown",
    });
    expect(fake.client.of("postMessage")).toHaveLength(2);
  });
});
