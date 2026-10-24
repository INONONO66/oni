import { describe, expect, test } from "bun:test";
import { Delivery, Gateway } from "../src/index.js";

const voice = { kind: "audio", ref: "mac:/inbox/v.ogg", mime: "audio/ogg", durationMs: 4200, voice: true } as const;
const photo = { kind: "image", ref: "mac:/inbox/p.png", mime: "image/png", name: "p.png" } as const;
const admission = {
  id: "delivery-1",
  sessionId: "session-1",
  kind: "prompt",
  content: "look at this",
  origin: { encodingVersion: 1, value: { text: "look at this" } },
  createdAt: 100,
} as const;

describe("media parts beside a delivered prompt", () => {
  test("the gateway part is the attachment shape the ingress facts carry", () => {
    expect(Gateway.MediaPart.parse(voice)).toEqual(voice);
    expect(Gateway.MediaPart.safeParse({ ...photo, kind: "sticker" }).success).toBe(false);
    expect(Gateway.MediaPart.safeParse({ ...photo, ref: "" }).success).toBe(false);
    expect(Gateway.MediaPart.safeParse({ ...photo, caption: "x" }).success).toBe(false);
    const facts = Gateway.IngressFacts.shape.attachments.parse([voice, photo]);
    expect(facts).toEqual([voice, photo]);
    expect(Gateway.IngressFacts.shape.attachments.safeParse([{ ...voice, durationMs: -1 }]).success).toBe(false);
  });

  test("a commit carries parts while content stays the text", () => {
    const commit = Delivery.Commit.parse({ ...admission, parts: [photo, voice] });
    expect(commit.content).toBe("look at this");
    expect(commit.parts).toEqual([photo, voice]);
    expect(Delivery.Commit.parse(admission).parts).toBeUndefined();
    expect(Delivery.Commit.safeParse({ ...admission, parts: [{ kind: "video" }] }).success).toBe(false);
    expect(Delivery.Commit.safeParse({ ...admission, content: [photo] }).success).toBe(false);
  });

  test("the ledger row never stores parts", () => {
    const row = {
      ...admission,
      status: "pending",
      consumedBy: null,
      consumedAt: null,
      ordinal: 1,
    } as const;
    expect(Delivery.Row.safeParse(row).success).toBe(true);
    expect(Delivery.Row.safeParse({ ...row, parts: [photo] }).success).toBe(false);
  });
});
