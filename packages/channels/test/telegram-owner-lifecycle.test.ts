import { afterEach, expect, spyOn, test } from "bun:test";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Outbound } from "@oni/protocol";
import { ownerSession } from "../src/provider/telegram/owner-custody";
import * as custody from "../src/provider/telegram/owner-custody";
import { TelegramOwnerError } from "../src/provider/telegram/owner-sdk";
import { fakeTelegramOwner, ownerMessage, ownerRuntime } from "./helpers/telegram-owner-sdk";

const directories: string[] = [];
afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});

async function fixture(script: Parameters<typeof fakeTelegramOwner>[0] = {}) {
  const directory = await mkdtemp(join(tmpdir(), "telegram-lifecycle-"));
  directories.push(directory);
  const fake = fakeTelegramOwner(script);
  const runtime = ownerRuntime(fake.sdk, directory);
  runtime.surface.onMessage(async () => undefined);
  return { directory, fake, runtime };
}

test("custody contenders never replace the stable lock inode", async () => {
  const { directory } = await fixture();
  const first = await ownerSession(directory);
  const lock = join(directory, "session.lock");
  const inode = (await lstat(lock)).ino;
  await first.release();
  const contenders = await Promise.allSettled([ownerSession(directory), ownerSession(directory)]);
  const winners = contenders.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  try {
    expect(winners).toHaveLength(1);
    expect(await lstat(lock)).toMatchObject({ ino: inode });
    expect((await lstat(lock)).isFile()).toBe(true);
    await first.release();
    await expect(ownerSession(directory)).rejects.toMatchObject({ code: "session_in_use" });
  } finally {
    for (const holder of winners) await holder.release();
  }
});

test("process death releases custody without replacing the lock file", async () => {
  const { directory } = await fixture();
  const held = Promise.withResolvers<void>();
  const module = new URL("../src/provider/telegram/owner-custody.ts", import.meta.url).href;
  const child = Bun.spawn([process.execPath, "--eval", `
    import { ownerSession } from ${JSON.stringify(module)};
    await ownerSession(process.argv[1]);
    process.send?.("held");
    process.on("message", () => process.exit(0));
  `, directory], {
    stdin: "ignore", stdout: "ignore", stderr: "inherit",
    ipc: (message: string) => { if (message === "held") held.resolve(); },
  });
  try {
    await held.promise;
    const lock = join(directory, "session.lock");
    const inode = (await lstat(lock)).ino;
    await expect(ownerSession(directory)).rejects.toMatchObject({ code: "session_in_use" });
    child.kill("SIGKILL");
    await child.exited;
    const recovered = await ownerSession(directory);
    try {
      expect((await lstat(lock)).ino).toBe(inode);
      await expect(ownerSession(directory)).rejects.toMatchObject({ code: "session_in_use" });
    } finally {
      await recovered.release();
    }
  } finally {
    child.kill();
    await child.exited;
  }
});

test.each(["before acquisition", "after acquisition"] as const)(
  "stop %s joins custody without creating a late client", async (boundary) => {
  const { runtime, fake, directory } = await fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const acquire = custody.ownerSession;
  const delayed = spyOn(custody, "ownerSession").mockImplementation(async (path) => {
    const session = await acquire(path);
    entered.resolve();
    await release.promise;
    return session;
  });
  try {
    const starting = runtime.surface.start("start").then(() => "started", () => "refused");
    if (boundary === "after acquisition") await entered.promise;
    const stopping = runtime.surface.stop("stop");
    release.resolve();
    await stopping;
    expect(await starting).toBe("refused");
    expect(fake.calls).toEqual([]);
    expect(runtime.account?.()).toBeUndefined();
    expect(await runtime.historyRoute?.({ chatId: "33", limit: 1 }))
      .toEqual({ status: "refused", reason: "owner_not_ready" });
    expect(await runtime.deliveryRoute?.("33", Outbound.payload("late"), "late"))
      .toEqual({ value: "rejected" });
    const released = await acquire(directory);
    await released.release();
  } finally {
    release.resolve();
    delayed.mockRestore();
  }
});

test("a retained topic receipt survives topic and reply cache eviction", async () => {
  const { runtime, fake } = await fixture({
    onSend: async () => { throw new TelegramOwnerError("reply lost", "unknown"); },
  });
  await runtime.surface.start("start");
  try {
    fake.emit({ ...ownerMessage, botMessageId: "42", threadId: "forum:7", botThreadId: "7" });
    const conversation = { channelId: ownerMessage.chatId, threadId: "7", replyToMessageId: "42" };
    const payload = Outbound.payload("message");
    expect(await runtime.deliveryRoute?.("peer", payload, "lost", conversation)).toEqual({ value: "unknown" });
    for (let n = 100; n < 4197; n++) {
      fake.emit({
        ...ownerMessage, messageId: String(n * 1048576), botMessageId: String(n),
        threadId: `forum:${n}`, botThreadId: String(n),
      });
    }
    expect(await runtime.deliveryRoute?.("peer", payload, "lost", conversation)).toEqual({ value: "unknown" });
    expect(await runtime.deliveryRoute?.("peer", payload, "new", conversation))
      .toEqual({ value: "rejected", reason: "thread_unavailable" });
    expect(fake.sends).toHaveLength(1);
  } finally {
    await runtime.surface.stop("stop");
  }
});

test("a repeated start does not close its incumbent and a fresh lifecycle closes independently", async () => {
  const { runtime, fake, directory } = await fixture();
  const starting = runtime.surface.start("start");
  expect(runtime.surface.start("same-start")).toBe(starting);
  await starting;
  await expect(runtime.surface.start("duplicate")).rejects.toMatchObject({ code: "session_in_use" });
  expect(fake.calls).not.toContain("close");
  for (const phase of ["first", "second"]) {
    if (phase === "second") await runtime.surface.start("restart");
    await runtime.surface.stop(phase);
    expect(runtime.account?.()).toBeUndefined();
    const released = await ownerSession(directory);
    await released.release();
  }
  expect(fake.calls.filter((call) => call === "close")).toHaveLength(2);
});
