import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { ChannelProviders, Vault, createChannelStores } from "@oni/channels";
import { Channel, Gateway, L0Observation, Operational } from "@oni/protocol";
import { createTelegramProvider } from "../../../packages/channels/src/provider/telegram/provider";
import { telegramOwnerLogin } from "../../../packages/channels/src/provider/telegram/owner-sdk";
import { fakeTelegramOwner, ownerMessage } from "../../../packages/channels/test/helpers/telegram-owner-sdk";
import { runCli } from "../src/cli/commands";
import { createCliDeps } from "../src/cli/main";
import { channelStoreSource } from "../src/gateway";
import { assistantMessage } from "./helpers/assistant-message";
import { sessionTree } from "../../../packages/agent/test/store/helpers/session-tree";
import { planeOf } from "./helpers/ledger";
import { receivedMessages } from "./helpers/received-messages";
import { nextResidentTurn } from "./helpers/resident-turn";
import { fakeProviderModel, residentSuite } from "./helpers/resident-suite";
import { testMachinesPlane } from "./helpers/self-machine";
import { Bus } from "./helpers/bus";
import { eventSignal } from "./helpers/event-signal";

const suite = residentSuite();

function ownerConfig(inbox: string, wsToken: string) {
  const machines = testMachinesPlane();
  return suite.config("oni-owner-app-", {
    wsToken,
    kek: { kind: "ok", kek: Vault.kekOf(new Uint8Array(32).fill(7)) },
    machines: { ...machines, inbox, self: {
      ...machines.self, exports: [...machines.self.exports, { name: "inbox", path: inbox }],
    } },
  });
}

function ownerCli(home: string, port: number, token: string, fake: ReturnType<typeof fakeTelegramOwner>) {
  const dataDir = join(home, ".oni", "telegram", "owner");
  mkdirSync(join(home, ".oni"), { recursive: true });
  writeFileSync(join(home, ".oni", "env"), [
    "ONI_WS_HOST=127.0.0.1", `ONI_WS_PORT=${port}`, `ONI_WS_TOKEN=${token}`,
    "ONI_TELEGRAM_API_ID=123", `ONI_TELEGRAM_API_HASH=${"a".repeat(32)}`,
  ].join("\n"));
  const base = createCliDeps(home);
  const output: string[] = [];
  const errors: string[] = [];
  const prompts: string[] = [];
  const deps = {
    ...base,
    stdout: (line: string) => { output.push(line); },
    stderr: (line: string) => { errors.push(line); },
    ask: async (question: string) => { prompts.push(question); throw new Error("unexpected prompt"); },
    login: { ...base.login, telegram: { ...base.login.telegram, dataDir, isTTY: true },
      logins: { ...base.login.logins, telegram: (input: Parameters<typeof telegramOwnerLogin>[0]) =>
        telegramOwnerLogin(input, fake.sdk) } },
  };
  return { deps, output, errors, prompts };
}

test("local Owner login, mounted ingress stream and two CLI history pages share one real app", async () => {
  const home = suite.tempDir("oni-owner-local-");
  const storage = suite.tempDir("oni-owner-inbox-");
  const inbox = join(storage, "inbox");
  mkdirSync(inbox);
  const dataDir = join(home, ".oni", "telegram", "owner");
  const bytes = Buffer.alloc(786_449, 0x5a);
  const count = 67;
  const size = count * bytes.byteLength;
  const expectedHash = createHash("sha256");
  const messages = [
    { ...ownerMessage, messageId: "102", dateSeconds: 123,
      media: [{ kind: "audio" as const, fileId: 71, name: "voice.ogg", mime: "audio/ogg", size, voice: true }] },
    { ...ownerMessage, messageId: "101", dateSeconds: 123, text: "older caption", media: [] },
    { ...ownerMessage, messageId: "100", dateSeconds: 122, text: "oldest", media: [] },
  ];
  let maxChunk = 0;
  let yielded = 0;
  let maxOutstanding = 0;
  let pulls = 0;
  // Bytes the machine has acknowledged are the bytes in its staging file under the inbox export, so
  // yielded minus staged is what the consumer holds without a machine acknowledgment.
  const staged = () => readdirSync(inbox).reduce((total, name) => total + statSync(join(inbox, name)).size, 0);
  const fake: ReturnType<typeof fakeTelegramOwner> = fakeTelegramOwner({
    onDownload: async (fileId) => {
      expect(fileId).toBe(71);
      return {
        size, name: "voice.ogg", mime: "audio/ogg",
        chunks: (async function* (): AsyncGenerator<Uint8Array, void, void> {
          for (let index = 0; index < count; index += 1) {
            pulls++;
            maxOutstanding = Math.max(maxOutstanding, yielded - staged());
            expectedHash.update(bytes);
            maxChunk = Math.max(maxChunk, bytes.byteLength);
            yielded += bytes.byteLength;
            yield bytes;
          }
        })(),
      };
    },
    onHistory: (_chat, before, limit) => {
      expect(limit).toBe(2);
      return before === undefined
        ? { messages: messages.slice(0, 2), before: "101" }
        : { messages: messages.slice(2) };
    },
  });
  const providers = { ...ChannelProviders, telegram: createTelegramProvider(undefined, fake.sdk) };
  const app = await suite.boot({
    config: ownerConfig(inbox, "owner-local-token"),
    channelProviders: providers,
    telegramDataDir: dataDir,
    llm: {
      resolveModel: fakeProviderModel,
      run: (input, sink) => Effect.sync(() => {
        sink.onMessage(assistantMessage(input, { text: "draft answer" }));
        return { type: "stop" as const };
      }),
    },
  });
  const plane = await planeOf(app.runtime);
  const { deps, output, errors, prompts } = ownerCli(home, app.port, "owner-local-token", fake);
  expect(await runCli(["login", "telegram"], deps)).toBe(0);
  expect(errors).toEqual([]);
  expect(prompts).toEqual([]);
  expect(output).toEqual([
    "Signed in to Telegram as owner-1",
    "channel:telegram:owner [telegram] → ready",
    "channel:telegram:owner [telegram:owner] → mounted",
  ]);
  expect(JSON.stringify(output)).not.toContain("a".repeat(32));
  const instance = plane.stores.instances.get("channel:telegram:owner");
  expect(instance).toMatchObject({
    identity: "owner", settings: { intake: "mentions_and_dms", autoReply: false },
  });
  expect(instance?.grant).toBeUndefined();
  if (instance?.credentialRef === undefined) throw new Error("credential was not sealed");
  expect(plane.stores.secrets.get(instance.credentialRef)).toBeDefined();
  expect(fake.calls.filter((call) => call === "start")).toHaveLength(2);
  expect(fake.calls.filter((call) => call === "close")).toHaveLength(1);
  const actors = createChannelStores(channelStoreSource(plane, () => Date.now())).actors;
  actors.registerIdentity({ id: "person:sender", kind: "human", trustTier: "manager" });
  actors.registerEndpoint({ id: "telegram:sender-1", actorId: "person:sender",
    channel: "telegram", externalId: "sender-1" });
  const sessionCount = plane.read.sessions.list().length;
  const committed = eventSignal<string>("one Owner ingress commit", 15_000);
  const settled = nextResidentTurn(plane, 15_000);
  const received: string[] = [];
  const warnings: string[] = [];
  const observations: string[] = [];
  suite.defer(Bus.subscribe(Gateway.MessageObserved, (event) => { observations.push(event.kind); }));
  suite.defer(Bus.subscribe(Operational.Events.Warn, (event) => { warnings.push(JSON.stringify(event)); }));
  suite.defer(Bus.subscribe(L0Observation.ActionCommittedEvent, (event) => {
    received.push(`${event.kind}:${event.sessionId}`);
    if (event.kind === "prompt") committed.resolve(event.sessionId);
  }));
  fake.emit(messages[0] ?? ownerMessage);
  const sessionId = await committed.promise;
  const stored = receivedMessages(plane, sessionId);
  expect(stored.filter((row) => {
    const origin = row.origin.value;
    return origin !== null && typeof origin === "object" && !Array.isArray(origin) && origin.kind === "external";
  })).toHaveLength(1);
  expect(stored.filter((row) => {
    const origin = row.origin.value;
    return origin !== null && typeof origin === "object" && !Array.isArray(origin) && origin.delivery === "followUp";
  })).toHaveLength(1);
  expect(stored[0]?.content).toContain("self:");
  expect((await settled).phase).toBe("terminal");
  expect(JSON.stringify(sessionTree(sessionId, plane.sessionStore(sessionId).actions)))
    .toContain("message.resident.reply_draft");
  expect(plane.read.sessions.list()).toHaveLength(sessionCount + 1);
  const files = readdirSync(inbox);
  expect(files).toHaveLength(1);
  const file = Bun.file(join(inbox, files[0] ?? ""));
  const diskHash = createHash("sha256");
  let diskBytes = 0;
  for await (const chunk of file.stream()) {
    diskBytes += chunk.byteLength;
    diskHash.update(chunk);
  }
  expect(size).toBeGreaterThan(50 * 1024 * 1024);
  expect(diskBytes).toBe(size);
  expect(diskHash.digest("hex")).toBe(expectedHash.digest("hex"));
  expect(pulls).toBe(count);
  expect(maxChunk).toBe(bytes.byteLength);
  expect(maxOutstanding).toBe(0);
  expect(warnings).toEqual([]);
  expect(observations.filter((kind) => kind === "message.admitted")).toHaveLength(1);
  expect(fake.sends).toEqual([]);
  output.length = 0;
  expect(await runCli(["channel", "history", "telegram:owner", "chat-1", "--limit", "2"], deps)).toBe(0);
  const first = Channel.HistoryPage.parse(JSON.parse(output.pop() ?? ""));
  expect(first.messages.map((message) => message.messageId)).toEqual(["102", "101"]);
  expect(first.before).toBe("101");
  if (first.before === undefined) throw new Error("first history page omitted its cursor");
  expect(first.messages[0]?.attachments[0]).toMatchObject({ voice: true, bytes: size });
  output.length = 0;
  expect(await runCli(["channel", "history", "telegram:owner", "chat-1", "--limit", "2", "--before", first.before], deps)).toBe(0);
  const second = Channel.HistoryPage.parse(JSON.parse(output.pop() ?? ""));
  expect(second.messages.map((message) => message.messageId)).toEqual(["100"]);
  expect(fake.calls.filter((call) => call === "history")).toHaveLength(2);
  expect(received.filter((entry) => entry === `prompt:${sessionId}`).length).toBeGreaterThan(0);
  expect(receivedMessages(plane, sessionId)).toEqual(stored);
  expect(plane.read.sessions.list()).toHaveLength(sessionCount + 1);
  expect(fake.calls.filter((call) => call === "download")).toHaveLength(1);
}, 120_000);

test("app shutdown aborts a held Owner inbox download before the account closes", async () => {
  const home = suite.tempDir("oni-owner-shutdown-");
  const storage = suite.tempDir("oni-owner-shutdown-inbox-");
  const inbox = join(storage, "inbox");
  mkdirSync(inbox);
  const dataDir = join(home, ".oni", "telegram", "owner");
  const order: string[] = [];
  const held = eventSignal<AbortSignal>("held Owner download", 15_000);
  const fake: ReturnType<typeof fakeTelegramOwner> = fakeTelegramOwner({
    onDownload: (_fileId, signal) => {
      held.resolve(signal);
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          order.push("abort");
          reject(signal.reason);
        }, { once: true });
      });
    },
    onClose: async () => { order.push("close"); },
  });
  const app = await suite.boot({
    config: ownerConfig(inbox, "owner-shutdown-token"),
    channelProviders: { ...ChannelProviders, telegram: createTelegramProvider(undefined, fake.sdk) },
    telegramDataDir: dataDir,
    llm: { resolveModel: fakeProviderModel, run: () => Effect.succeed({ type: "stop" as const }) },
  });
  const { deps } = ownerCli(home, app.port, "owner-shutdown-token", fake);
  expect(await runCli(["login", "telegram"], deps)).toBe(0);
  order.length = 0;
  fake.emit({ ...ownerMessage, messageId: "200",
    media: [{ kind: "file" as const, fileId: 72, name: "held.bin", mime: "application/octet-stream", size: 16 }] });
  const signal = await held.promise;
  expect(signal.aborted).toBe(false);
  await app.stop();
  expect(signal.aborted).toBe(true);
  expect(order).toEqual(["abort", "close"]);
  expect(readdirSync(inbox)).toEqual([]);
}, 120_000);
