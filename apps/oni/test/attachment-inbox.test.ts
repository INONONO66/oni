import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AttachmentFetch } from "@oni/channels";
import { MachineRefusalError } from "@oni/machines";
import { Operational, type Channel, type Gateway } from "@oni/protocol";
import { type AttachmentInbox, inboxHandler, withAttachmentInbox } from "../src/composition/attachments";
import { MEDIA_BYTE_CAP, MediaRefused, createMediaResolver } from "../src/composition/media";
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
      write: write ?? ((path, data, options) => {
        if (options?.create === "exclusive" && written.has(path))
          return Promise.reject(new MachineRefusalError({ reason: "already_exists", message: `occupied ${path}` }));
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

test.each(["root", "machines"] as const)("an inbox without %s leaves the channel handler unwrapped", async (missing) => {
  const { inbox, received, handler } = harness();
  const routing = inboxHandler(
    missing === "root" ? undefined : inbox.root,
    missing === "machines" ? undefined : inbox.files.machines,
    inbox.publish,
    inbox.now,
    handler,
  );
  expect(routing.inbox).toBeUndefined();
  const message = inboundWith([{ kind: "file", ref: "opaque" }]);
  await routing.handler(message);
  await routing.handler(message);
  expect(received).toEqual([message]);
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
    const routing = inboxHandler(root, machines, inbox.publish, inbox.now, handler);
    if (routing.inbox === undefined) throw new Error("configured inbox missing");
    expect(routing.inbox(undefined, routing.handler)).toBe(routing.handler);

    await routing.inbox(download, routing.handler)(inboundWith([{ kind: "file", ref: "attachment-bytes" }]));

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
  const running = withAttachmentInbox(inbox, async (message) => {
    order.push("handler");
    await handler(message);
    completed.resolve();
  })(inboundWith([{ kind: "file", ref: "doc" }]), download);
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
  }, handler)(inboundWith([{ kind: "image", ref: "https://cdn.example/image" }]));
  const [path] = written.keys();
  expect(path).toMatch(/^\/inbox\/[a-f0-9]{64}-[A-Za-z0-9._-]+$/);
  expect(path?.slice("/inbox/".length).length).toBeLessThanOrEqual(185);
  expect(received[0]?.facts.attachments?.[0]).toMatchObject({
    ref: `mac:${path}`, mime: "image/png",
  });
});

test.each([download, undefined])("explicit inbound MIME outranks fetched MIME", async (fetchRef) => {
  const { inbox, received, handler } = harness();
  await withAttachmentInbox(inbox, handler)(inboundWith([
    { kind: "file", ref: "https://cdn.example/a", mime: "text/plain" },
  ]), fetchRef);
  expect(received[0]?.facts.attachments?.[0]?.mime).toBe("text/plain");
});

test("a fetched voice video keeps its media metadata after moving to the inbox", async () => {
  const { inbox, received, handler } = harness();
  await withAttachmentInbox(inbox, handler)(inboundWith([{
    kind: "video",
    ref: "video-ref",
    name: "voice-video.mov",
    mime: "video/quicktime",
    durationMs: 12_000,
    voice: true,
  }]), download);
  const stored = received[0]?.facts.attachments?.[0];
  expect(stored?.ref).toMatch(/^mac:\/inbox\//);
  expect(stored).toMatchObject({
    kind: "video",
    name: "voice-video.mov",
    mime: "video/quicktime",
    bytes: 9,
    durationMs: 12_000,
    voice: true,
  });
});

test("equal message IDs and names in different chats retain both byte sets", async () => {
  const { written, inbox, received, handler } = harness();
  const wrapped = withAttachmentInbox(inbox, handler);
  await wrapped(inboundWith([{ kind: "file", ref: "first", name: "report.pdf" }], { channelId: "chat-1" }), download);
  await wrapped(inboundWith([{ kind: "file", ref: "second", name: "report.pdf" }], { channelId: "chat-2" }), download);
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
  const wrapped = withAttachmentInbox(inbox, handler);
  const attachment: Attachment = { kind: "file", ref: "same", name: "report.pdf" };
  for (const facts of [
    {}, { surface: "slack:bot" }, { receivedBy: "owner" as const }, { workspaceId: "w1" },
    { channelId: "c2" }, { eventId: "evt-2" },
  ]) await wrapped(inboundWith([attachment], facts), download);
  await wrapped(inboundWith([{ ...attachment, ref: "different" }, attachment]), download);
  expect(written.size).toBe(8);
});

test("mixed fetch and write refusals keep order and hand off once", async () => {
  const refused = new MachineRefusalError({ reason: "already_exists", message: "occupied inbox leaf" });
  const { inbox, received, warnings, handler } = harness((_path, data) =>
    Buffer.from(data).toString() === "write-fails"
      ? Promise.reject(refused)
      : Promise.resolve({ op: "write", bytesWritten: data.byteLength }),
  );
  const attachments: Attachment[] = [
    { kind: "file", ref: "first" }, { kind: "file", ref: "fetch-fails" },
    { kind: "file", ref: "write-fails" }, { kind: "file", ref: "last" },
  ];
  await withAttachmentInbox(inbox, handler)(inboundWith(attachments), (ref, bounds) =>
    ref === "fetch-fails"
      ? Promise.reject(new MediaRefused({ code: "fetch_failed", ref, detail: "HTTP 401" }))
      : download(ref, bounds));
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
  }) }, handler)(inboundWith([attachment]), path === "provider" ? fetchRef : undefined);
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
  const running = withAttachmentInbox({ ...inbox, downloadSignal: () => controller.signal }, handler)(inboundWith([attachment]), (ref, bounds) => {
    expect(bounds.maxBytes).toBe(MEDIA_BYTE_CAP);
    expect(bounds.signal.aborted).toBe(false);
    return new Promise((_resolve, reject) => {
      bounds.signal.addEventListener("abort", () =>
        reject(new MediaRefused({ code: "fetch_failed", ref, detail: "deadline exceeded" })), { once: true });
      entered.resolve();
    });
  });
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
  await withAttachmentInbox(inbox, handler)(inboundWith([attachment]));
  expect(written.size).toBe(0);
  expect(warnings).toEqual([]);
  expect(received[0]?.facts.attachments).toEqual([attachment]);
});

test.each([{ attachments: undefined }, { attachments: [] }])("missing or empty attachments pass the same message through", async ({ attachments }) => {
  const { inbox, received, handler } = harness();
  const message = inboundWith(attachments);
  await withAttachmentInbox(inbox, handler)(message);
  expect(received).toEqual([message]);
  expect(received[0]).toBe(message);
});

test("the claim precedes storage: a duplicate copy waits, then one download, one write and one admission carry the stored reference", async () => {
  const { written, inbox, received, handler } = harness();
  const machines = inbox.files.machines;
  if (machines === undefined) throw new Error("inbox test requires a machine");
  const routing = inboxHandler(inbox.root, machines, inbox.publish, inbox.now, handler);
  if (routing.inbox === undefined) throw new Error("configured inbox missing");
  const entered = eventSignal<void>("bot download entered");
  const release = Promise.withResolvers<void>();
  const downloads: string[] = [];
  const botDownload: AttachmentFetch = async (ref, bounds) => {
    downloads.push(ref);
    entered.resolve();
    await release.promise;
    return download(ref, bounds);
  };
  const attachment: Attachment = { kind: "file", ref: "shared" };
  const bot = routing.inbox(botDownload, routing.handler)(inboundWith([attachment], { receivedBy: "bot" }));
  await entered.promise;
  const owner = routing.inbox(undefined, routing.handler)(inboundWith([attachment], { receivedBy: "owner" }));
  release.resolve();
  await Promise.all([bot, owner]);
  const [path] = written.keys();
  expect(downloads).toEqual(["shared"]);
  expect(written.size).toBe(1);
  expect(received).toHaveLength(1);
  expect(received[0]?.facts.attachments?.[0]?.ref).toBe(`mac:${path}`);
});

test("a failed handoff keeps the stored outcome: the retry carries the same reference and bytes without another download or write", async () => {
  const { written, inbox, received, warnings } = harness();
  const downloads: string[] = [];
  const counted: AttachmentFetch = (ref, bounds) => {
    downloads.push(ref);
    return download(ref, bounds);
  };
  const failures = [new Error("admission failed")];
  const wrapped = withAttachmentInbox(inbox, (message) => {
    received.push(message);
    const failure = failures.shift();
    return failure === undefined ? Promise.resolve() : Promise.reject(failure);
  });
  const message = inboundWith([{ kind: "file", ref: "kept" }]);
  await expect(wrapped(message, counted)).rejects.toThrow("admission failed");
  await wrapped(message, counted);
  const refs = received.map((copy) => copy.facts.attachments?.[0]?.ref);
  expect(refs).toHaveLength(2);
  expect(new Set(refs).size).toBe(1);
  expect(refs[0]).toMatch(/^mac:\/inbox\/[a-f0-9]{64}-report\.pdf$/);
  expect(downloads).toEqual(["kept"]);
  expect([...written.values()].map((bytes) => Buffer.from(bytes).toString())).toEqual(["kept"]);
  expect(warnings).toEqual([]);
});

test("a failed handoff retains every stored outcome beyond the former cache limit", async () => {
  const { written, inbox, received, warnings } = harness();
  const attachments = Array.from({ length: 1025 }, (_, index): Attachment => ({
    kind: "file", ref: `file-${index}`,
  }));
  let downloads = 0;
  let handoffs = 0;
  const wrapped = withAttachmentInbox(inbox, (message) => {
    received.push(message);
    handoffs += 1;
    return handoffs === 1 ? Promise.reject(new Error("admission failed")) : Promise.resolve();
  });
  const message = inboundWith(attachments);
  const counted: AttachmentFetch = (ref, bounds) => {
    downloads += 1;
    return download(ref, bounds);
  };

  await expect(wrapped(message, counted)).rejects.toThrow("admission failed");
  await wrapped(message, counted);

  expect(downloads).toBe(attachments.length);
  expect(written.size).toBe(attachments.length);
  expect(warnings).toEqual([]);
  expect(received[0]?.facts.attachments?.map((item) => item.ref)).toEqual(
    received[1]?.facts.attachments?.map((item) => item.ref),
  );
  expect(received[1]?.facts.attachments?.every((item) => item.ref.startsWith("mac:/inbox/"))).toBe(true);
});

test("an occupied leaf from an earlier process is still refused and keeps the reference", async () => {
  const { written, inbox, received, warnings, handler } = harness();
  const message = inboundWith([{ kind: "file", ref: "again" }]);
  await withAttachmentInbox(inbox, handler)(message, download);
  await withAttachmentInbox(inbox, handler)(message, download);
  expect(written.size).toBe(1);
  expect(received[1]?.facts.attachments).toEqual([{ kind: "file", ref: "again" }]);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("occupied /inbox/");
});

test.each([
  ["mapped loopback", "https://[::ffff:127.0.0.1]/a.png", []],
  ["a public-looking name with a private address", "https://cdn.example/a.png", ["10.0.0.7"]],
] as const)("%s never reaches the download transport and keeps the original reference", async (_case, ref, addresses) => {
  const { written, inbox, received, warnings, handler } = harness();
  const transported: string[] = [];
  const media = createMediaResolver(
    inbox.files,
    (url) => {
      transported.push(url.href);
      return Promise.resolve(new Response("secret"));
    },
    () => Promise.resolve(addresses.map((address) => ({ address, family: 4 }))),
  );
  const attachment: Attachment = { kind: "image", ref };
  await withAttachmentInbox({ ...inbox, media }, handler)(inboundWith([attachment]));
  expect({
    transported,
    writes: written.size,
    kept: received.map((copy) => copy.facts.attachments),
    refusals: warnings.map((warning) => warning.includes("OniMediaRefused")),
  }).toEqual({ transported: [], writes: 0, kept: [[attachment]], refusals: [true] });
});
