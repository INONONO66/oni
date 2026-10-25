import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AttachmentFetchWithStream } from "@oni/channels";
import { Operational, type Channel, type Gateway } from "@oni/protocol";
import { Machine } from "@oni/protocol";
import { wireDaemon, wireHost } from "../../../packages/machines/test/helpers";
import { inboxStreamWriter } from "../src/composition/attachment-stream";
import { inboxHandler, OWNER_INBOX_BYTE_CAP, withAttachmentInbox } from "../src/composition/attachments";
import type { AttachmentInbox } from "../src/composition/attachments";
import { runEffect } from "./helpers/effect";
import { socketPath } from "./helpers/socket-path";

const attachment: NonNullable<Gateway.IngressFacts["attachments"]>[number] = {
  kind: "file", ref: "tdlib-file:71", name: "large.bin",
};

function inbound(): Channel.InboundMessage {
  return {
    sender: { kind: "external", surface: "telegram:owner", externalId: "sender" },
    facts: {
      surface: "telegram:owner", channelId: "chat", eventId: "evt-stream",
      receivedBy: "owner", addressees: [{ externalId: "owner" }],
      dm: true, payload: {}, render: "attached", attachments: [attachment],
    },
  };
}

test("streamed Owner attachment crosses the real host and daemon before one inbound handoff", async () => {
  const root = mkdtempSync(join(tmpdir(), "oni-inbox-stream-"));
  const host = await wireHost(socketPath());
  const daemon = await wireDaemon(host.endpoints.unix ?? "", root);
  try {
    const chunk = Buffer.alloc(Machine.FS_WRITE_MAX_BYTES * 3 + 17, 0x5a);
    const count = 67;
    const size = count * chunk.length;
    expect(size).toBeGreaterThan(50 * 1024 * 1024);
    const digest = createHash("sha256");
    const observed: Channel.InboundMessage[] = [];
    const warnings: string[] = [];
    let pulled = 0;
    const stream: AttachmentFetchWithStream = async (_ref, bounds) => {
      expect(bounds.maxBytes).toBe(OWNER_INBOX_BYTE_CAP);
      return {
        name: "large.bin", mime: "application/octet-stream", size,
        chunks: (async function* (): AsyncGenerator<Uint8Array, void, void> {
          for (let index = 0; index < count; index += 1) {
            pulled += 1;
            digest.update(chunk);
            yield chunk;
          }
        })(),
      };
    };
    const files: AttachmentInbox["files"] = {
      machines: { defaultMachine: "m-1", get: () => { throw new Error("buffered write must not run"); } },
    };
    const routes = inboxHandler(root, files.machines, (event, payload) => {
      if (event.name === Operational.Events.Warn.name) warnings.push(String(payload));
    }, () => 0, async (message) => { observed.push(message); }, inboxStreamWriter(host.native, "m-1", runEffect));
    if (routes.inbox === undefined) throw new Error("inbox was not configured");
    await routes.inbox(undefined, routes.handler, stream)(inbound());
    expect(pulled).toBe(count);
    expect(warnings).toEqual([]);
    expect(observed).toHaveLength(1);
    const stored = observed[0]?.facts.attachments?.[0];
    expect(stored?.bytes).toBe(size);
    expect(stored?.ref).toMatch(/^m-1:\/.+\/[a-f0-9]{64}-large\.bin$/);
    const diskHash = createHash("sha256");
    let diskBytes = 0;
    const reader = Bun.file(stored?.ref.slice(4) ?? "").stream().getReader();
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      diskHash.update(result.value);
      diskBytes += result.value.byteLength;
    }
    expect(diskBytes).toBe(size);
    expect(diskHash.digest("hex")).toBe(digest.digest("hex"));
    expect(readdirSync(root)).toHaveLength(1);
  } finally {
    await daemon.close();
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test("missing stream writer retains the platform reference with one warning and no buffered fallback", async () => {
  const root = mkdtempSync(join(tmpdir(), "oni-inbox-no-writer-"));
  try {
    const received: Channel.InboundMessage[] = [];
    const warnings: string[] = [];
    const inbox: AttachmentInbox = {
      root,
      files: { machines: { defaultMachine: "m-1", get: () => { throw new Error("buffer fallback"); } } },
      media: async () => { throw new Error("public fallback"); },
      publish: (event) => { if (event.name === Operational.Events.Warn.name) warnings.push(event.name); },
      now: () => 0,
    };
    await withAttachmentInbox(inbox, async (message) => { received.push(message); })(inbound(), undefined, async () => ({
      size: 3, mime: "application/octet-stream", name: "blocked.bin",
      chunks: (async function* (): AsyncGenerator<Uint8Array, void, void> { yield Buffer.from("bad"); })(),
    }));
    expect(received[0]?.facts.attachments).toEqual([attachment]);
    expect(warnings).toHaveLength(1);
    expect(readdirSync(root)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.each(["oversize", "short", "abort"] as const)(
  "real streamed inbox %s retains its reference without a published file",
  async (kind) => {
    const root = mkdtempSync(join(tmpdir(), `oni-inbox-${kind}-`));
    const host = await wireHost(socketPath());
    const daemon = await wireDaemon(host.endpoints.unix ?? "", root);
    try {
      const controller = new AbortController();
      const entered = Promise.withResolvers<void>();
      const received: Channel.InboundMessage[] = [];
      const warnings: string[] = [];
      const inbox: AttachmentInbox = {
        root,
        files: { machines: { defaultMachine: "m-1", get: () => { throw new Error("buffered fallback"); } } },
        media: async () => { throw new Error("public fallback"); },
        streams: inboxStreamWriter(host.native, "m-1", runEffect),
        downloadSignal: () => controller.signal,
        publish: (event) => { if (event.name === Operational.Events.Warn.name) warnings.push(event.name); },
        now: () => 0,
      };
      const stream: AttachmentFetchWithStream = async (_ref, _bounds) => ({
        name: "failed.bin", mime: "application/octet-stream",
        size: kind === "oversize" ? OWNER_INBOX_BYTE_CAP + 1 : 4,
        chunks: (async function* (): AsyncGenerator<Uint8Array, void, void> {
          if (kind === "oversize") throw new Error("source must not be pulled");
          yield Buffer.from("abc");
          if (kind === "abort") {
            entered.resolve();
            await new Promise<void>(() => undefined);
          }
        })(),
      });
      const pending = withAttachmentInbox(inbox, async (message) => { received.push(message); })(inbound(), undefined, stream);
      if (kind === "abort") {
        await entered.promise;
        controller.abort();
      }
      await pending;
      expect(received[0]?.facts.attachments).toEqual([attachment]);
      expect(warnings).toHaveLength(1);
      expect(readdirSync(root)).toEqual([]);
    } finally {
      await daemon.close();
      await host.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
