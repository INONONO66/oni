import { beforeAll, expect, test } from "bun:test";
import { Fiber } from "effect";
import { exit, fork } from "./helpers/effect";
import { Machine } from "@oni/protocol";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wireDaemon, wireHost } from "./helpers";
import { mclientBinary } from "./helpers/mclient";
import { offer } from "./helpers";
import { createFsDriver } from "./helpers/native";
import { connectIpcClient } from "./ipc/helpers/native";
import { socketPath } from "./helpers/socket-path";

type Host = Awaited<ReturnType<typeof wireHost>>;
async function fixture(run: (
  root: string, write: ReturnType<Host["get"]>["fs"]["writeStream"],
  host: Host, daemon: Awaited<ReturnType<typeof wireDaemon>>,
) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "oni-stream-write-"));
  const host = await wireHost(socketPath());
  const daemon = await wireDaemon(host, root);
  try {
    await run(root, host.get("m-1").fs.writeStream, host, daemon);
  } finally {
    await daemon.close();
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
}
beforeAll(mclientBinary, 300_000);

async function* bytes(parts: readonly Uint8Array[]): AsyncGenerator<Uint8Array, void, void> {
  for (const part of parts) yield part;
}
const bounds = (size: number, maxBytes = size || 1, signal = new AbortController().signal) =>
  ({ create: "exclusive" as const, expectedBytes: size, maxBytes, signal });
const digest = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

test("stream writes more than 50 MiB without a complete-file allocation", async () => {
  await fixture(async (root, write) => {
    const part = Buffer.alloc(Machine.FS_WRITE_MAX_BYTES * 3 + 17, 0x7b);
    const count = 67;
    const hash = createHash("sha256");
    async function* producer(): AsyncGenerator<Uint8Array, void, void> {
      for (let i = 0; i < count; i += 1) {
        hash.update(part);
        yield part;
      }
    }
    const size = part.length * count;
    const receipt = await write(join(root, "large"), producer(), bounds(size));
    expect(receipt).toEqual({ op: "write", bytesWritten: size, sha256: hash.digest("hex") });
    const disk = Bun.file(join(root, "large")).stream().getReader();
    const onDisk = createHash("sha256");
    let observed = 0;
    for (;;) {
      const result = await disk.read();
      if (result.done) break;
      observed += result.value.byteLength;
      onDisk.update(result.value);
    }
    expect(observed).toBe(size);
    expect(onDisk.digest("hex")).toBe(receipt.sha256);
    expect(readdirSync(root)).toEqual(["large"]);
  });
}, 30_000);

test("empty and varied producer chunks finish with verified size and digest", async () => {
  await fixture(async (root, write) => {
    const empty = await write(join(root, "empty"), bytes([]), bounds(0));
    expect(empty).toEqual({ op: "write", bytesWritten: 0, sha256: digest(Buffer.alloc(0)) });
    const pieces = [Buffer.alloc(0), Buffer.alloc(262_145, 3), Buffer.alloc(524_289, 7), Buffer.from("end")];
    const expected = createHash("sha256");
    for (const piece of pieces) expected.update(piece);
    const size = pieces.reduce((total, part) => total + part.byteLength, 0);
    expect(await write(join(root, "parts"), bytes(pieces), bounds(size))).toEqual({
      op: "write", bytesWritten: size, sha256: expected.digest("hex"),
    });
    expect(readFileSync(join(root, "parts")).byteLength).toBe(size);
    expect(readdirSync(root).sort()).toEqual(["empty", "parts"]);
  });
});

test.each(["short", "long", "quota", "throw", "pre-abort", "bad-bounds"])("stream %s fails without publishing or leaving staging", async (kind) => {
  await fixture(async (root, write) => {
    const destination = join(root, "target");
    const controller = new AbortController();
    if (kind === "pre-abort") controller.abort();
    async function* producer(): AsyncGenerator<Uint8Array, void, void> {
      yield Buffer.from("hello");
      if (kind === "throw") throw new Error("producer failed");
      if (kind === "long" || kind === "quota") yield Buffer.from("!");
    }
    const expected = kind === "short" ? 6 : 5;
    const max = kind === "quota" ? 5 : kind === "bad-bounds" ? Number.POSITIVE_INFINITY : 6;
    await expect(write(destination, producer(), bounds(expected, max, controller.signal)))
      .rejects.toMatchObject(kind === "quota"
        ? { _tag: "MachineRefusalError", reason: "too_large" }
        : kind === "throw" ? { _tag: "MachinesFailure", operation: "fs.stream.producer" }
        : { _tag: "MachineRefusalError", reason: kind === "pre-abort" ? "closed" : "invalid_response" });
    expect(readdirSync(root)).toEqual([]);
  });
});

test("exclusive destination, symlink escape, and export escape never publish", async () => {
  await fixture(async (root, write) => {
    writeFileSync(join(root, "occupied"), "prior");
    symlinkSync("/tmp", join(root, "outside"));
    for (const destination of [join(root, "occupied"), join(root, "outside", "new"), "/tmp/outside-export"]) {
      await expect(write(destination, bytes([Buffer.from("new")]), bounds(3)))
        .rejects.toMatchObject({ _tag: "MachineRefusalError" });
    }
    expect(readFileSync(join(root, "occupied"), "utf8")).toBe("prior");
    expect(readdirSync(root).sort()).toEqual(["occupied", "outside"]);
  });
});

test("exclusive publication refuses a destination created after begin", async () => {
  await fixture(async (root, write) => {
    const destination = join(root, "race");
    async function* producer(): AsyncGenerator<Uint8Array, void, void> {
      yield Buffer.from("payload");
      writeFileSync(destination, "winner");
    }
    await expect(write(destination, producer(), bounds(7))).rejects.toMatchObject({
      _tag: "MachineRefusalError", reason: "already_exists",
    });
    expect(readFileSync(destination, "utf8")).toBe("winner");
    expect(readdirSync(root)).toEqual(["race"]);
  });
});

test.each(["abort", "detach then abort"] as const)(
  "%s during a blocked producer cancels without waiting and releases the producer", async (stop) => {
  await fixture(async (root, write, _host, daemon) => {
    const controller = new AbortController();
    const { chunks, pulling, counter } = blockedProducer();
    const result = write(join(root, "blocked"), chunks, bounds(1, 1, controller.signal));
    await pulling;
    if (stop === "detach then abort") await daemon.close();
    controller.abort();
    await expect(result).rejects.toMatchObject({ _tag: "MachineRefusalError", reason: "closed" });
    expect(counter.returned).toBe(1);
    expect(readdirSync(root)).toEqual([]);
  });
});

type Fault = "ack_seq" | "ack_bytes" | "ack_last" | "begin_seq" | "digest" | "lost_finish" | "blocked_ack" | "detach" | "disk_full";
async function connectStream(
  path: string, root: string,
  handle: (request: Machine.FsStreamRequest, respond: (answer: Machine.FsStreamResult) => void) => Promise<void>,
) {
  const client = await connectIpcClient(path, {
    onRequest: (method, params, respond) => {
      if (method !== Machine.WireMethod.FsStream) throw new Error(`unexpected ${method}`);
      return handle(Machine.FsStreamRequest.parse(params), respond);
    },
  });
  expect(await client.call(Machine.WireMethod.Attach, {
    ...offer(root), peer: { kind: "daemon", contractVersion: Machine.contractVersion },
  })).toMatchObject({ status: "attached" });
  return client;
}

async function closeStream(
  root: string, host: Host, driver: ReturnType<typeof createFsDriver>,
  client: Awaited<ReturnType<typeof connectIpcClient>>,
) {
  driver.abortAll();
  driver.close();
  await client.close();
  await host.close();
  rmSync(root, { recursive: true, force: true });
}

function faultResponse(request: Machine.FsStreamRequest, answer: Machine.FsStreamResult, fault: Fault): Machine.FsStreamResult {
  if (request.op === "begin" && answer.status === "begun" && fault === "begin_seq") return { ...answer, seq: 1 };
  if (request.op !== "write" || request.last || answer.status !== "written") return answer;
  if (fault === "ack_seq") return { ...answer, seq: answer.seq + 1 };
  if (fault === "ack_bytes") return { ...answer, bytesWritten: answer.bytesWritten + 1 };
  if (fault === "ack_last") return { ...answer, last: true };
  return answer;
}
test.each(["ack_seq", "ack_bytes", "ack_last", "begin_seq", "digest", "lost_finish", "blocked_ack", "detach", "disk_full"] as const)(
  "stream %s preserves typed uncertainty and removes unpublished staging", async (fault: Fault) => {
    const root = mkdtempSync(join(tmpdir(), "oni-stream-fault-"));
    const path = socketPath();
    const host = await wireHost(path);
    const driver = createFsDriver(new Map([["docs", root]]));
    const controller = new AbortController();
    const { promise: ackEntered, resolve: entered } = Promise.withResolvers<void>();
    const client = await connectStream(path, root, async (request, respond) => {
        if (request.op === "write" && !request.last && (fault === "blocked_ack" || fault === "detach")) {
          entered();
          return;
        }
        if (request.op === "write" && !request.last && fault === "disk_full") {
          respond({ status: "refused", reason: "io_error", message: "write failed: ENOSPC" });
          return;
        }
        const answer = await driver.stream(request.op === "write" && request.last && fault === "digest"
          ? { ...request, digest: "0".repeat(64) } : request);
        if (request.op === "finish" && fault === "lost_finish") {
          await client.close();
          return;
        }
        respond(faultResponse(request, answer, fault));
    });
    try {
      const destination = join(root, "target");
      const pending = host.get("m-1").fs.writeStream(destination, bytes([Buffer.from("payload")]), bounds(7, 7, controller.signal));
      if (fault === "blocked_ack" || fault === "detach") {
        await ackEntered;
        if (fault === "blocked_ack") controller.abort();
        else { driver.abortAll(); await client.close(); }
      }
      await expect(pending).rejects.toMatchObject({
        _tag: "MachineRefusalError",
        reason: fault === "blocked_ack" ? "closed" : fault === "detach" || fault === "lost_finish" ? "disconnected" : fault === "disk_full" ? "io_error" : fault === "digest" ? "digest_mismatch" : "invalid_response",
      });
      if (fault !== "lost_finish") expect(readdirSync(root)).toEqual([]);
      else {
        expect(readFileSync(destination, "utf8")).toBe("payload");
        expect(readdirSync(root)).toEqual(["target"]);
      }
    } finally {
      await closeStream(root, host, driver, client);
    }
  },
);

function blockedProducer() {
  const { promise: pulling, resolve: entered } = Promise.withResolvers<void>();
  const counter = { returned: 0 };
  const chunks: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return {
        next: () => { entered(); return new Promise<IteratorResult<Uint8Array>>(() => undefined); },
        return: () => { counter.returned += 1; return new Promise<IteratorResult<Uint8Array>>(() => undefined); },
      };
    },
  };
  return { chunks, pulling, counter };
}

test("caller interruption during a blocked producer aborts the transfer and releases the producer", async () => {
  await fixture(async (root, _write, host) => {
    const { chunks, pulling, counter } = blockedProducer();
    const fiber = fork(host.native.get("m-1").fs.writeStream(join(root, "interrupted"), chunks, bounds(1)));
    await pulling;
    await exit(Fiber.interrupt(fiber));
    expect(counter.returned).toBe(1);
    expect(readdirSync(root)).toEqual([]);
  });
});

test("a held write acknowledgment stops the producer until the machine acknowledges the chunk", async () => {
  const root = mkdtempSync(join(tmpdir(), "oni-stream-ack-"));
  const path = socketPath();
  const host = await wireHost(path);
  const driver = createFsDriver(new Map([["docs", root]]));
  const { promise: ackHeld, resolve: held } = Promise.withResolvers<() => void>();
  let holding = true;
  const client = await connectStream(path, root, async (request, respond) => {
      const answer = await driver.stream(request);
      if (request.op === "write" && !request.last && holding) {
        holding = false;
        held(() => respond(answer));
        return;
      }
      respond(answer);
  });
  try {
    const part = Buffer.alloc(1_000, 0x41);
    const count = 4;
    let pulls = 0;
    async function* producer(): AsyncGenerator<Uint8Array, void, void> {
      for (let index = 0; index < count; index += 1) {
        pulls += 1;
        yield part;
      }
    }
    const pending = host.get("m-1").fs.writeStream(join(root, "acked"), producer(), bounds(part.length * count));
    const release = await ackHeld;
    expect(pulls).toBe(1);
    release();
    expect((await pending).bytesWritten).toBe(part.length * count);
    expect(pulls).toBe(count);
    expect(readFileSync(join(root, "acked")).byteLength).toBe(part.length * count);
  } finally {
    await closeStream(root, host, driver, client);
  }
});
