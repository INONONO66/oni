/**
 * #1258 send-message contacts: one `send_message` tool reaches every contact
 * kind — session/new_session and channel contacts on the gateway ingest door
 * (one `Outbound.Payload` of parts or one reaction, #1497), CLI agents through
 * the connector registry — plus the composition-root bindings a unit fixture
 * would hide (#1254 lesson): both bundles bound at boot, the first-prompt
 * deliver's idempotency replay, and the `action`-off cascade that takes
 * delegation-policy with it.
 */
import { expect, test } from "bun:test";
import { Bundle, Core } from "@oni/agent";
import type { Gateway, Outbound } from "@oni/protocol";
const eraseTool = Core.eraseTool;
import { Effect } from "effect";
import { appManifest } from "../src/manifest";
import { alarmDefinition } from "./helpers/alarm-definition";
import {
  type A2AContactPort,
  a2aConnector,
  cliConnector,
  type CliRunnerPort,
  CliTurnPointer,
  createSendMessageTool,
  parseContactAddress,
  type MessagePort,
  type WebhookContactPort,
  webhookConnector,
} from "../src/bundles/messaging/send-message/index";
import { assistantMessage } from "./helpers/assistant-message";
import { runEffect } from "./helpers/effect";
import { runAppEffect } from "../src/gateway";
import { localDelivery, planeOf, testPlane } from "./helpers/ledger";
import { bounded, protectedDispatch } from "./helpers/protected-dispatch";
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

test("a Slack Owner call uses the same call port rather than the message gateway", async () => {
  const starts: object[] = [];
  const tool = createSendMessageTool(undefined, () => 1, {
    call: { start: async (input) => {
      starts.push(input);
      return { contact: input.contact, status: "joined", call: "call-1", surface: input.surface, channelId: input.channelId };
    } },
  });
  const receipt = await tool.execute({
    to: { kind: "contact", id: "person:owner", surface: "slack:owner", conversation: { channelId: "C1" } },
    kind: "call", message: "join this huddle",
  }, context);
  expect(receipt).toEqual({ contact: "person:owner", status: "joined", call: "call-1", surface: "slack:owner", channelId: "C1" });
  expect(starts).toEqual([{ contact: "person:owner", surface: "slack:owner", channelId: "C1", opening: "join this huddle", sessionId: "sender", turnId: "turn-1" }]);
  await expect(tool.execute({
    to: { kind: "contact", id: "person:owner", surface: "slack:owner", conversation: { channelId: "C1" }, as: "owner" },
    kind: "call",
  }, context)).rejects.toThrow("call_as_owner:");
  expect(starts).toHaveLength(1);
});

test("contact addresses parse per kind; channel ids and unknown kinds are no connector address, and no cli id is a literal (#1512)", () => {
  expect(parseContactAddress("cli:claude-code")).toEqual({ kind: "cli", id: "claude-code" });
  expect(parseContactAddress("webhook:hook-1")).toEqual({ kind: "webhook", id: "hook-1" });
  expect(parseContactAddress("webhook:")).toBeUndefined();
  expect(parseContactAddress("a2a:scout")).toEqual({ kind: "a2a", id: "scout" });
  // A cli id is a declared row the runner resolves, never a vendor name parsed here.
  expect(parseContactAddress("cli:reviewer")).toEqual({ kind: "cli", id: "reviewer" });
  expect(parseContactAddress("telegram:12345")).toBeUndefined();
  expect(parseContactAddress("human:owner")).toBeUndefined();
  expect(parseContactAddress("slack:general")).toBeUndefined();
  expect(parseContactAddress("owner")).toBeUndefined();
  expect(parseContactAddress("cli:")).toBeUndefined();
});

test("#1512: the cli connector runs one turn under the send's key and replies with the pointer to the admitted rows, reply_to the send", async () => {
  const prompts: object[] = [];
  const runs: object[] = [];
  const runner: CliRunnerPort = {
    run: (input) =>
      Effect.sync(() => {
        runs.push(input);
        return { child: "child-7", turn: input.key, facts: 5 };
      }),
  };
  const reply = {
    prompt: (input: object) => Effect.sync(() => void prompts.push(input)),
  };
  const send = {
    sender: "parent-session",
    turnId: "turn-1",
    address: { kind: "cli", id: "reviewer" } as const,
    idempotencyKey: "parent-session:call-1",
    message: "review this diff",
    deadlineMs: 5_000,
  };
  expect(await runEffect(cliConnector(runner, reply)(send))).toEqual({ contact: "cli:reviewer", status: "delivered" });
  expect(runs).toEqual([
    { agent: "reviewer", message: "review this diff", sender: "parent-session", turnId: "turn-1", key: "parent-session:call-1", deadlineMs: 5_000 },
  ]);
  // The reply is the pointer, never a copy of the child's rows.
  expect(prompts).toEqual([
    {
      sessionId: "parent-session",
      contact: "cli:reviewer",
      content: JSON.stringify(CliTurnPointer.parse({
        kind: "cli_turn", contact: "cli:reviewer", child: "child-7", turn: "parent-session:call-1", phase: "terminal", facts: 5,
      })),
      replyTo: "parent-session:call-1",
    },
  ]);
  // A refusal before the pane is `not_sent`; a letter that reached the pane and never ended is `unknown`, never re-sent.
  expect(
    await runEffect(cliConnector({ run: () => Effect.fail({ reason: "agent_blocked: the child is waiting on a permission request" }) }, reply)(send)),
  ).toEqual({ contact: "cli:reviewer", status: "not_sent", reason: "agent_blocked: the child is waiting on a permission request" });
  expect(
    await runEffect(cliConnector({ run: () => Effect.fail({ reason: "deadline expired; the child was interrupted", landed: true }) }, reply)(send)),
  ).toEqual({ contact: "cli:reviewer", status: "unknown", reason: "deadline expired; the child was interrupted" });
  expect(await runEffect(cliConnector(undefined, reply)(send))).toEqual({
    contact: "cli:reviewer",
    status: "not_sent",
    reason: "cli runner is not composed",
  });
  // A refused reply door is the sender's not_sent fact, not a silent success.
  expect(
    await runEffect(cliConnector(runner, { prompt: () => Effect.fail({ reason: "inbox closed" }) })(send)),
  ).toEqual({ contact: "cli:reviewer", status: "not_sent", reason: "inbox closed" });
  // Without a reply port the turn still ran and the send is delivered.
  expect(await runEffect(cliConnector(runner, undefined)(send))).toEqual({ contact: "cli:reviewer", status: "delivered" });
});

test("the webhook connector posts the letter through the port under the tool call's key and returns the target's answer on the result", async () => {
  const posted: object[] = [];
  const port = (outcome: { status: "sent" | "not_sent" | "unknown"; reason?: string; response?: string }): WebhookContactPort => ({
    post: (input) => Effect.sync(() => {
      posted.push(input);
      return outcome;
    }),
  });
  const send = {
    sender: "parent-session",
    turnId: "turn-1",
    address: { kind: "webhook", id: "hook-1" } as const,
    idempotencyKey: "parent-session:call-1",
    message: "build is green",
    replyTo: "m-0",
  };
  expect(await runEffect(webhookConnector(port({ status: "sent", response: "ack" }))(send))).toEqual({
    contact: "webhook:hook-1",
    status: "delivered",
    response: "ack",
  });
  expect(posted).toEqual([
    { id: "hook-1", idempotencyKey: "parent-session:call-1", sender: "parent-session", message: "build is green", replyTo: "m-0" },
  ]);
  // A silent target: delivered, nothing to return.
  expect(await runEffect(webhookConnector(port({ status: "sent" }))(send))).toEqual({ contact: "webhook:hook-1", status: "delivered" });
  // The target's refusal with its own word, an unknown outcome, no port.
  expect(await runEffect(webhookConnector(port({ status: "not_sent", reason: "HTTP 404" }))(send))).toEqual({
    contact: "webhook:hook-1",
    status: "not_sent",
    reason: "HTTP 404",
  });
  expect(await runEffect(webhookConnector(port({ status: "not_sent" }))(send))).toEqual({
    contact: "webhook:hook-1",
    status: "not_sent",
    reason: "the target refused the letter",
  });
  expect(await runEffect(webhookConnector(port({ status: "unknown" }))(send))).toEqual({
    contact: "webhook:hook-1",
    status: "unknown",
    reason: "the outcome is unknown; the letter is not re-sent",
  });
  expect(await runEffect(webhookConnector(undefined)(send))).toEqual({
    contact: "webhook:hook-1",
    status: "not_sent",
    reason: "webhook port is not composed",
  });
});

test("the a2a connector sends the letter through the port under the tool call's key with its deadline and thread, and returns the peer's answer or where its task stands", async () => {
  const posted: object[] = [];
  const port = (outcome: { status: "sent" | "not_sent" | "unknown"; reason?: string; response?: string; taskId?: string; taskState?: string; thread?: string }): A2AContactPort => ({
    post: (input) => Effect.sync(() => {
      posted.push(input);
      return outcome;
    }),
  });
  const send = {
    sender: "parent-session",
    turnId: "turn-1",
    address: { kind: "a2a", id: "scout" } as const,
    idempotencyKey: "parent-session:call-1",
    message: "scout the area",
    deadlineMs: 5_000,
  };
  expect(await runEffect(a2aConnector(port({ status: "sent", response: "two camps", thread: "context:c-1" }))(send))).toEqual({
    contact: "a2a:scout",
    status: "delivered",
    response: "two camps",
    thread: "context:c-1",
  });
  expect(posted).toEqual([{ id: "scout", idempotencyKey: "parent-session:call-1", sender: "parent-session", message: "scout the area", deadlineMs: 5_000 }]);
  await runEffect(a2aConnector(port({ status: "sent" }))({ ...send, replyTo: "task:t-1" }));
  expect(posted[1]).toMatchObject({ replyTo: "task:t-1" });
  expect(await runEffect(a2aConnector(port({ status: "sent", taskId: "t-1", taskState: "working", thread: "task:t-1" }))(send))).toEqual({
    contact: "a2a:scout",
    status: "delivered",
    reason: "the peer is still working on task t-1 (working)",
    thread: "task:t-1",
  });
  expect(await runEffect(a2aConnector(port({ status: "sent", taskId: "t-1", taskState: "input-required", response: "which area?", thread: "task:t-1" }))(send))).toEqual({
    contact: "a2a:scout",
    status: "delivered",
    reason: "the peer is waiting on the sender for task t-1 (input-required); reply_to task:t-1 answers it",
    response: "which area?",
    thread: "task:t-1",
  });
  expect(await runEffect(a2aConnector(port({ status: "sent", taskId: "t-1", taskState: "rejected", thread: "context:c-1" }))(send))).toEqual({
    contact: "a2a:scout",
    status: "delivered",
    reason: "the peer's task t-1 ended rejected",
    thread: "context:c-1",
  });
  expect(await runEffect(a2aConnector(port({ status: "not_sent", reason: "-32005: Incompatible content types" }))(send))).toEqual({
    contact: "a2a:scout",
    status: "not_sent",
    reason: "-32005: Incompatible content types",
  });
  expect(await runEffect(a2aConnector(port({ status: "unknown" }))(send))).toEqual({
    contact: "a2a:scout",
    status: "unknown",
    reason: "the outcome is unknown; the letter is not re-sent",
  });
  expect(await runEffect(a2aConnector(undefined)(send))).toEqual({ contact: "a2a:scout", status: "not_sent", reason: "a2a port is not composed" });
});

test("#1600 lane R3: an actor delivery the platform rejected, or whose outcome is unknown, is the sender's fact on the result — the same word a connector contact gives", async () => {
  let value: "rejected" | "unknown" = "rejected";
  const port: MessagePort = {
    ingest: async () =>
      ({ status: "executed", handle: { messageId: "m-1", target: "person:peer" }, delivery: { kind: "actor", value } }) satisfies Gateway.IngestResult,
  };
  const tool = createSendMessageTool(port, () => 1_000, { run: runEffect });
  const letter = { to: { kind: "contact" as const, id: "person:peer" }, message: "hello", kind: "prompt" as const };
  expect(await tool.execute(letter, { ...context, domainRevisions: {} })).toEqual({
    contact: "person:peer",
    status: "not_sent",
    reason: "the platform did not accept the letter",
  });
  value = "unknown";
  expect(await tool.execute(letter, { ...context, domainRevisions: {} })).toEqual({
    contact: "person:peer",
    status: "unknown",
    reason: "the outcome is unknown; the letter is not re-sent",
  });
});

test("a rejected actor send returns the provider refusal reason to the tool caller", async () => {
  const tool = createSendMessageTool({
    ingest: async () => ({
      status: "executed",
      handle: { messageId: "m-1", target: "person:peer" },
      delivery: { kind: "actor", value: "rejected", reason: "media_too_large audio 60>50" },
    }),
  }, () => 1_000);
  const result = await tool.execute(tool.input.parse({
    to: { kind: "contact", id: "person:peer" },
    message: {
      root: "audio",
      elements: { audio: { type: "Audio", props: { ref: "/voice.ogg" }, children: [] } },
    },
  }), context);
  expect(result).toStrictEqual({
    contact: "person:peer",
    status: "not_sent",
    reason: "media_too_large audio 60>50",
  });
});

test("#1569 lane 8: a letter to a reachable Person with no active budget suspends for the Owner's consent, bound to the Person row; connector contacts, sessions, budgeted and unreachable Persons never wait; the kernel's answer is the consent fact", async () => {
  const ingested: Gateway.SendMessage[] = [];
  const port: MessagePort = {
    ingest: async (_sender, message) => {
      ingested.push(message as Gateway.SendMessage);
      return { status: "executed", handle: { messageId: "m-1", target: "person:peer" }, delivery: { kind: "actor", value: "accepted" } } satisfies Gateway.IngestResult;
    },
  };
  const plane = testPlane();
  const person = (id: string, reach: boolean) => ({ id, displayName: id, kind: "human" as const, trustTier: "observer" as const, endpoints: [{ channel: "ws", externalId: id }], ...(reach ? { reach: true } : {}), revision: 0, createdBy: "owner", updatedAt: 1 });
  plane.stores.persons.put(person("person:peer", true));
  plane.stores.persons.put(person("person:owner", true));
  plane.stores.persons.put(person("person:stranger", false));
  const budgets: Gateway.SocialBudget[] = [
    { id: "b-owner", targetActorId: "person:owner", maxPerWindow: 1, windowMs: 1000, cooldownMs: 0 },
    { id: "b-lapsed", targetActorId: "person:lapsed", maxPerWindow: 1, windowMs: 1000, cooldownMs: 0, expiresAt: 500 },
  ];
  plane.stores.persons.put(person("person:lapsed", true));
  const contacts = { run: runEffect, budgets: () => budgets, persons: plane.stores.persons };
  const tool = createSendMessageTool(port, () => 1_000, contacts);
  const context = { sessionId: "resident", turnId: "turn-1", callId: "call-1", signal: new AbortController().signal };
  const letterTo = (id: string) => ({ to: { kind: "contact" as const, id }, message: "hello", kind: "prompt" as const });
  if (tool.approval === undefined) throw new Error("send_message declares no approval hook");
  // Reachable, no budget: the Owner's to approve, bound to the row as it stands.
  expect(tool.approval(letterTo("person:peer"), context)).toEqual({ required: true, domainRevisions: { "person:peer": 0 } });
  // A lapsed budget is no budget.
  expect(tool.approval(letterTo("person:lapsed"), context)).toEqual({ required: true, domainRevisions: { "person:lapsed": 0 } });
  // Budgeted, unreachable (the gate refuses on its own), unknown, connector, session and child targets never wait.
  for (const id of ["person:owner", "person:stranger", "person:nobody", "cli:codex", "webhook:out", "a2a:scout"])
    expect(tool.approval(letterTo(id), context)).toEqual({ required: false, domainRevisions: {} });
  expect(tool.approval({ to: { kind: "session" as const, id: "child-1" }, message: "hello", kind: "prompt" as const }, context)).toEqual({ required: false, domainRevisions: {} });
  expect(tool.approval({ to: { kind: "new_session" as const, role: "child" as const, runner: "resident", parent: "me" as const }, message: "hello", kind: "prompt" as const, spend_cap: 1 }, context)).toEqual({ required: false, domainRevisions: {} });
  // The body derives the consent fact from the bound revisions the kernel hands it, never from the budget list again.
  await tool.execute(letterTo("person:peer"), { ...context, domainRevisions: {} });
  expect(ingested[0]?.consented).toBeUndefined();
  await tool.execute(letterTo("person:peer"), { ...context, domainRevisions: { "person:peer": 0 } });
  expect(ingested[1]).toMatchObject({ consented: true, to: { kind: "actor", actorId: "person:peer" } });
  // Without the budgets and persons ports nothing is gated here.
  const ungated = createSendMessageTool(port, () => 1_000, { run: runEffect });
  expect(ungated.approval?.(letterTo("person:peer"), context)).toEqual({ required: false, domainRevisions: {} });
  // The kernel leg: the invocation suspends, the Owner's answer runs the captured body once, and the send carries consent.
  const sealed = eraseTool(createSendMessageTool(port, () => 1_000, contacts));
  const consent = protectedDispatch(sealed, letterTo("person:peer"), undefined, { plane });
  try {
    const request = await bounded(consent.opened);
    expect(request.domainRevisions).toEqual({ "person:peer": 0 });
    expect(ingested).toHaveLength(2);
    expect((await consent.answer()).isError).toBeUndefined();
    expect(ingested[2]).toMatchObject({ consented: true, to: { kind: "actor", actorId: "person:peer" } });
  } finally {
    await consent.close();
  }
  // A refused answer sends nothing; an edit of the Person row between the request and the answer is stale consent.
  const refused = protectedDispatch(sealed, letterTo("person:peer"), undefined, { plane });
  try {
    expect((await refused.answer("refuse")).isError).toBe(true);
    expect(ingested).toHaveLength(3);
  } finally {
    await refused.close();
  }
  const stale = protectedDispatch(sealed, letterTo("person:peer"), undefined, { plane });
  try {
    await bounded(stale.opened);
    plane.stores.persons.put({ ...person("person:peer", true), endpoints: [{ channel: "ws", externalId: "elsewhere" }], revision: 1 });
    await expect(stale.answer()).rejects.toMatchObject({ code: "stale_approval" });
    expect(ingested).toHaveLength(3);
  } finally {
    await stale.close();
  }
  plane.close();
});

test("the tool input accepts catalog audio durations and forwards them to the gateway", async () => {
  const ingested: Parameters<MessagePort["ingest"]>[1][] = [];
  const tool = createSendMessageTool({
    ingest: async (_sender, message) => {
      ingested.push(message);
      return {
        status: "executed",
        handle: { messageId: "m-audio", target: "person:peer" },
        delivery: { kind: "actor", value: "accepted" },
      };
    },
  }, () => 1_000);
  const spec: Outbound.Spec = {
    root: "audio",
    elements: { audio: { type: "Audio", props: { ref: "/voice.ogg", durationMs: 65_000 }, children: [] } },
  };
  const input = tool.input.parse({ to: { kind: "contact", id: "person:peer" }, message: spec });
  expect(input.message).toStrictEqual(spec);
  await tool.execute(input, context);
  expect(ingested).toStrictEqual([{
    to: { kind: "actor", actorId: "person:peer" },
    type: "message",
    content: { kind: "message", spec },
  }]);
});

test("the tool routes CLI contacts through connectors and everything else through the gateway door as one payload", async () => {
  const ingested: { sender: Gateway.IngestSender; to: Gateway.SendMessage["to"]; content: Gateway.SendMessage["content"] }[] = [];
  const port: MessagePort = {
    ingest: async (sender, message) => {
      const send = message as Gateway.SendMessage;
      ingested.push({ sender, to: send.to, content: send.content });
      return {
        status: "executed",
        handle: { messageId: "m-1", target: "child-1" },
        delivery: { kind: "session" },
      } satisfies Gateway.IngestResult;
    },
  };
  const tool = createSendMessageTool(port, () => 1_000, { run: runEffect });
  const conversation = { channelId: "C1", replyToMessageId: "1700000000.000100" };
  // A contact id is the protocol's actor path; a string letter is one text part.
  await tool.execute({ to: { kind: "contact", id: "known-owner" }, message: "hi", kind: "prompt" }, context);
  // A spec rides through untouched; a reaction names the message the contact wrote.
  const spec: Outbound.Spec = {
    root: "body",
    elements: {
      body: { type: "Stack", props: {}, children: ["here", "ls", "shot", "report"] },
      here: { type: "Markdown", props: { text: "here" }, children: [] },
      ls: { type: "Code", props: { text: "ls", lang: "sh" }, children: [] },
      shot: { type: "Image", props: { ref: "/tmp/a.png" }, children: [] },
      report: { type: "File", props: { ref: "https://example.test/r.pdf", name: "r.pdf" }, children: [] },
    },
  };
  await tool.execute(
    { to: { kind: "contact", id: "known-owner", surface: "slack", conversation }, message: spec, kind: "prompt" },
    context,
  );
  await tool.execute(
    { to: { kind: "contact", id: "known-owner", surface: "slack", conversation }, react: "\u{1F44D}", kind: "prompt" },
    context,
  );
  expect(ingested).toEqual([
    {
      sender: { kind: "session", id: "sender" },
      to: { kind: "actor", actorId: "known-owner" },
      content: { kind: "message", parts: [{ kind: "text", text: "hi" }] },
    },
    {
      sender: { kind: "session", id: "sender" },
      to: { kind: "actor", actorId: "known-owner", surface: "slack", conversation },
      content: { kind: "message", spec },
    },
    {
      sender: { kind: "session", id: "sender" },
      to: { kind: "actor", actorId: "known-owner", surface: "slack", conversation },
      content: { kind: "react", messageId: "1700000000.000100", emoji: "\u{1F44D}" },
    },
  ]);
  // A reaction without the message it sits on is refused before any send; the
  // input schema the loop parses with admits exactly one of letter or reaction.
  await expect(
    tool.execute({ to: { kind: "contact", id: "known-owner" }, react: "\u{1F44D}", kind: "prompt" }, context),
  ).rejects.toThrow("react needs a channel contact with conversation.replyToMessageId");
  expect(ingested).toHaveLength(3);
  // A CLI agent reads a letter from stdin: a reaction has nowhere to land, and a
  // parts letter folds to the text the connector pipes through.
  const piped: string[] = [];
  const cli = createSendMessageTool(port, () => 1_000, {
    run: runEffect,
    cli: {
      run: (input) =>
        Effect.sync(() => {
          piped.push(input.message);
          return { child: "child-1", turn: input.key, facts: 1 };
        }),
    },
    reply: { prompt: () => Effect.void },
  });
  await expect(
    cli.execute({ to: { kind: "contact", id: "cli:claude-code" }, react: "\u{1F44D}", kind: "prompt" }, context),
  ).rejects.toThrow("a cli contact takes a letter, not a reaction");
  expect(
    await cli.execute(
      {
        to: { kind: "contact", id: "cli:claude-code" },
        message: {
          root: "body",
          elements: {
            body: { type: "Stack", props: {}, children: ["ask", "code"] },
            ask: { type: "Markdown", props: { text: "review" }, children: [] },
            code: { type: "Code", props: { text: "x = 1", lang: "py" }, children: [] },
          },
        },
        kind: "prompt",
      },
      context,
    ),
  ).toEqual({ contact: "cli:claude-code", status: "delivered" });
  expect(piped).toEqual(["review\n\n```py\nx = 1\n```"]);
  const both = tool.input.safeParse({ to: { kind: "contact", id: "known-owner" }, message: "hi", react: "\u{1F44D}" });
  expect(both.success).toBe(false);
  expect(tool.input.safeParse({ to: { kind: "contact", id: "known-owner" } }).success).toBe(false);
  expect(tool.input.safeParse({ to: { kind: "contact", id: "known-owner" }, react: "\u{1F44D}" }).success).toBe(true);
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
    alarms: () => undefined, tools: () => undefined,
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
          body: JSON.stringify({ content: [{ kind: "text", text: "once" }] }),
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
      content: [{ kind: "text", text: "twice" }],
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
          body: JSON.stringify({ content: [{ kind: "text", text: "twice" }] }),
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
