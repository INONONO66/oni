import { describe, expect, test } from "bun:test";
import { Delivery, Gateway, Message, SessionTurn } from "../src/index.js";

const voice = { kind: "audio", ref: "mac:/inbox/v.ogg", mime: "audio/ogg", durationMs: 4200, voice: true } as const;
const photo = { kind: "image", ref: "mac:/inbox/p.png", mime: "image/png", name: "p.png" } as const;
const doc = { kind: "file", ref: "mac:/inbox/r.pdf", mime: "application/pdf", bytes: 2048 } as const;
const caption = { kind: "text", text: "look at this" } as const;
const admission = {
  id: "delivery-1",
  sessionId: "session-1",
  kind: "prompt",
  content: [caption, photo, voice],
  origin: { encodingVersion: 1, value: { text: "look at this" } },
  createdAt: 100,
} as const;
const row = { ...admission, status: "pending", consumedBy: null, consumedAt: null, ordinal: 1 } as const;

describe("delivered content parts", () => {
  test("the gateway part is the attachment shape the ingress facts carry", () => {
    expect(Gateway.MediaPart.parse(voice)).toEqual(voice);
    expect(Gateway.MediaPart.safeParse({ ...photo, kind: "sticker" }).success).toBe(false);
    expect(Gateway.MediaPart.safeParse({ ...photo, ref: "" }).success).toBe(false);
    expect(Gateway.MediaPart.safeParse({ ...photo, caption: "x" }).success).toBe(false);
    const facts = Gateway.IngressFacts.shape.attachments.parse([voice, photo]);
    expect(facts).toEqual([voice, photo]);
    expect(Gateway.IngressFacts.shape.attachments.safeParse([{ ...voice, durationMs: -1 }]).success).toBe(false);
  });

  test("text, image and file parts parse as content in order", () => {
    expect(Delivery.ContentPart.parse(caption)).toEqual(caption);
    expect(Delivery.ContentPart.parse(photo)).toEqual(photo);
    expect(Delivery.ContentPart.parse(doc)).toEqual(doc);
    expect(Delivery.Content.parse([caption, photo, doc])).toEqual([caption, photo, doc]);
    expect(Delivery.ContentPart.safeParse({ kind: "text", text: "x", ref: "r" }).success).toBe(false);
    expect(Delivery.ContentPart.safeParse({ kind: "text" }).success).toBe(false);
    expect(Delivery.ContentPart.safeParse({ kind: "sticker", ref: "r" }).success).toBe(false);
    expect(Delivery.Content.safeParse("look at this").success).toBe(false);
  });

  test("text renders text parts verbatim and media as kind and name or ref", () => {
    expect(Delivery.text([caption, photo, { kind: "text", text: "and this" }, voice])).toBe(
      "look at this\n[image: p.png]\nand this\n[audio: mac:/inbox/v.ogg]",
    );
    expect(Delivery.text([])).toBe("");
  });

  test("a commit and a row carry media inside content and no longer accept parts", () => {
    const commit = Delivery.Commit.parse(admission);
    expect(commit.content).toEqual([caption, photo, voice]);
    expect(Delivery.Commit.safeParse({ ...admission, parts: [photo] }).success).toBe(false);
    expect(Delivery.Commit.safeParse({ ...admission, content: "look at this" }).success).toBe(false);
    expect(Delivery.Row.parse(row).content).toEqual([caption, photo, voice]);
    expect(Delivery.Row.safeParse({ ...row, parts: [photo] }).success).toBe(false);
  });

  test("a prompt refuses empty content at the content path", () => {
    for (const [schema, input] of [
      [Delivery.Commit, admission],
      [Delivery.Row, row],
    ] as const) {
      const refused = schema.safeParse({ ...input, content: [] });
      expect(refused.success).toBe(false);
      expect(refused.error?.issues.map(({ path, message }) => [path, message])).toEqual([
        [["content"], "prompt delivery requires content"],
      ]);
    }
  });

  test("action, interrupt, resume and cancel accept empty content", () => {
    for (const kind of ["action", "interrupt", "resume", "cancel"] as const) {
      expect(Delivery.Row.parse({ ...row, kind, content: [] }).content).toEqual([]);
      expect(Delivery.Commit.parse({ ...admission, kind, content: [] }).content).toEqual([]);
    }
  });

  test("the turn delivery boundary row carries content parts", () => {
    const boundary = {
      phase: "delivery",
      turnId: "turn-1",
      deliveryId: "delivery-1",
      kind: "prompt",
      content: [caption, photo],
      origin: admission.origin,
      boundary: "after_tools",
    } as const;
    expect(SessionTurn.Delivery.parse(boundary).content).toEqual([caption, photo]);
    expect(SessionTurn.Delivery.parse({ ...boundary, kind: "interrupt", content: [] }).content).toEqual([]);
    expect(SessionTurn.Delivery.safeParse({ ...boundary, content: "look at this" }).success).toBe(false);
  });

  test("a model message part carries a delivered file", () => {
    const part = { id: "p-1", sessionID: "s-1", messageID: "m-1", type: "file", ...doc } as const;
    expect(Message.FilePart.parse(part)).toEqual(part);
    expect(Message.Part.parse({ ...part, ...voice })).toEqual({ ...part, ...voice });
    expect(Message.Part.safeParse({ ...part, ref: "" }).success).toBe(false);
    expect(Message.Part.safeParse({ ...part, kind: "sticker" }).success).toBe(false);
    expect(Message.Part.safeParse({ ...part, bytes: -1 }).success).toBe(false);
  });
});
