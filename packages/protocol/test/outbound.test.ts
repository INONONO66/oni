import { describe, expect, test } from "bun:test";
import { Outbound } from "../src/index.js";

describe("Outbound (#1497)", () => {
  test("a string is sugar for one text part; a payload passes through unchanged", () => {
    expect(Outbound.payload("hi")).toEqual({ kind: "message", parts: [{ kind: "text", text: "hi" }] });
    const react = { kind: "react", messageId: "m-1", emoji: "\u{1F44D}" } as const;
    expect(Outbound.payload(react)).toBe(react);
    expect(Outbound.React.parse({ ...react, remove: true })).toEqual({ ...react, remove: true });
  });

  test("every part kind parses strictly and unknown kinds or extra keys are refused", () => {
    const parts: Outbound.Part[] = [
      { kind: "text", text: "a" },
      { kind: "code", text: "ls", lang: "sh" },
      { kind: "image", ref: "/tmp/a.png", caption: "shot" },
      { kind: "file", ref: "https://x/y.pdf", name: "y.pdf", mime: "application/pdf" },
    ];
    expect(Outbound.Message.parse({ kind: "message", parts })).toEqual({ kind: "message", parts });
    expect(Outbound.Message.safeParse({ kind: "message", parts: [] }).success).toBe(false);
    expect(Outbound.Part.safeParse({ kind: "audio", ref: "x" }).success).toBe(false);
    expect(Outbound.Part.safeParse({ kind: "text", text: "a", thread: "t" }).success).toBe(false);
    expect(Outbound.Part.safeParse({ kind: "file", ref: "x" }).success).toBe(false);
  });

  test("the text reading keeps every part visible: code fenced, media named by reference", () => {
    const text = Outbound.text({
      kind: "message",
      parts: [
        { kind: "text", text: "see" },
        { kind: "code", text: "ls", lang: "sh" },
        { kind: "code", text: "x" },
        { kind: "image", ref: "/tmp/a.png", name: "a.png", caption: "shot" },
        { kind: "image", ref: "/tmp/b.png" },
        { kind: "file", ref: "/tmp/r.pdf", name: "r.pdf" },
      ],
    });
    expect(text).toBe(
      [
        "see",
        "```sh\nls\n```",
        "```\nx\n```",
        "[image: a.png] /tmp/a.png\nshot",
        "[image] /tmp/b.png",
        "[file: r.pdf] /tmp/r.pdf",
      ].join("\n\n"),
    );
    expect(Outbound.text({ kind: "react", messageId: "m-1", emoji: "\u{1F44D}" })).toBe(
      "\u{1F44D} on m-1",
    );
  });

  test("a receipt names the outcome and at most one external message id", () => {
    expect(Outbound.Receipt.parse({ value: "accepted", externalMessageId: "7" })).toEqual({
      value: "accepted",
      externalMessageId: "7",
    });
    expect(Outbound.Receipt.parse({ value: "rejected" })).toEqual({ value: "rejected" });
    expect(Outbound.Receipt.safeParse({ value: "accepted", externalMessageIds: ["7"] }).success).toBe(false);
  });
});
