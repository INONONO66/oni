import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Outbound } from "@oni/protocol";
import { createTelegramProvider } from "../src/provider/telegram/provider";
import { ownerInbound } from "../src/provider/telegram/owner-normalizer";
import { telegramOwnerLogin, TelegramOwnerError } from "../src/provider/telegram/owner-sdk";
import { ownerSession } from "../src/provider/telegram/owner-custody";
import type { ProviderOptions } from "../src/provider/contract";
import { TelegramNormalizer } from "../src/provider/telegram/normalizer";
import { inboundOnce } from "../src/support/inbound-once";
import { fakeTelegramOwner, ownerMessage } from "./helpers/telegram-owner-sdk";
import { injectedOptions } from "./helpers/injected";
import { telegramReply } from "./helpers/telegram";

const credentials = { apiId: "123", apiHash: "a".repeat(32) };
const dirs: string[] = [];
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), "oni-telegram-owner-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function mounted(
  fake: ReturnType<typeof fakeTelegramOwner>,
  dir: string,
  intake: "all" | "none" | "mentions_and_dms" = "mentions_and_dms",
  media?: ProviderOptions["media"],
) {
  const options = { ...injectedOptions(), telegramDataDir: dir, ...(media === undefined ? {} : { media }) };
  const arm = createTelegramProvider(undefined, fake.sdk).owner;
  if (arm === undefined) throw new Error("missing Owner arm");
  return arm.create(credentials, { intake, autoReply: false }, () => undefined, options);
}

describe("Telegram account Owner", () => {
  test("subscribes before start, gates early intake on verified identity, and closes once", async () => {
    const dir = await directory();
    const fake = fakeTelegramOwner({ onStart: (client) => {
      expect(client).toBe(fake.client);
      fake.emit(ownerMessage);
    } });
    const runtime = mounted(fake, dir);
    const admitted = Promise.withResolvers<string>();
    runtime.surface.onMessage(async (message) => admitted.resolve(message.facts.eventId));
    await runtime.surface.start("start");
    expect(await admitted.promise).toBe("tdlib:100");
    expect(fake.calls.slice(0, 4)).toEqual(["client", "subscribe-state", "subscribe", "start"]);
    expect(runtime.account?.()).toEqual({ externalId: "owner-1" });
    await runtime.surface.stop("stop");
    await runtime.surface.stop("stop-again");
    expect(fake.calls.filter((call) => call === "close")).toHaveLength(1);
    expect(runtime.account?.()).toBeUndefined();
  });

  test("unready and identity-free starts close before releasing exclusive custody", async () => {
    const dir = await directory();
    for (const states of [[{ state: "phone" as const }], [{ state: "ready" as const }]]) {
      const fake = fakeTelegramOwner({ states });
      const runtime = mounted(fake, dir);
      await expect(runtime.surface.start("start")).rejects.toMatchObject({
        code: states[0]?.state === "phone" ? "login_action_required" : "session_lost",
      });
      expect(fake.calls.filter((call) => call === "close")).toHaveLength(1);
    }
  });

  test("normalizes DM, resolved mention, all and none without own echoes or empty events", async () => {
    const dir = await directory();
    for (const [intake, accepted] of [
      ["mentions_and_dms", 2], ["all", 3], ["none", 0],
    ] as const) {
      const fake = fakeTelegramOwner();
      const runtime = mounted(fake, dir, intake);
      const messages: string[] = [];
      const complete = Promise.withResolvers<void>();
      runtime.surface.onMessage(async (message) => {
        messages.push(message.facts.eventId);
        if (messages.length === accepted) complete.resolve();
      });
      await runtime.surface.start("start");
      fake.emit(ownerMessage);
      fake.emit({ ...ownerMessage, messageId: "101", chatId: "group", dm: false, mentionedUserIds: ["owner-1"] });
      fake.emit({ ...ownerMessage, messageId: "102", chatId: "group", dm: false });
      fake.emit({ ...ownerMessage, messageId: "103", outgoing: true });
      fake.emit({ ...ownerMessage, messageId: "104", text: "", media: [] });
      if (accepted > 0) await complete.promise;
      expect(messages).toHaveLength(accepted);
      await runtime.surface.stop("stop");
    }
  });

  test("all five inbound media forms and reply metadata retain native references", () => {
    const media = [
      { kind: "image" as const, fileId: 1, name: "i", mime: "image/png", size: 5 },
      { kind: "audio" as const, fileId: 2, name: "a", mime: "audio/ogg", size: 6 },
      { kind: "audio" as const, fileId: 3, name: "v", mime: "audio/ogg", size: 7, voice: true },
      { kind: "video" as const, fileId: 4, name: "m", mime: "video/mp4", size: 8 },
      { kind: "file" as const, fileId: 5, name: "f", mime: "application/pdf", size: 9 },
    ];
    const message = ownerInbound({ ...ownerMessage, media }, "owner-1");
    expect(message?.facts.attachments?.map((part) => [part.kind, part.ref, part.voice])).toEqual([
      ["image", "tdlib-file:1", undefined], ["audio", "tdlib-file:2", undefined],
      ["audio", "tdlib-file:3", true], ["video", "tdlib-file:4", undefined],
      ["file", "tdlib-file:5", undefined],
    ]);
    expect(message?.facts.reply).toEqual({ chain: ["99"], replyToMessageId: "99" });
    expect(message?.facts.render).toBe("caption");
    expect(message?.facts.eventId).toBe("tdlib:100");
    expect(ownerInbound({ ...ownerMessage, outgoing: true }, "owner-1")).toBeNull();
  });

  test("shared Bot API id and thread are canonical, while unshared ids stay account-local", () => {
    const shared = ownerInbound({
      ...ownerMessage, messageId: "12582912", botMessageId: "12",
      replyToMessageId: "11534336", botReplyToMessageId: "11",
      threadId: "forum:42", botThreadId: "42",
    }, "owner-1");
    expect(shared?.facts.eventId).toBe("12");
    expect(shared?.facts.reply).toEqual({
      chain: ["11"], replyToMessageId: "11", threadId: "42",
    });
    expect(ownerInbound(ownerMessage, "owner-1")?.facts.eventId).toBe("tdlib:100");
  });

  test("bot and Owner copies of a canonical message share one physical duplicate key", async () => {
    const admitted: string[] = [];
    const carry = inboundOnce(async (message) => { admitted.push(message.facts.eventId); });
    const bot = new TelegramNormalizer({ botId: "78", botUsername: "oni_bot" }).normalize(telegramReply());
    const owner = ownerInbound({
      ...ownerMessage, chatId: "34", messageId: "12582912", botMessageId: "12",
      senderId: "56", sender: { kind: "user", id: "56", isBot: false },
    }, "owner-1");
    if (bot === null || owner === null) throw new Error("fixture is not an inbound message");
    await carry(bot);
    await carry(owner);
    expect(admitted).toEqual(["12"]);
    const accountOnly = ownerInbound({
      ...ownerMessage, chatId: "34", messageId: "12",
      senderId: "56", sender: { kind: "user", id: "56", isBot: false },
    }, "owner-1");
    if (accountOnly === null) throw new Error("account-only fixture is not inbound");
    await carry(accountOnly);
    expect(admitted).toEqual(["12", "tdlib:12"]);
  });

  test("chat sender carries its chat identity without inventing a user bot flag", () => {
    const inbound = ownerInbound({
      ...ownerMessage, senderId: "chat-author", sender: { kind: "chat", id: "chat-author" },
    }, "owner-1");
    expect(inbound?.sender.externalId).toBe("chat-author");
    expect(inbound?.facts.author).toBeUndefined();
    expect(ownerInbound({
      ...ownerMessage, sender: { kind: "user", id: "bot-sender", isBot: true },
    }, "owner-1")?.facts.author).toEqual({ externalId: "bot-sender", isBot: true });
  });

  test("observed canonical topic and reply ids route through their native counterparts", async () => {
    const dir = await directory();
    const fake = fakeTelegramOwner();
    const runtime = mounted(fake, dir);
    const observed = Promise.withResolvers<void>();
    runtime.surface.onMessage(async () => observed.resolve());
    await runtime.surface.start("start");
    fake.emit({
      ...ownerMessage, messageId: "12582912", botMessageId: "12",
      threadId: "forum:42", botThreadId: "42",
    });
    await observed.promise;
    expect(await runtime.deliveryRoute?.("sender-1", Outbound.payload("answer"), "topic-key", {
      channelId: "chat-1", threadId: "42", replyToMessageId: "12",
    })).toEqual({ value: "accepted", externalMessageId: "ack-1" });
    expect(fake.sends).toEqual([{
      chatId: "chat-1", content: {
        kind: "text", text: "answer", replyTo: "12582912", threadId: "forum:42",
      },
    }]);
    await runtime.surface.stop("stop");
  });

  test("history keeps native page order, exclusive cursor, short and empty pages without downloading", async () => {
    const dir = await directory();
    const queries: (string | undefined)[] = [];
    const fake = fakeTelegramOwner({ onHistory: (_chat, before, limit) => {
      expect(limit).toBe(2);
      queries.push(before);
      if (before === "99") return { messages: [] };
      return { messages: [
        { ...ownerMessage, messageId: "100", dateSeconds: 12, threadId: "forum:42" },
        { ...ownerMessage, messageId: "99", dateSeconds: 12 },
      ], before: "99" };
    } });
    const runtime = mounted(fake, dir, "none");
    await runtime.surface.start("start");
    expect(await runtime.historyRoute?.({ chatId: "chat-1", limit: 2 })).toMatchObject({
      status: "ok", page: { messages: [{ messageId: "100", threadId: "forum:42" }, { messageId: "99" }], before: "99" },
    });
    expect(await runtime.historyRoute?.({ chatId: "chat-1", limit: 2, before: "99" }))
      .toEqual({ status: "ok", page: { messages: [] } });
    expect(queries).toEqual([undefined, "99"]);
    expect(fake.calls).not.toContain("download");
    await runtime.surface.stop("stop");
  });

  test("stream fetch checks metadata before download and returns one chunk source", async () => {
    const dir = await directory();
    const bytes = new Uint8Array([1, 2, 3]);
    const fake: ReturnType<typeof fakeTelegramOwner> = fakeTelegramOwner({ onDownload: async (fileId) => ({
      size: 3, name: String(fileId), mime: "image/png",
      chunks: (async function* (): AsyncGenerator<Uint8Array, void, void> { yield bytes; })(),
    }) });
    const runtime = mounted(fake, dir);
    const received = Promise.withResolvers<void>();
    runtime.surface.onMessage(async () => received.resolve());
    await runtime.surface.start("start");
    fake.emit({ ...ownerMessage, media: [{ kind: "image", fileId: 7, name: "x", mime: "image/png", size: 3 }] });
    await received.promise;
    const signal = new AbortController().signal;
    await expect(runtime.streamingAttachments?.("tdlib-file:7", { maxBytes: 2, signal }))
      .rejects.toMatchObject({ reason: "too_large" });
    expect(fake.calls).not.toContain("download");
    const stream = await runtime.streamingAttachments?.("tdlib-file:7", { maxBytes: 3, signal });
    expect(stream).toMatchObject({ size: 3, name: "7" });
    if (stream !== undefined && "chunks" in stream) {
      const parts: Uint8Array[] = [];
      for await (const part of stream.chunks) parts.push(part);
      expect(parts).toEqual([bytes]);
    }
    await runtime.surface.stop("stop");
  });

  test("definite SDK rejection is retryable without a hidden physical retry", async () => {
    const dir = await directory();
    const fake = fakeTelegramOwner({ onSend: async () => {
      throw new TelegramOwnerError("unverified dispatch", "not_sent");
    } });
    const runtime = mounted(fake, dir);
    await runtime.surface.start("start");
    const send = runtime.deliveryRoute;
    expect(await send?.("peer", Outbound.payload("hello"), "key-1")).toEqual({ value: "rejected" });
    expect(await send?.("peer", Outbound.payload("hello"), "key-1")).toEqual({ value: "rejected" });
    expect(fake.sends).toHaveLength(2);
    expect(fake.sends[0]).toEqual({ chatId: "peer", content: { kind: "text", text: "hello" } });
    expect(await send?.("peer", { kind: "message", parts: [{ kind: "image", ref: "machine:/file" }] }, "key-2"))
      .toMatchObject({ value: "rejected", reason: "media_unavailable" });
    expect(fake.sends).toHaveLength(2);
    await runtime.surface.stop("stop");
  });

  test("ambiguous SDK send rejection stays unknown and a repeated key cannot resend", async () => {
    const dir = await directory();
    const fake = fakeTelegramOwner({ onSend: async () => {
      throw new TelegramOwnerError("lost confirmation", "unknown");
    } });
    const runtime = mounted(fake, dir);
    await runtime.surface.start("start");
    const send = runtime.deliveryRoute;
    expect(await send?.("peer", Outbound.payload("hello"), "uncertain")).toEqual({ value: "unknown" });
    expect(await send?.("peer", Outbound.payload("hello"), "uncertain")).toEqual({ value: "unknown" });
    expect(fake.sends).toHaveLength(1);
    await runtime.surface.stop("stop");
  });

  test("media send session loss is uncertain, withdraws readiness and cannot resend", async () => {
    const dir = await directory();
    const fake = fakeTelegramOwner({ onSend: async () => {
      throw new TelegramOwnerError("revoked after dispatch", "session_lost");
    } });
    const runtime = mounted(fake, dir, "none",
      async () => ({ bytes: new Uint8Array([1]), name: "photo.png", mime: "image/png" }));
    const withdrawn: string[] = [];
    runtime.onWithdrawn?.((reason) => withdrawn.push(reason));
    await runtime.surface.start("start");
    const payload: Outbound.Payload = { kind: "message", parts: [{ kind: "image", ref: "machine:photo" }] };
    expect(await runtime.deliveryRoute?.("peer", payload, "media-loss")).toEqual({ value: "unknown" });
    // The retained uncertain key keeps its receipt; only a new key is refused before dispatch.
    expect(await runtime.deliveryRoute?.("peer", payload, "media-loss")).toEqual({ value: "unknown" });
    expect(await runtime.deliveryRoute?.("peer", payload, "after-loss")).toEqual({ value: "rejected" });
    expect(runtime.account?.()).toBeUndefined();
    expect(withdrawn).toEqual(["session_lost"]);
    expect(fake.sends).toHaveLength(1);
    await runtime.surface.stop("stop");
  });

  test("each media kind sends bounded bytes, including voice, caption and native reply metadata", async () => {
    const dir = await directory();
    const fake = fakeTelegramOwner();
    const bytes = new Uint8Array([1, 2, 3]);
    const runtime = mounted(fake, dir, "none",
      async () => ({ bytes, name: "sample", mime: "application/octet-stream" }));
    await runtime.surface.start("start");
    const cases = [
      { part: { kind: "image", ref: "image" }, wireKind: "image" },
      { part: { kind: "audio", ref: "audio" }, wireKind: "audio" },
      { part: { kind: "audio", ref: "voice", voice: true }, wireKind: "voice" },
      { part: { kind: "video", ref: "video" }, wireKind: "video" },
      { part: { kind: "file", ref: "file", name: "sample" }, wireKind: "file" },
    ] as const satisfies readonly { readonly part: Outbound.Part; readonly wireKind: string }[];
    for (const { part, wireKind } of cases) {
      expect(await runtime.deliveryRoute?.("peer", {
        kind: "message", parts: [{ ...part, caption: "caption" }],
      }, `key-${wireKind}`, { channelId: "chat-1", replyToMessageId: "99" }))
        .toEqual({ value: "accepted", externalMessageId: "ack-1" });
    }
    expect(fake.sends.map(({ content }) => content)).toEqual(([
      "image", "audio", "voice", "video", "file",
    ] as const).map((kind) => ({
      kind, bytes, name: "sample", mime: "application/octet-stream",
      caption: "caption", replyTo: "99",
    })));
    await runtime.surface.stop("stop");
  });

  test("caption preflight refuses before any SDK media send", async () => {
    const dir = await directory();
    const fake = fakeTelegramOwner();
    const runtime = mounted(fake, dir, "none",
      async () => ({ bytes: new Uint8Array(2), name: "sample", mime: "image/png" }));
    await runtime.surface.start("start");
    expect(await runtime.deliveryRoute?.("peer", {
      kind: "message", parts: [{ kind: "image", ref: "machine:x", caption: "x".repeat(1025) }],
    }, "caption")).toEqual({ value: "rejected" });
    expect(fake.sends).toHaveLength(0);
    await runtime.surface.stop("stop");
  });

  test("audio video and file each refuse above their declared byte ceiling", async () => {
    const dir = await directory();
    const fake = fakeTelegramOwner();
    const bytes = new Uint8Array(50_000_001);
    const runtime = mounted(fake, dir, "none",
      async () => ({ bytes, name: "sample", mime: "application/octet-stream" }));
    await runtime.surface.start("start");
    for (const part of [
      { kind: "audio", ref: "audio" },
      { kind: "video", ref: "video" },
      { kind: "file", ref: "file", name: "sample" },
    ] as const) {
      expect(await runtime.deliveryRoute?.("peer", { kind: "message", parts: [part] }, part.kind))
        .toMatchObject({ value: "rejected", reason: `media_too_large ${part.kind} 50000001>50000000` });
    }
    expect(fake.sends).toHaveLength(0);
    await runtime.surface.stop("stop");
  });

  test("terminal state immediately withdraws account, intake and history once", async () => {
    const dir = await directory();
    const fake = fakeTelegramOwner();
    const runtime = mounted(fake, dir);
    let admissions = 0;
    runtime.surface.onMessage(async () => { admissions += 1; });
    await runtime.surface.start("start");
    fake.emitState({ state: "login_action_required", action: "code" });
    fake.emitState({ state: "closed", reason: "session_lost" });
    fake.emitState({ state: "ready", userId: "owner-1" });
    fake.emit(ownerMessage);
    expect(runtime.account?.()).toBeUndefined();
    expect(await runtime.historyRoute?.({ chatId: "chat-1", limit: 1 }))
      .toEqual({ status: "refused", reason: "login_action_required" });
    expect(admissions).toBe(0);
    expect(fake.calls).not.toContain("history");
    await runtime.surface.stop("stop");
    expect(fake.calls.filter((call) => call === "unsubscribe-state")).toHaveLength(1);
    expect(fake.calls.filter((call) => call === "close")).toHaveLength(1);
  });

  test("an unconfirmed native close keeps session custody and reports the cleanup failure", async () => {
    const dir = await directory();
    const fake = fakeTelegramOwner({ onClose: async () => { throw new TelegramOwnerError("close unconfirmed", "session_lost"); } });
    const events: string[] = [];
    const arm = createTelegramProvider(undefined, fake.sdk).owner;
    const runtime = arm?.create(credentials, { intake: "none", autoReply: false },
      (_kind, event) => { events.push(JSON.stringify(event)); }, { ...injectedOptions(), telegramDataDir: dir });
    await runtime?.surface.start("start");
    await expect(runtime?.surface.stop("stop")).rejects.toMatchObject({ code: "session_lost" });
    expect((await lstat(join(dir, "session.lock"))).isDirectory()).toBe(true);
    expect(events.filter((event) => event.includes("telegram owner close unconfirmed; session custody retained"))).toHaveLength(1);
    expect(events.filter((event) => event.includes("telegram owner instance stopped"))).toEqual([]);
    await expect(telegramOwnerLogin({ credentials, dataDir: dir, prompt: async () => "x" }, fakeTelegramOwner().sdk))
      .rejects.toMatchObject({ code: "session_in_use" });
  });

  test("login keeps custody when native close is unconfirmed", async () => {
    const dir = await directory();
    const fake = fakeTelegramOwner({ onClose: async () => { throw new TelegramOwnerError("close unconfirmed", "session_lost"); } });
    await expect(telegramOwnerLogin({ credentials, dataDir: dir, prompt: async () => "x" }, fake.sdk))
      .rejects.toMatchObject({ code: "session_lost" });
    expect((await lstat(join(dir, "session.lock"))).isDirectory()).toBe(true);
  });

  test("a failed start with an unconfirmed close keeps the start cause and custody", async () => {
    const dir = await directory();
    const fake = fakeTelegramOwner({ states: [{ state: "phone" }], onClose: async () => { throw new Error("close unconfirmed"); } });
    const runtime = mounted(fake, dir);
    await expect(runtime.surface.start("start")).rejects.toMatchObject({ code: "login_action_required" });
    expect((await lstat(join(dir, "session.lock"))).isDirectory()).toBe(true);
  });

  test("terminal state before start resolves refuses mount and closes once", async () => {
    const dir = await directory();
    const fake = fakeTelegramOwner({ onStart: () => {
      fake.emitState({ state: "closed", reason: "session_lost" });
      fake.emit(ownerMessage);
    } });
    const runtime = mounted(fake, dir);
    await expect(runtime.surface.start("start")).rejects.toMatchObject({ code: "session_lost" });
    expect(runtime.account?.()).toBeUndefined();
    expect(fake.calls.filter((call) => call === "close")).toHaveLength(1);
    expect(fake.calls.filter((call) => call === "unsubscribe-state")).toHaveLength(1);
  });

  test("login follows all SDK steps and releases custody after awaited close", async () => {
    const dir = await directory();
    const states = ["phone", "code", "password", "email", "email_code", "ready"].map((state) =>
      state === "ready" ? { state: "ready" as const, userId: "owner-1" } :
        { state: state as "phone" | "code" | "password" | "email" | "email_code" });
    const fake = fakeTelegramOwner({ states });
    const actions: string[] = [];
    expect(await telegramOwnerLogin({
      credentials, dataDir: dir,
      prompt: async (action) => { actions.push(action); return "value"; },
    }, fake.sdk)).toEqual({ userId: "owner-1" });
    expect(actions).toEqual(["phone", "code", "password", "email", "email_code"]);
    expect(fake.calls.filter((call) => call.startsWith("authenticate:"))).toEqual([
      "authenticate:phone", "authenticate:code", "authenticate:password",
      "authenticate:email", "authenticate:emailCode",
    ]);
    expect(fake.calls.at(-1)).toBe("close");
    expect((await lstat(join(dir, "db"))).mode & 0o777).toBe(0o700);
    expect((await lstat(join(dir, "files"))).mode & 0o777).toBe(0o700);
    await expect(lstat(join(dir, "session.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("busy custody refuses before constructing a second client, symlinked directory refuses", async () => {
    const dir = await directory();
    const first = fakeTelegramOwner();
    const runtime = mounted(first, dir);
    await runtime.surface.start("start");
    const second = fakeTelegramOwner();
    await expect(telegramOwnerLogin({ credentials, dataDir: dir, prompt: async () => "x" }, second.sdk))
      .rejects.toMatchObject({ code: "session_in_use" });
    expect(second.calls).toEqual([]);
    await runtime.surface.stop("stop");
    const symlinkRoot = await directory();
    await symlink(dir, join(symlinkRoot, "link"));
    await expect(telegramOwnerLogin({ credentials, dataDir: join(symlinkRoot, "link"), prompt: async () => "x" }, second.sdk))
      .rejects.toMatchObject({ code: "session_lost" });
  });

  test("recovers only dead PID locks and refuses malformed PID locks", async () => {
    const dir = await directory();
    await mkdir(join(dir, "session.lock"));
    await writeFile(join(dir, "session.lock", "pid"), "not-a-pid");
    const fake = fakeTelegramOwner();
    await expect(telegramOwnerLogin({ credentials, dataDir: dir, prompt: async () => "x" }, fake.sdk))
      .rejects.toMatchObject({ code: "session_in_use" });
    expect(await readFile(join(dir, "session.lock", "pid"), "utf8")).toBe("not-a-pid");
    expect(fake.calls).toEqual([]);
  });

  test("recovers a provably dead PID and tightens existing private directories", async () => {
    const dir = await directory();
    await mkdir(join(dir, "db"), { mode: 0o755 });
    await mkdir(join(dir, "files"), { mode: 0o755 });
    await chmod(dir, 0o755);
    await mkdir(join(dir, "session.lock"));
    await writeFile(join(dir, "session.lock", "pid"), "999999999");
    const fake = fakeTelegramOwner();
    expect(await telegramOwnerLogin({ credentials, dataDir: dir, prompt: async () => "x" }, fake.sdk))
      .toEqual({ userId: "owner-1" });
    for (const path of [dir, join(dir, "db"), join(dir, "files")])
      expect((await lstat(path)).mode & 0o777).toBe(0o700);
  });

  test("refuses an existing symlinked DB and does not construct a client", async () => {
    const dir = await directory();
    const elsewhere = await directory();
    await symlink(elsewhere, join(dir, "db"));
    const fake = fakeTelegramOwner();
    await expect(telegramOwnerLogin({ credentials, dataDir: dir, prompt: async () => "x" }, fake.sdk))
      .rejects.toMatchObject({ code: "session_lost" });
    expect(fake.calls).toEqual([]);
  });

  test("failed PID publication removes the lock instead of holding the session", async () => {
    const dir = await directory();
    await expect(ownerSession(dir, async () => {
      throw new Error("disk full");
    })).rejects.toThrow("disk full");
    await expect(lstat(join(dir, "session.lock"))).rejects.toMatchObject({ code: "ENOENT" });
    const held = await ownerSession(dir);
    await held.release();
  });

  for (const [code, reason] of [
    ["session_lost", "session_lost"], ["session_in_use", "session_in_use"],
    ["unknown", "history_unavailable"],
  ] as const) {
    test(`history maps ${code} without leaking SDK detail`, async () => {
      const dir = await directory();
      const fake = fakeTelegramOwner({ onHistory: () => {
        throw new TelegramOwnerError("private path and credential", code);
      } });
      const runtime = mounted(fake, dir);
      await runtime.surface.start("start");
      expect(await runtime.historyRoute?.({ chatId: "chat-1", limit: 1 }))
        .toEqual({ status: "refused", reason });
      if (code === "session_lost") {
        expect(runtime.account?.()).toBeUndefined();
        expect(await runtime.historyRoute?.({ chatId: "chat-1", limit: 1 }))
          .toEqual({ status: "refused", reason: "session_lost" });
      }
      expect(fake.calls.filter((call) => call === "history")).toHaveLength(1);
      await runtime.surface.stop("stop");
    });
  }

  test("download checks malformed file references and the SDK's actual size", async () => {
    const dir = await directory();
    const fake: ReturnType<typeof fakeTelegramOwner> = fakeTelegramOwner({ onDownload: async () => ({
      size: 8, name: "larger", mime: "audio/ogg",
      chunks: (async function* (): AsyncGenerator<Uint8Array, void, void> { yield new Uint8Array(8); })(),
    }) });
    const runtime = mounted(fake, dir);
    await runtime.surface.start("start");
    const signal = new AbortController().signal;
    await expect(runtime.streamingAttachments?.("not-a-file-id", { maxBytes: 9, signal }))
      .rejects.toMatchObject({ code: "download_failed" });
    await expect(runtime.streamingAttachments?.("tdlib-file:12", { maxBytes: 7, signal }))
      .rejects.toMatchObject({ reason: "too_large" });
    expect(fake.calls.filter((call) => call === "download")).toHaveLength(1);
    await runtime.surface.stop("stop");
  });

  test("download session loss withdraws the account identity", async () => {
    const dir = await directory();
    const fake = fakeTelegramOwner({ onDownload: async () => {
      throw new TelegramOwnerError("revoked", "session_lost");
    } });
    const runtime = mounted(fake, dir);
    await runtime.surface.start("start");
    await expect(runtime.streamingAttachments?.("tdlib-file:7", {
      maxBytes: 8, signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "session_lost" });
    expect(runtime.account?.()).toBeUndefined();
    await runtime.surface.stop("stop");
  });

  test("send success preserves raw native reply, while an unobserved topic refuses before physical send", async () => {
    const dir = await directory();
    const fake = fakeTelegramOwner();
    const runtime = mounted(fake, dir);
    await runtime.surface.start("start");
    expect(await runtime.deliveryRoute?.("peer", Outbound.payload("hello"), "key-1",
      { channelId: "chat-7", replyToMessageId: "99" }))
      .toEqual({ value: "accepted", externalMessageId: "ack-1" });
    expect(fake.sends).toEqual([{
      chatId: "chat-7", content: { kind: "text", text: "hello", replyTo: "99" },
    }]);
    expect(await runtime.deliveryRoute?.("peer", Outbound.payload("hi"), "key-2",
      { channelId: "chat-7", threadId: "topic-7" }))
      .toMatchObject({ value: "rejected", reason: "thread_unavailable" });
    expect(fake.sends).toHaveLength(1);
    await runtime.surface.stop("stop");
  });

  test("oversize media is typed before physical send and bounded bytes use the SDK arm", async () => {
    const dir = await directory();
    const fake = fakeTelegramOwner();
    const runtime = mounted(fake, dir, "none",
      async (part) => ({
        bytes: new Uint8Array(part.ref === "large" ? 10_000_001 : 2),
        name: "photo.png", mime: "image/png",
      }));
    await runtime.surface.start("start");
    expect(await runtime.deliveryRoute?.("peer", { kind: "message",
      parts: [{ kind: "image", ref: "large" }] }, "large"))
      .toMatchObject({ value: "rejected", reason: "media_too_large image 10000001>10000000" });
    expect(await runtime.deliveryRoute?.("peer", { kind: "message",
      parts: [{ kind: "image", ref: "small" }] }, "small"))
      .toMatchObject({ value: "accepted" });
    expect(fake.sends).toEqual([{ chatId: "peer", content: {
      kind: "image", bytes: new Uint8Array(2), name: "photo.png", mime: "image/png",
    } }]);
    await runtime.surface.stop("stop");
  });

  test("login rejects unsupported states and missing identity without retaining lock", async () => {
    const dir = await directory();
    const fake = fakeTelegramOwner({ states: [{ state: "registration" as "phone" }] });
    await expect(telegramOwnerLogin({ credentials, dataDir: dir, prompt: async () => "x" }, fake.sdk))
      .rejects.toMatchObject({ code: "login_action_required" });
    expect(fake.calls.filter((call) => call === "close")).toHaveLength(1);
    const identityFree = fakeTelegramOwner({ states: [{ state: "ready" }] });
    await expect(telegramOwnerLogin({ credentials, dataDir: dir, prompt: async () => "x" }, identityFree.sdk))
      .rejects.toMatchObject({ code: "session_lost" });
    expect(identityFree.calls.filter((call) => call === "close")).toHaveLength(1);
  });
});
