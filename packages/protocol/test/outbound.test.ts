import { describe, expect, test } from "bun:test";
import { Outbound } from "../src/index.js";
import { z } from "zod";
type JsonValue = z.infer<ReturnType<typeof z.json>>;

describe("Outbound (#1497)", () => {
  test("a string is sugar for one text part; a payload passes through unchanged", () => {
    expect(Outbound.payload("hi")).toEqual({ kind: "message", parts: [{ kind: "text", text: "hi" }] });
    const react = { kind: "react", messageId: "m-1", emoji: "\u{1F44D}" } as const;
    expect(Outbound.payload(react)).toBe(react);
    expect(Outbound.React.parse({ ...react, replaces: "\u{1F440}" })).toEqual({ ...react, replaces: "\u{1F440}" });
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

  test("catalog validates every element and rejects state, bad references, and invalid buttons", () => {
    const props: Record<string, Record<string, JsonValue>> = {
      Markdown: { text: "hello" },
      Code: { text: "echo hi", lang: "sh" },
      Table: { columns: [{ header: "Name" }], rows: [["Ada"]] },
      Image: { ref: "https://example.com/a.png" },
      File: { ref: "/tmp/a.txt", name: "a.txt" },
      Buttons: {},
      Button: { label: "Open", id: "open" },
      Card: { title: "A card" },
      Carousel: {},
      Poll: { question: "Choose", options: ["A", "B"] },
      Status: { kind: "progress", title: "Working" },
      Divider: {},
      Context: { text: "Aside" },
    };
    for (const [type, value] of Object.entries(props)) {
      const spec =
        type === "Carousel"
          ? {
              root: "stack",
              elements: {
                stack: { type: "Stack", props: {}, children: ["carousel"] },
                carousel: { type, props: value, children: ["card-a", "card-b"] },
                "card-a": { type: "Card", props: { title: "A" }, children: [] },
                "card-b": { type: "Card", props: { title: "B" }, children: [] },
              },
            }
          : { root: type, elements: { [type]: { type, props: value, children: [] } } };
      const parsed = Outbound.Spec.safeParse(spec);
      expect(parsed.success, type).toBe(true);
    }
    expect(
      Outbound.Spec.safeParse({
        root: "buttons",
        elements: {
          buttons: { type: "Buttons", props: {}, children: ["missing"] },
        },
      }).success,
    ).toBe(false);
    expect(
      Outbound.Spec.safeParse({
        root: "markdown",
        elements: { markdown: { type: "Unknown", props: {}, children: [] } },
      }).success,
    ).toBe(false);
    for (const element of [
      { root: "missing", elements: { present: { type: "Markdown", props: { text: "x" }, children: [] } } },
      { root: "markdown", elements: { markdown: { type: "Markdown", props: { text: { $state: "/x" } }, children: [] } } },
      { root: "markdown", elements: { markdown: { type: "Markdown", props: { text: "x" }, children: [], visible: true } } },
      { root: "markdown", elements: { markdown: { type: "Markdown", props: { text: "x" }, children: [], watch: {} } } },
      { root: "button", elements: { button: { type: "Button", props: { label: "x", id: "a", url: "https://example.com" }, children: [] } } },
      { root: "button", elements: { button: { type: "Button", props: { label: "x" }, children: [] } } },
    ])
      expect(Outbound.Spec.safeParse(element).success).toBe(false);
    const button = { type: "Button", props: { label: "x", id: "x" }, children: [] };
    expect(
      Outbound.Spec.safeParse({
        root: "buttons",
        elements: { buttons: { type: "Buttons", props: {}, children: ["1", "2", "3", "4", "5", "6"] }, ...Object.fromEntries(["1", "2", "3", "4", "5", "6"].map((id) => [id, button])) },
      }).success,
    ).toBe(false);
    for (const count of [1, 11]) {
      const cards = Object.fromEntries(Array.from({ length: count }, (_, index) => [`card-${index}`, { type: "Card", props: { title: String(index) }, children: [] }]));
      expect(Outbound.Spec.safeParse({ root: "carousel", elements: { carousel: { type: "Carousel", props: {}, children: Object.keys(cards) }, ...cards } }).success).toBe(false);
    }
  });

  test("catalog digest walks depth-first and renders structured elements", () => {
    const spec: Outbound.Spec = {
        root: "stack",
      elements: {
        stack: { type: "Stack", props: {}, children: ["card", "table", "buttons"] },
        card: { type: "Card", props: { title: "Summary", body: "Details" }, children: [] },
        table: { type: "Table", props: { columns: [{ header: "A" }, { header: "B" }], rows: [["1", "2"]] }, children: [] },
        buttons: { type: "Buttons", props: {}, children: ["button"] },
        button: { type: "Button", props: { label: "Continue", id: "continue" }, children: [] },
      },
    };
    expect(Outbound.text({ kind: "message", spec })).toBe(
      "Summary\n\nDetails\n\nA | B\n1 | 2\n\n[Continue]",
    );
    const prompt = Outbound.prompt();
    expect(prompt).toContain("Markdown");
    expect(prompt).toContain("Stack");
    expect(prompt).not.toContain("$state");
    expect(prompt).not.toContain("repeat");
    expect(prompt).not.toContain("visible");
    expect(prompt).not.toContain("JSONL");
    expect(prompt).not.toContain("pushState");
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
