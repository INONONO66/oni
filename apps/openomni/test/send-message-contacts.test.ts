/**
 * #1258 send-message contacts: one `send_message` tool reaches every contact
 * kind — session/new_session on the gateway ingest door, telegram/discord/
 * human/CLI through the connector registry — plus the composition-root
 * bindings a unit fixture would hide (#1254 lesson): both bundles bound at
 * boot, the first-prompt deliver's idempotency replay, and the `action`-off
 * cascade that takes delegation-policy with it.
 */
import { expect, test } from "bun:test";
import { Bundle, Core } from "@openomni/agent";
import type { Gateway } from "@openomni/protocol";
import { Effect } from "effect";
import { appManifest } from "../src/manifest";
import { alarmDefinition } from "./helpers/alarm-definition";
import {
  channelConnector,
  cliConnector,
  createSendMessageTool,
  humanConnector,
  parseContactAddress,
  type ContactPorts,
  type MessagePort,
} from "../src/bundles/messaging/send-message/index";
import { assistantMessage } from "./helpers/assistant-message";
import { runEffect } from "./helpers/effect";
import { runAppEffect } from "../src/gateway";
import { localDelivery, planeOf } from "./helpers/ledger";
import { ownerStart } from "./helpers/owner-start";
import { nextResidentTurn } from "./helpers/resident-turn";
import { fakeProviderModel, residentSuite } from "./helpers/resident-suite";

const SessionEntity = Core.SessionEntity;
const suite = residentSuite();

const context = {
  sessionId: "sender",
  turnId: "turn-1",
  callId: "call-1",
  signal: new AbortController().signal,
} as const;

test("contact addresses parse per kind; unknown kinds and unknown CLI agents are no address", () => {
  expect(parseContactAddress("telegram:12345")).toEqual({ kind: "telegram", id: "12345" });
  expect(parseContactAddress("discord:chan-9")).toEqual({ kind: "discord", id: "chan-9" });
  expect(parseContactAddress("human:owner")).toEqual({ kind: "human", id: "owner" });
  expect(parseContactAddress("cli:claude-code")).toEqual({ kind: "cli", id: "claude-code" });
  expect(parseContactAddress("cli:vim")).toBeUndefined();
  expect(parseContactAddress("slack:general")).toBeUndefined();
  expect(parseContactAddress("owner")).toBeUndefined();
  expect(parseContactAddress("telegram:")).toBeUndefined();
});

test("channel and human connectors: delivered on egress, journaled not_sent on refusal or missing door", async () => {
  const sent: object[] = [];
  const egress = {
    send: (input: object) => Effect.sync(() => void sent.push(input)),
  };
  const send = {
    sender: "sender",
    address: { kind: "telegram", id: "12345" } as const,
    message: "hello",
    replyTo: "m-1",
  };
  expect(await runEffect(channelConnector("telegram", egress)(send))).toEqual({
    contact: "telegram:12345",
    status: "delivered",
  });
  expect(sent).toEqual([{ surface: "telegram", chatId: "12345", text: "hello", replyTo: "m-1" }]);
  const refusing = { send: () => Effect.fail({ reason: "grant revoked" }) };
  expect(await runEffect(channelConnector("discord", refusing)(send))).toEqual({
    contact: "telegram:12345",
    status: "not_sent",
    reason: "grant revoked",
  });
  expect(await runEffect(channelConnector("discord", undefined)(send))).toEqual({
    contact: "telegram:12345",
    status: "not_sent",
    reason: "channel egress is not composed",
  });
  const human = { kind: "human", id: "owner" } as const;
  expect(await runEffect(humanConnector(undefined)({ ...send, address: human }))).toEqual({
    contact: "human:owner",
    status: "not_sent",
    reason: "human contact door is not composed",
  });
});

test("the scripted CLI connector forwards captured stdout to the sender as its prompt", async () => {
  const prompts: object[] = [];
  const runner = {
    run: (input: { agent: string; message: string }) =>
      Effect.succeed({ stdout: `${input.agent} answered: ${input.message}`, code: 0 }),
  };
  const reply = {
    prompt: (input: object) => Effect.sync(() => void prompts.push(input)),
  };
  const send = {
    sender: "parent-session",
    address: { kind: "cli", id: "claude-code" } as const,
    message: "review this diff",
  };
  expect(await runEffect(cliConnector(runner, reply)(send))).toEqual({
    contact: "cli:claude-code",
    status: "delivered",
  });
  expect(prompts).toEqual([
    {
      sessionId: "parent-session",
      contact: "cli:claude-code",
      content: "claude-code answered: review this diff",
    },
  ]);
  expect(
    await runEffect(cliConnector({ run: () => Effect.succeed({ stdout: "", code: 7 }) }, reply)(send)),
  ).toEqual({ contact: "cli:claude-code", status: "not_sent", reason: "exit 7" });
  expect(
    await runEffect(cliConnector({ run: () => Effect.fail({ reason: "spawn refused" }) }, reply)(send)),
  ).toEqual({ contact: "cli:claude-code", status: "not_sent", reason: "spawn refused" });
  expect(await runEffect(cliConnector(undefined, reply)(send))).toEqual({
    contact: "cli:claude-code",
    status: "not_sent",
    reason: "cli runner is not composed",
  });
});

test("the tool routes contact targets through connectors and everything else through the gateway door", async () => {
  const ingested: { sender: Gateway.IngestSender; to: Gateway.SendMessage["to"] }[] = [];
  const port: MessagePort = {
    ingest: async (sender, message) => {
      ingested.push({ sender, to: (message as Gateway.SendMessage).to });
      return {
        status: "executed",
        handle: { messageId: "m-1", target: "child-1" },
        delivery: { kind: "session" },
      } satisfies Gateway.IngestResult;
    },
  };
  const notified: object[] = [];
  const contacts: ContactPorts = {
    run: runEffect,
    human: { notify: (input) => Effect.sync(() => void notified.push(input)) },
  };
  const tool = createSendMessageTool(port, () => 1_000, contacts);
  const outcome = await tool.execute({ to: { kind: "contact", id: "human:owner" }, message: "ping", kind: "prompt" }, context);
  expect(outcome).toEqual({ contact: "human:owner", status: "delivered" });
  expect(notified).toEqual([{ to: "owner", text: "ping" }]);
  // An unprefixed contact id is the protocol's actor path, not a connector.
  await tool.execute({ to: { kind: "contact", id: "known-owner" }, message: "hi", kind: "prompt" }, context);
  expect(ingested).toEqual([
    { sender: { kind: "session", id: "sender" }, to: { kind: "actor", actorId: "known-owner" } },
  ]);
  const sealed = createSendMessageTool(undefined, () => 0);
  await expect(
    sealed.execute({ to: { kind: "session", id: "s-2" }, message: "hi", kind: "prompt" }, context),
  ).rejects.toThrow("message gateway is not composed");
});

test("a new child with a deadline arms delegation.deadline for the created child", async () => {
  const armed: object[] = [];
  const port: MessagePort = {
    ingest: async () =>
      ({
        status: "executed",
        handle: { messageId: "m-9", target: "child-9" },
        delivery: { kind: "session" },
      }) satisfies Gateway.IngestResult,
  };
  const tool = createSendMessageTool(port, () => 2_000, {
    run: runEffect,
    deadline: { arm: (input) => Effect.sync(() => void armed.push(input)) },
  });
  await tool.execute(
    { to: { kind: "new_session", role: "child", runner: "native", parent: "me" }, message: "go", kind: "prompt", deadline_ms: 500, spend_cap: 1 },
    context,
  );
  expect(armed).toEqual([{ sessionId: "sender", turnId: "turn-1", child: "child-9", at: 2_500 }]);
});

test("composing the action capability off cascades delegation-policy off and drops the action input", async () => {
  const manifest = appManifest({
    alarm: await alarmDefinition(),
    wake: { close: () => undefined },
    alarms: () => undefined,
    off: ["action"],
  });
  const generation = await runEffect(Bundle.compose(manifest));
  expect(generation.disabled).toContainEqual({ name: "delegation-policy", because: "action" });
  expect(generation.inputs).not.toContain("action");
  // With the bundle off, no delegation rows reach the policy plane; an
  // `action` deliver then refuses `unknown_kind` at input admission (core
  // input-admission suite) and a connector without its door journals the
  // `not_sent` fact (asserted above) — the cascade removes authority, never code.
  expect(generation.rows.filter((row) => row.id.startsWith("delegation-policy/"))).toEqual([]);
});

test("boot binds both bundles: guard rows seeded on the live policy plane and the first-prompt deliver replays idempotently", async () => {
  const app = await suite.boot({
    config: suite.config("contacts-boot-", { wsToken: "token" }),
    llm: {
      resolveModel: fakeProviderModel,
      run: (input, sink) => Effect.sync(() => {
        sink.onMessage(assistantMessage(input, { text: "BOUND" }));
        return { type: "stop" };
      }),
    },
  });
  const plane = await planeOf(app.runtime);
  const terminal = nextResidentTurn(plane);
  await ownerStart(app, "boot-bind-1");
  expect((await terminal).text).toBe("BOUND");
  const resident = plane.listSessions()[0];
  if (resident === undefined) throw new Error("boot produced no resident session");
  // delegation-policy bound: its three guard rows are live policy-plane rows.
  const generation = plane.openKernel(resident.id).currentPolicyGeneration();
  const guardRows = plane.catalog.policies
    .rows(generation)
    .filter((row) => row.name.startsWith("delegation-policy/tool.pre#"));
  expect(guardRows.map((row) => (row.verdict.value as { type: string; ref: string }).ref).sort()).toEqual([
    "delegation-policy/spawn-children",
    "delegation-policy/spawn-depth",
    "delegation-policy/spend-cap",
  ]);
  expect(guardRows.every((row) => (row.verdict.value as { type: string }).type === "consult")).toBe(true);
  // The first-prompt deliver path (#1258 to.new step 2): a replayed
  // idempotency key returns the recorded receipt, nothing runs twice.
  const second = nextResidentTurn(plane);
  const { first, replay } = await runAppEffect(
    app.runtime,
    Effect.scoped(
      Effect.gen(function* () {
        const makeClient = yield* SessionEntity.client;
        const entity = makeClient(resident.id);
        const message = {
          kind: "prompt",
          body: JSON.stringify({ content: "once" }),
          source: JSON.stringify({
            kind: "message",
            messageId: "contact-m1",
            senderSessionId: resident.id,
            sourceActionId: "contact-m1",
          }),
          idempotencyKey: "contact-m1",
        };
        const first = yield* entity.Deliver(message);
        // In-flight replay: the persisted envelope replays the recorded
        // receipt byte-identically; nothing commits twice.
        const replay = yield* entity.Deliver(message);
        return { first, replay };
      }),
    ),
  );
  await second;
  expect(first.existed).toBe(false);
  expect(replay.seq).toBe(first.seq);
  // Journal replay: a key committed by the child-side local door (the real
  // out-of-band writer) answers from the chain itself — {seq, existed: true}.
  const direct = await runEffect(
    localDelivery(plane, "contacts-test", () => Date.now())({
      id: "contact-m2",
      sessionId: resident.id,
      kind: "prompt",
      content: "twice",
      origin: {
        encodingVersion: 1,
        value: {
          kind: "message",
          messageId: "contact-m2",
          senderSessionId: resident.id,
          sourceActionId: "contact-m2",
        },
      },
      createdAt: Date.now(),
      parentActionId: null,
    }),
  );
  const settled = await runAppEffect(
    app.runtime,
    Effect.scoped(
      Effect.gen(function* () {
        const makeClient = yield* SessionEntity.client;
        return yield* makeClient(resident.id).Deliver({
          kind: "prompt",
          body: JSON.stringify({ content: "twice" }),
          source: JSON.stringify({
            kind: "message",
            messageId: "contact-m2",
            senderSessionId: resident.id,
            sourceActionId: "contact-m2",
          }),
          idempotencyKey: "contact-m2",
        });
      }),
    ),
  );
  expect(settled).toEqual({ seq: direct.ordinal, existed: true });
});
