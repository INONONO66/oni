import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { Effect } from "effect";
import type { Core } from "@openomni/agent";
import { createSurfaceKeyStore, decodeChannelFailure, type GatewayRouter } from "@openomni/channels";
import { Channel, type Gateway, Outbound } from "@openomni/protocol";
import { commitReceivedMessage } from "../../../packages/agent/test/helpers/ingress";
import { createSendMessageTool } from "../src/bundles/messaging/send-message/index";
import { prepareMessage } from "../src/composition/message-session";
import { createResidentGateway } from "../src/gateway";
import { assistantMessage } from "./helpers/assistant-message";
import { residentGatewayPorts } from "./helpers/gateway-ports";
import { localDelivery } from "./helpers/ledger";
import { messageFixture } from "./helpers/message-fixture";
import { residentRunner } from "./helpers/resident-runner";
import { runEffect, runSyncEffect } from "./helpers/scoped-effect";
import { testIds } from "./helpers/test-entropy";

/**
 * The reply door through the real app gateway (#1569): `prepareMessage`
 * folds the conversation binding from the named prompt's recorded origin,
 * the router verifies that the sender is the session it routed the prompt
 * to, the compiled `message.resident.reply_unbound` row denies anything
 * else, and the delivery lands in the channel the person wrote in.
 */

const SLACK_KEY = Channel.SurfaceKey.fromChannel({
  surface: "slack",
  namespace: "T1",
  kind: "channel",
  id: "C1",
});
const PROMPT_ID = "slack::T1:U1:1";
const REPLY: Gateway.SendMessage = {
  to: { kind: "origin", inReplyTo: PROMPT_ID },
  type: "message",
  content: "pong",
};

interface Delivered {
  readonly externalId: string;
  readonly body: string;
  readonly conversation: Gateway.Conversation | undefined;
}

type Conversation = { channelId: string; messageId: string; dm: boolean; workspaceId?: string; threadId?: string };
const CHANNEL: Conversation = { channelId: "C1", messageId: "1710.0002", dm: false, workspaceId: "T1" };

function slackRoute(delivered: Delivered[]) {
  return new Map([
    [
      "slack",
      async (externalId: string, payload: Outbound.Payload, _idempotencyKey: string, conversation?: Gateway.Conversation) => {
        delivered.push({ externalId, body: Outbound.text(payload), conversation });
        return { value: "accepted" as const };
      },
    ],
  ]);
}

function fixtureWithSlack(role: "resident" | "child" = "resident") {
  const delivered: Delivered[] = [];
  const fixture = messageFixture(role, { deliveryRoutes: slackRoute(delivered), grants: () => [] });
  return { fixture, delivered };
}

/** The origin the perimeter records for a channel prompt (`router/message-execution.ts`); `receivedBy` names the instance that observed it (#1600 lane R2). */
function slackOrigin(conversation: Conversation, receivedBy?: "bot" | "owner") {
  return {
    encodingVersion: 1 as const,
    value: {
      kind: "external",
      inboundTreatment: "full_access",
      messageId: PROMPT_ID,
      surface: "slack",
      externalId: "T1:U1",
      actorId: "person:owner",
      ...(receivedBy === undefined ? {} : { receivedBy }),
      conversation,
    },
  };
}

/**
 * The channel prompt the turn answers, committed inside the running turn
 * (riding the live owner and fence, like the fixture's other mid-turn
 * arrivals) so the reply that follows names a prompt this session's own
 * ledger holds.
 */
function promptFromSlack(
  fixture: ReturnType<typeof messageFixture>,
  conversation: Conversation = CHANNEL,
  receivedBy?: "bot" | "owner",
): Effect.Effect<void> {
  return commitReceivedMessage(fixture.plane.openKernel(fixture.sessionId), {
    id: PROMPT_ID,
    sessionId: fixture.sessionId,
    kind: "prompt",
    content: "ping",
    createdAt: 100,
    parentActionId: null,
    origin: slackOrigin(conversation, receivedBy),
  }).pipe(Effect.asVoid, Effect.orDie);
}

test("the reply door answers the conversation the prompt came from, bound by the surface key the session owns", async () => {
  const { fixture, delivered } = fixtureWithSlack();
  try {
    createSurfaceKeyStore(fixture.plane.channel).claim(SLACK_KEY, fixture.sessionId);
    const answered = await fixture.send(REPLY, promptFromSlack(fixture));
    expect(answered.isError).not.toBe(true);
    expect(answered.content).toContain('"status":"executed"');
    expect(delivered).toEqual([
      { externalId: "T1:U1", body: "pong", conversation: { channelId: "C1", replyToMessageId: "1710.0002" } },
    ]);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test.each<[string, Conversation, "dm" | "channel", Gateway.Conversation]>([
  ["a DM, answered in its chat, unthreaded and unquoted", { channelId: "D1", messageId: "1710.0003", dm: true, workspaceId: "T1" }, "dm", { channelId: "D1" }],
  [
    "a thread, answered in the thread",
    { ...CHANNEL, threadId: "1710.0001" },
    "channel",
    { channelId: "C1", threadId: "1710.0001", replyToMessageId: "1710.0002" },
  ],
])("%s: the binding folds the key the inbound claimed", async (_name, conversation, kind, expected) => {
  const { fixture, delivered } = fixtureWithSlack();
  try {
    const key = Channel.SurfaceKey.fromChannel({
      surface: "slack",
      namespace: "T1",
      kind,
      id: conversation.channelId,
      ...(conversation.threadId === undefined ? {} : { threadId: conversation.threadId }),
    });
    createSurfaceKeyStore(fixture.plane.channel).claim(key, fixture.sessionId);
    const answered = await fixture.send(REPLY, promptFromSlack(fixture, conversation));
    expect(answered.isError).not.toBe(true);
    expect(delivered).toEqual([{ externalId: "T1:U1", body: "pong", conversation: expected }]);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("#1600 lane R2: a DM the Owner's account received is the Owner's to answer — the app's origin fold carries `receivedBy`, and the reply is a draft, never the bot's send", async () => {
  const { fixture, delivered } = fixtureWithSlack();
  try {
    const dm: Conversation = { channelId: "D1", messageId: "1710.0003", dm: true, workspaceId: "T1" };
    createSurfaceKeyStore(fixture.plane.channel).claim(
      Channel.SurfaceKey.fromChannel({ surface: "slack", namespace: "T1", kind: "dm", id: "D1" }),
      fixture.sessionId,
    );
    const drafted = await fixture.send(REPLY, promptFromSlack(fixture, dm, "owner"));
    expect(drafted.isError).toBe(true);
    expect(drafted.content).toContain("message.resident.reply_draft");
    expect(delivered).toEqual([]);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("a prompt this session never received binds nothing: refused as reply_unbound before transport", async () => {
  const { fixture, delivered } = fixtureWithSlack();
  try {
    createSurfaceKeyStore(fixture.plane.channel).claim(SLACK_KEY, fixture.sessionId);
    const refused = await fixture.send({ ...REPLY, to: { kind: "origin", inReplyTo: "never-delivered" } });
    expect(refused.isError).toBe(true);
    expect(refused.content).toContain("message.resident.reply_unbound");
    expect(delivered).toEqual([]);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("a conversation another session owns is refused as reply_unbound even though the prompt is recorded here", async () => {
  const { fixture, delivered } = fixtureWithSlack();
  try {
    createSurfaceKeyStore(fixture.plane.channel).claim(SLACK_KEY, "someone-else");
    const refused = await fixture.send(REPLY, promptFromSlack(fixture));
    expect(refused.isError).toBe(true);
    expect(refused.content).toContain("message.resident.reply_unbound");
    expect(delivered).toEqual([]);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("a child has no reply door", async () => {
  const { fixture, delivered } = fixtureWithSlack("child");
  try {
    createSurfaceKeyStore(fixture.plane.channel).claim(SLACK_KEY, fixture.sessionId);
    const refused = await fixture.send(REPLY, promptFromSlack(fixture));
    expect(refused.isError).toBe(true);
    expect(refused.content).toContain("message.child.reply");
    expect(delivered).toEqual([]);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("the model-facing send_message tool cannot compose an origin target", () => {
  const tool = createSendMessageTool(undefined, () => 0);
  expect(tool.input.safeParse({ to: { kind: "origin", inReplyTo: PROMPT_ID }, message: "pong" }).success).toBe(false);
});

/**
 * End to end: the Resident's own turn, the composed gateway, the app's
 * binding fold and the channel route. The reply leaves the resident bundle
 * outside any tool body, so this is the receipt that it runs under the
 * turn's executor the gateway's session `run` port requires.
 */
test("the resident's reply reaches the channel through the real gateway, under the turn's executor", async () => {
  const delivered: Delivered[] = [];
  const sessionId = "reply-door-e2e";
  let gateway: GatewayRouter | undefined;
  const resident = residentRunner({
    model: { provider: "fake", id: "reply-door-e2e" },
    apiKey: "test-key",
    tools: {
      messages: {
        ingest: (...args) => {
          if (gateway === undefined) throw new Error("gateway is not composed yet");
          return runEffect(gateway.ingest(...args));
        },
      },
    },
    sessionRuntime: { clock: () => 10 },
    llm: {
      resolveModel: (model: { readonly id: string; readonly provider: string }) =>
        Effect.succeed({ id: model.id, name: model.id, providerID: model.provider }),
      run: (input: Core.RunInput, sink: Core.LlmSink) => Effect.sync(() => {
        sink.onMessage(assistantMessage(input, { text: "pong" }));
        return { type: "stop" as const };
      }),
    },
  });
  gateway = runSyncEffect(Effect.gen(function* () {
    return yield* createResidentGateway({
      now: () => 10,
      id: testIds("reply-door-e2e"),
      delivery: {
        commit: (input) =>
          localDelivery(resident.plane, "reply-door-e2e", () => 10)(input).pipe(
            Effect.mapError(decodeChannelFailure("delivery.commit")),
          ),
      },
      prepare: prepareMessage(resident.plane, resident.genesis),
      ...(yield* residentGatewayPorts(resident.plane, () => 10)),
    }, { deliveryRoutes: slackRoute(delivered), grants: () => [] });
  }).pipe(Effect.provide(resident.services)));
  createSurfaceKeyStore(resident.plane.channel).claim(SLACK_KEY, sessionId);
  await runEffect(localDelivery(resident.plane, "reply-door-e2e", () => 10)({
    id: PROMPT_ID,
    sessionId,
    kind: "prompt",
    content: "ping",
    origin: slackOrigin(CHANNEL),
    createdAt: 10,
    parentActionId: null,
    createSession: resident.genesis(sessionId, null, "resident", "resident"),
  }));
  const result = await resident.drain(sessionId);
  expect(result?.kind).toBe("result");
  expect(delivered).toEqual([
    { externalId: "T1:U1", body: "pong", conversation: { channelId: "C1", replyToMessageId: "1710.0002" } },
  ]);
});
