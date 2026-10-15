import { describe, expect, test } from "bun:test";
import { Outbound } from "../src/index.js";
import type { z } from "zod";
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

  test("a message accepts exactly one of parts or a catalog spec", () => {
    const parts = [{ kind: "text", text: "hello" }];
    const spec = {
      root: "message",
      elements: { message: { type: "Markdown", props: { text: "hello" }, children: [] } },
    };
    expect(Outbound.Message.safeParse({ kind: "message", parts }).success).toBe(true);
    expect(Outbound.Message.safeParse({ kind: "message", spec }).success).toBe(true);
    expect(Outbound.Message.safeParse({ kind: "message" }).success).toBe(false);
    expect(Outbound.Message.safeParse({ kind: "message", parts, spec }).success).toBe(false);
  });

  test("an edit carries only a full replacement spec and keeps its digest and parts", () => {
    const spec = Outbound.Spec.parse({
      root: "status",
      elements: { status: { type: "Status", props: { kind: "ok", title: "Done" }, children: [] } },
    });
    const edit = { kind: "edit", messageId: "42", spec } as const;
    expect(Outbound.Payload.parse(edit)).toEqual(edit);
    expect(Outbound.text(edit)).toBe(Outbound.text({ kind: "message", spec }));
    expect(Outbound.parts(edit)).toEqual(Outbound.parts({ kind: "message", spec }));
    expect(Outbound.Payload.safeParse({ ...edit, messageId: "" }).success).toBe(false);
    expect(Outbound.Payload.safeParse({ ...edit, parts: [{ kind: "text", text: "patch" }] }).success).toBe(false);
    expect(Outbound.Payload.safeParse({ kind: "edit", messageId: "42" }).success).toBe(false);
    expect(Outbound.prompt()).toContain("edit replaces an earlier message");
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
    const wrapped: Record<string, Outbound.Spec> = {
      Carousel: {
        root: "carousel",
        elements: {
          carousel: { type: "Carousel", props: {}, children: ["card-a", "card-b"] },
          "card-a": { type: "Card", props: { title: "A" }, children: [] },
          "card-b": { type: "Card", props: { title: "B" }, children: [] },
        },
      },
      Button: {
        root: "buttons",
        elements: {
          buttons: { type: "Buttons", props: {}, children: ["open"] },
          open: { type: "Button", props: { label: "Open", id: "open" }, children: [] },
        },
      },
    };
    for (const [type, value] of Object.entries(props)) {
      const spec = wrapped[type] ?? { root: type, elements: { [type]: { type, props: value, children: [] } } };
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
      { root: "button", elements: { button: { type: "Button", props: { label: "x", id: "x" }, children: [] } } },
    ])
      expect(Outbound.Spec.safeParse(element).success).toBe(false);
  });

  test("a spec is one tree: no orphan, shared, or self-referencing elements", () => {
    const markdown = { type: "Markdown", props: { text: "x" }, children: [] };
    const issues = (spec: JsonValue) =>
      Outbound.Spec.safeParse(spec).error?.issues.map((issue) => `${issue.path.join(".")}:${issue.message}`) ?? [];
    expect(issues({ root: "stack", elements: { stack: { type: "Stack", props: {}, children: ["a"] }, a: markdown, b: markdown } })).toEqual([
      "elements.b:element is not reachable from root",
    ]);
    expect(issues({ root: "stack", elements: { stack: { type: "Stack", props: {}, children: ["a", "a"] }, a: markdown } })).toEqual([
      "elements.stack.children:element is referenced more than once",
    ]);
    expect(issues({ root: "stack", elements: { stack: { type: "Stack", props: {}, children: ["stack"] } } })).toEqual([
      "elements.stack.children:element is referenced more than once",
    ]);
    expect(issues({ root: "a", elements: { a: { type: "Stack", props: {}, children: ["b"] }, b: { type: "Stack", props: {}, children: ["a"] } } })).toEqual([
      "elements.b.children:element is referenced more than once",
    ]);
    expect(issues({ root: "stack", elements: { stack: { type: "Stack", props: {}, children: [] } } })).toEqual([
      "elements.stack.children:Stack must contain at least one child",
    ]);
    expect(issues({ root: "m", elements: { m: { ...markdown, children: ["a"] }, a: markdown } })).toEqual([
      "elements.m.children:this element cannot have children",
    ]);
  });

  test("Button lives only under Buttons and Carousel holds only Cards", () => {
    const issues = (spec: JsonValue) =>
      Outbound.Spec.safeParse(spec).error?.issues.map((issue) => `${issue.path.join(".")}:${issue.message}`) ?? [];
    const button = { type: "Button", props: { label: "x", id: "x" }, children: [] };
    const markdown = { type: "Markdown", props: { text: "x" }, children: [] };
    const card = { type: "Card", props: { title: "x" }, children: [] };
    expect(issues({ root: "b", elements: { b: { type: "Buttons", props: {}, children: ["m"] }, m: markdown } })).toEqual([
      "elements.b.children.0:Buttons children must be Button elements",
    ]);
    expect(issues({ root: "c", elements: { c: { type: "Carousel", props: {}, children: ["k", "m"] }, k: card, m: markdown } })).toEqual([
      "elements.c.children.1:Carousel children must be Card elements",
    ]);
    expect(issues({ root: "s", elements: { s: { type: "Stack", props: {}, children: ["x"] }, x: button } })).toEqual([
      "elements.s.children.0:Button must be a child of Buttons",
    ]);
    expect(issues({ root: "b", elements: { b: { type: "Buttons", props: {}, children: ["x"] }, x: button } })).toEqual([]);
    expect(issues({ root: "c", elements: { c: { type: "Carousel", props: {}, children: ["k", "j"] }, k: card, j: card } })).toEqual([]);
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

  test("Card may contain one Buttons group and preserves link URLs in its digest", () => {
    const spec = {
      root: "card",
      elements: {
        card: { type: "Card", props: { title: "Report", body: "Ready" }, children: ["actions"] },
        actions: { type: "Buttons", props: {}, children: ["open"] },
        open: { type: "Button", props: { label: "Open", url: "https://example.test" }, children: [] },
      },
    };
    expect(Outbound.Spec.safeParse(spec).success).toBe(true);
    expect(Outbound.text({ kind: "message", spec: Outbound.Spec.parse(spec) }))
      .toBe("Report\n\nReady\n\n[Open] (https://example.test)");
    const invalid = { ...spec, elements: { ...spec.elements,
      card: { ...spec.elements.card, children: ["actions", "open"] } } };
    expect(Outbound.Spec.safeParse(invalid).success).toBe(false);
  });

  test("catalog digest walks depth-first and keeps every element readable as text", () => {
    const spec = Outbound.Spec.parse({
      root: "stack",
      elements: {
        stack: { type: "Stack", props: {}, children: ["md", "sh", "plain", "table", "shot", "bare", "file", "buttons", "carousel", "poll", "ok", "busy", "rule", "aside"] },
        md: { type: "Markdown", props: { text: "# Hi" }, children: [] },
        sh: { type: "Code", props: { text: "ls", lang: "sh" }, children: [] },
        plain: { type: "Code", props: { text: "x" }, children: [] },
        table: { type: "Table", props: { columns: [{ header: "A" }, { header: "B" }], rows: [["1", "2"]] }, children: [] },
        shot: { type: "Image", props: { ref: "/tmp/a.png", caption: "shot" }, children: [] },
        bare: { type: "Image", props: { ref: "/tmp/b.png" }, children: [] },
        file: { type: "File", props: { ref: "/tmp/r.pdf", name: "r.pdf" }, children: [] },
        buttons: { type: "Buttons", props: {}, children: ["go"] },
        go: { type: "Button", props: { label: "Continue", id: "continue" }, children: [] },
        carousel: { type: "Carousel", props: {}, children: ["k1", "k2"] },
        k1: { type: "Card", props: { title: "Summary", body: "Details" }, children: [] },
        k2: { type: "Card", props: { title: "Second" }, children: [] },
        poll: { type: "Poll", props: { question: "Which?", options: ["A", "B"] }, children: [] },
        ok: { type: "Status", props: { kind: "ok", title: "Done", body: "All green" }, children: [] },
        busy: { type: "Status", props: { kind: "progress", title: "Working" }, children: [] },
        rule: { type: "Divider", props: {}, children: [] },
        aside: { type: "Context", props: { text: "aside" }, children: [] },
      },
    });
    expect(Outbound.text({ kind: "message", spec })).toBe(
      [
        "# Hi",
        "```sh\nls\n```",
        "```\nx\n```",
        "A | B\n1 | 2",
        "[image] /tmp/a.png\nshot",
        "[image] /tmp/b.png",
        "[file: r.pdf] /tmp/r.pdf",
        "[Continue]",
        "Summary",
        "Details",
        "Second",
        "Which?\n- A\n- B",
        "OK: Done",
        "All green",
        "PROGRESS: Working",
        "---",
        "aside",
      ].join("\n\n"),
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
