import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AttachmentFetch } from "@oni/channels";
import { MachineRefusalError } from "@oni/machines";
import { Operational, type Channel, type Gateway } from "@oni/protocol";
import { type AttachmentInbox, inboxHandler, withAttachmentInbox } from "../src/composition/attachments";
import { MEDIA_BYTE_CAP, MediaRefused } from "../src/composition/media";
import type { FilePorts } from "../src/bundles/tools/core/filesystem";
import { eventSignal } from "./helpers/event-signal";

type ToolMachine = ReturnType<NonNullable<FilePorts["machines"]>["get"]>;
type Attachment = NonNullable<Gateway.IngressFacts["attachments"]>[number];

function inboundWith(
  attachments?: readonly Attachment[],
  facts: Partial<Gateway.IngressFacts> = {},
): Channel.InboundMessage {
  return {
    sender: { kind: "external", surface: "telegram:bot", externalId: "u1" },
    facts: {
      surface: "telegram:bot", channelId: "c1", eventId: "evt-1",
      addressees: [{ externalId: "bot-1" }], dm: false, payload: {}, render: "hi",
      ...(attachments === undefined ? {} : { attachments }),
      ...facts,
    },
  };
}

function harness(write?: ToolMachine["fs"]["write"]) {
  const written = new Map<string, Uint8Array>();
  const warnings: string[] = [];
  const unsupported = () => Promise.reject(new Error("not under test"));
  const machine: ToolMachine = {
    fs: {
      write: write ?? ((path, data) => {
        written.set(path, data);
        return Promise.resolve({ op: "write", bytesWritten: data.byteLength });
      }),
      read: unsupported, stat: unsupported, list: unsupported,
    },
    exec: unsupported,
    pty: { open: unsupported, write: unsupported, read: unsupported },
  };
  const inbox: AttachmentInbox = {
    root: "/inbox",
    files: { machines: { defaultMachine: "mac", get: () => machine } },
    media: () => Promise.resolve({ bytes: Buffer.from("png"), name: "a b.png", mime: "image/png" }),
    publish: (event, data) => {
      if (event.name === Operational.Events.Warn.name) {
        const err = Operational.Events.Warn.schema.parse(data).context?.err;
        if (typeof err !== "string") throw new Error("attachment warning missing error");
        warnings.push(err);
      }
    },
    now: () => 0,
  };
  const received: Channel.InboundMessage[] = [];
  const handler: Channel.MessageHandler = (message) => {
    received.push(message);
    return Promise.resolve();
  };
  return { written, warnings, inbox, received, handler };
}

const download: AttachmentFetch = (ref) =>
  Promise.resolve({ bytes: Buffer.from(ref), name: "report.pdf", mime: "application/pdf" });

test.each(["root", "machines"] as const)("an inbox without %s leaves the channel handler unwrapped", (missing) => {
  const { inbox } = harness();
  expect(inboxHandler(
    missing === "root" ? undefined : inbox.root,
    missing === "machines" ? undefined : inbox.files.machines,
    inbox.publish,
    inbox.now,
  )).toBeUndefined();
});

test("the configured inbox handler stores fetched attachments on the machine before delivery", async () => {
  const root = mkdtempSync(join(tmpdir(), "oni-inbox-"));
  try {
    const { inbox, received, handler, warnings } = harness(async (path, data, options) => {
      await writeFile(path, data, { flag: options?.create === "exclusive" ? "wx" : "w" });
      return { op: "write", bytesWritten: data.byteLength };
    });
    const machines = inbox.files.machines;
    if (machines === undefined) throw new Error("inbox test requires a machine");
    const factory = inboxHandler(root, machines, inbox.publish, inbox.now);
    if (factory === undefined) throw new Error("configured inbox handler missing");
    const wrapped = factory(download, handler);

    await wrapped(inboundWith([{ kind: "file", ref: "attachment-bytes" }]));

    const stored = received[0]?.facts.attachments?.[0];
    expect(stored?.ref).toMatch(new RegExp(`^mac:${root}/[a-f0-9]{64}-report\\.pdf$`));
    expect(stored).toMatchObject({ name: "report.pdf", mime: "application/pdf", bytes: 16 });
    expect(await readFile(stored?.ref.slice("mac:".length) ?? "")).toEqual(Buffer.from("attachment-bytes"));
    expect(warnings).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("provider bytes and MIME reach the machine before the handler completes", async () => {
  const entered = eventSignal<void>("write entered");
  const completed = eventSignal<void>("handler completed");
  const release = Promise.withResolvers<void>();
  const order: string[] = [];
  const { inbox, received, handler, warnings } = harness(async (_path, data, options) => {
    expect(options).toEqual({ create: "exclusive" });
    order.push("write entered");
    entered.resolve();
    await release.promise;
    order.push("write completed");
    return { op: "write", bytesWritten: data.byteLength };
  });
  const running = withAttachmentInbox(inbox, download, async (message) => {
    order.push("handler");
    await handler(message);
    completed.resolve();
  })(inboundWith([{ kind: "file", ref: "doc" }]));
  try {
    await entered.promise;
    expect(received).toEqual([]);
    expect(order).toEqual(["write entered"]);
  } finally {
    release.resolve();
  }
  await completed.promise;
  await running;
  expect(order).toEqual(["write entered", "write completed", "handler"]);
  expect(received[0]?.facts.attachments?.[0]).toMatchObject({
    mime: "application/pdf", name: "report.pdf", bytes: 3,
  });
  expect(warnings).toEqual([]);
});

test("public downloads keep returned MIME and bound an unsafe display filename", async () => {
  const { written, inbox, received, handler } = harness();
  await withAttachmentInbox({
    ...inbox,
    media: () => Promise.resolve({
      bytes: Buffer.from("png"), name: `../../${"x".repeat(400)}.png`, mime: "image/png",
    }),
  }, undefined, handler)(inboundWith([{ kind: "image", ref: "https://cdn.example/image" }]));
  const [path] = written.keys();
  expect(path).toMatch(/^\/inbox\/[a-f0-9]{64}-[A-Za-z0-9._-]+$/);
  expect(path?.slice("/inbox/".length).length).toBeLessThanOrEqual(185);
  expect(received[0]?.facts.attachments?.[0]).toMatchObject({
    ref: `mac:${path}`, mime: "image/png",
  });
});

test.each([download, undefined])("explicit inbound MIME outranks fetched MIME", async (fetchRef) => {
  const { inbox, received, handler } = harness();
  await withAttachmentInbox(inbox, fetchRef, handler)(inboundWith([
    { kind: "file", ref: "https://cdn.example/a", mime: "text/plain" },
  ]));
  expect(received[0]?.facts.attachments?.[0]?.mime).toBe("text/plain");
});

test("equal message IDs and names in different chats retain both byte sets", async () => {
  const { written, inbox, received, handler } = harness();
  const wrapped = withAttachmentInbox(inbox, download, handler);
  await wrapped(inboundWith([{ kind: "file", ref: "first", name: "report.pdf" }], { channelId: "chat-1" }));
  await wrapped(inboundWith([{ kind: "file", ref: "second", name: "report.pdf" }], { channelId: "chat-2" }));
  const refs = received.map((message) => message.facts.attachments?.[0]?.ref);
  expect(new Set(refs).size).toBe(2);
  expect([...written.values()].map((bytes) => Buffer.from(bytes).toString())).toEqual(["first", "second"]);
  for (const [index, ref] of refs.entries()) {
    expect(ref?.startsWith("mac:/inbox/")).toBe(true);
    expect(written.get(ref?.slice(4) ?? "")).toEqual(Buffer.from(index === 0 ? "first" : "second"));
  }
});

test("storage identity includes surface, receiver, workspace, channel, event, index and original ref", async () => {
  const { written, inbox, handler } = harness();
  const wrapped = withAttachmentInbox(inbox, download, handler);
  const attachment: Attachment = { kind: "file", ref: "same", name: "report.pdf" };
  for (const facts of [
    {}, { surface: "slack:bot" }, { receivedBy: "owner" as const }, { workspaceId: "w1" },
    { channelId: "c2" }, { eventId: "evt-2" },
  ]) await wrapped(inboundWith([attachment], facts));
  await wrapped(inboundWith([{ ...attachment, ref: "different" }, attachment]));
  expect(written.size).toBe(8);
});

test("mixed fetch and write refusals keep order and hand off once", async () => {
  const refused = new MachineRefusalError({ reason: "already_exists", message: "occupied inbox leaf" });
  const { inbox, received, warnings, handler } = harness((_path, data) =>
    Buffer.from(data).toString() === "write-fails"
      ? Promise.reject(refused)
      : Promise.resolve({ op: "write", bytesWritten: data.byteLength }),
  );
  const attachments: Attachment[] = ["first", "fetch-fails", "write-fails", "last"]
    .map((ref) => ({ kind: "file", ref }));
  await withAttachmentInbox(inbox, (ref, bounds) =>
    ref === "fetch-fails"
      ? Promise.reject(new MediaRefused({ code: "fetch_failed", ref, detail: "HTTP 401" }))
      : download(ref, bounds), handler)(inboundWith(attachments));
  expect(received).toHaveLength(1);
  expect(received[0]?.facts.attachments?.map((attachment) => attachment.ref)).toEqual([
    expect.stringMatching(/^mac:\/inbox\//), "fetch-fails", "write-fails",
    expect.stringMatching(/^mac:\/inbox\//),
  ]);
  expect(received[0]?.facts.attachments?.slice(1, 3)).toEqual(attachments.slice(1, 3));
  expect(warnings).toHaveLength(2);
  expect(warnings[0]).toContain("OniMediaRefused");
  expect(warnings[1]).toContain("occupied inbox leaf");
});

test.each(["provider", "public"])("oversized %s bytes keep the original ref with one warning", async (path) => {
  const { inbox, written, warnings, received, handler } = harness();
  const bytes = new Uint8Array(MEDIA_BYTE_CAP + 1);
  const fetchRef: AttachmentFetch = () => Promise.resolve({ bytes, name: "large", mime: "application/pdf" });
  const attachment: Attachment = { kind: "file", ref: "https://cdn.example/large" };
  await withAttachmentInbox({ ...inbox, media: () => fetchRef(attachment.ref, {
    maxBytes: MEDIA_BYTE_CAP, signal: new AbortController().signal,
  }) }, path === "provider" ? fetchRef : undefined, handler)(inboundWith([attachment]));
  expect(written.size).toBe(0);
  expect(received[0]?.facts.attachments).toEqual([attachment]);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("OniMediaRefused");
});

test("the attachment deadline reaches the provider and releases the handler on typed refusal", async () => {
  const { inbox, received, warnings, handler } = harness();
  const controller = new AbortController();
  const entered = eventSignal<void>("download entered");
  const attachment: Attachment = { kind: "file", ref: "slow" };
  const wrapped = withAttachmentInbox({ ...inbox, downloadSignal: () => controller.signal }, (ref, bounds) => {
    expect(bounds.maxBytes).toBe(MEDIA_BYTE_CAP);
    expect(bounds.signal).toBe(controller.signal);
    return new Promise((_resolve, reject) => {
      bounds.signal.addEventListener("abort", () =>
        reject(new MediaRefused({ code: "fetch_failed", ref, detail: "deadline exceeded" })), { once: true });
      entered.resolve();
    });
  }, handler);
  const running = wrapped(inboundWith([attachment]));
  await entered.promise;
  expect(received).toEqual([]);
  controller.abort();
  await running;
  expect(received[0]?.facts.attachments).toEqual([attachment]);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("OniMediaRefused");
});

test("an opaque reference without a downloader passes through untouched", async () => {
  const { written, warnings, inbox, received, handler } = harness();
  const attachment: Attachment = { kind: "file", ref: "opaque-ref" };
  await withAttachmentInbox(inbox, undefined, handler)(inboundWith([attachment]));
  expect(written.size).toBe(0);
  expect(warnings).toEqual([]);
  expect(received[0]?.facts.attachments).toEqual([attachment]);
});

test.each([{ attachments: undefined }, { attachments: [] }])("missing or empty attachments pass the same message through", async ({ attachments }) => {
  const { inbox, received, handler } = harness();
  const message = inboundWith(attachments);
  await withAttachmentInbox(inbox, undefined, handler)(message);
  expect(received).toEqual([message]);
  expect(received[0]).toBe(message);
});
