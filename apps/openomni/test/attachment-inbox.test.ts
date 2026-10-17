/**
 * Inbound attachments reach the default machine's inbox before the Resident
 * handler runs: the provider's own download where it offers one, the media
 * resolver for a public URL, and the platform reference kept (with a
 * warning) when neither can deliver the bytes.
 */
import { expect, test } from "bun:test";
import { Operational, type Channel } from "@openomni/protocol";
import { type AttachmentInbox, withAttachmentInbox } from "../src/composition/attachments";
import type { FilePorts } from "../src/bundles/tools/core/filesystem";

type ToolMachine = ReturnType<NonNullable<FilePorts["machines"]>["get"]>;

function machineWith(written: Record<string, Uint8Array>): ToolMachine {
  const unsupported = () => Promise.reject(new Error("not under test"));
  return {
    fs: {
      write: (path: string, data: Uint8Array) => {
        written[path] = data;
        return Promise.resolve({ op: "write", bytesWritten: data.byteLength });
      },
      read: unsupported,
      stat: unsupported,
      list: unsupported,
    },
    exec: unsupported,
    pty: { open: unsupported, write: unsupported, read: unsupported },
  };
}

function inboundWith(attachments: NonNullable<Channel.InboundMessage["facts"]["attachments"]>): Channel.InboundMessage {
  return {
    sender: { kind: "external", surface: "telegram:bot", externalId: "u1" },
    facts: {
      surface: "telegram:bot",
      channelId: "c1",
      eventId: "evt-1",
      payload: {},
      render: "hi",
      attachments,
    },
  } as unknown as Channel.InboundMessage;
}

function harness() {
  const written: Record<string, Uint8Array> = {};
  const warnings: string[] = [];
  const inbox: AttachmentInbox = {
    root: "/inbox",
    files: { machines: { defaultMachine: "mac", get: () => machineWith(written) } },
    media: (part) =>
      part.ref === "https://cdn.example/a%20b.png"
        ? Promise.resolve({ bytes: new TextEncoder().encode("png"), name: "a b.png", mime: "image/png" })
        : Promise.reject(new Error(`no media for ${part.ref}`)),
    publish: <T>(event: { name: string }, data: T) => {
      if (event.name === Operational.Events.Warn.name) warnings.push((data as { msg: string }).msg);
    },
    now: () => 0,
  };
  const received: Channel.InboundMessage[] = [];
  const handler = (message: Channel.InboundMessage) => {
    received.push(message);
    return Promise.resolve();
  };
  return { written, warnings, inbox, received, handler };
}

test("a provider download lands on the default machine and the message carries the locus", async () => {
  const { written, warnings, inbox, received, handler } = harness();
  const fetched: string[] = [];
  const wrapped = withAttachmentInbox(
    inbox,
    (ref) => {
      fetched.push(ref);
      return Promise.resolve({ bytes: new TextEncoder().encode("doc"), name: "report.pdf", mime: "application/pdf" });
    },
    handler,
  );

  await wrapped(inboundWith([{ kind: "file", ref: "file-id-9", mime: "application/pdf" }]));

  expect(fetched).toEqual(["file-id-9"]);
  expect(Object.keys(written)).toEqual(["/inbox/evt-1-0-report.pdf"]);
  expect(received[0]?.facts.attachments).toEqual([
    { kind: "file", ref: "mac:/inbox/evt-1-0-report.pdf", mime: "application/pdf", name: "report.pdf", bytes: 3 },
  ]);
  expect(warnings).toEqual([]);
});

test("a public URL goes through the media resolver and the name is folded to one safe segment", async () => {
  const { written, inbox, received, handler } = harness();
  const wrapped = withAttachmentInbox(inbox, undefined, handler);

  await wrapped(inboundWith([{ kind: "image", ref: "https://cdn.example/a%20b.png" }]));

  expect(Object.keys(written)).toEqual(["/inbox/evt-1-0-a_b.png"]);
  expect(received[0]?.facts.attachments?.[0]?.ref).toBe("mac:/inbox/evt-1-0-a_b.png");
});

test("a failed fetch keeps the platform reference, warns, and still hands the message off", async () => {
  const { written, warnings, inbox, received, handler } = harness();
  const wrapped = withAttachmentInbox(inbox, () => Promise.reject(new Error("401")), handler);

  await wrapped(inboundWith([{ kind: "file", ref: "file-id-9" }]));

  expect(written).toEqual({});
  expect(warnings).toEqual(["inbound attachment not stored; reference kept"]);
  expect(received[0]?.facts.attachments).toEqual([{ kind: "file", ref: "file-id-9" }]);
});

test("a reference that is neither downloadable nor a URL passes through untouched, without a provider download", async () => {
  const { written, warnings, inbox, received, handler } = harness();
  const wrapped = withAttachmentInbox(inbox, undefined, handler);

  await wrapped(inboundWith([{ kind: "file", ref: "opaque-ref" }]));

  expect(written).toEqual({});
  expect(warnings).toEqual([]);
  expect(received[0]?.facts.attachments).toEqual([{ kind: "file", ref: "opaque-ref" }]);
});

test("a message without attachments is handed off as is", async () => {
  const { inbox, received, handler } = harness();
  const message = inboundWith([]);
  await withAttachmentInbox(inbox, undefined, handler)(message);
  expect(received[0]).toBe(message);
});
