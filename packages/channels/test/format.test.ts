import { describe, expect, it } from "bun:test";
import { ChunkLengthError, chunkMarkdown } from "../src/support/format/chunk";
import { renderDiscordMarkdown } from "../src/support/format/discord";
import { tablesToBullets } from "../src/support/format/table";
import { renderTelegramHtml } from "../src/support/format/telegram";

describe("tablesToBullets", () => {
  it("passes text without pipes through byte-for-byte", () => {
    const text = "plain paragraph\n- a bullet\n";
    expect(tablesToBullets(text)).toBe(text);
  });

  it("passes pipe text without a separator row through", () => {
    const text = "a | b\nc | d";
    expect(tablesToBullets(text)).toBe(text);
  });

  it("rewrites a GFM table into bold-heading bullet groups", () => {
    const text =
      "| Name | Role | City |\n| --- | :-: | ---: |\n| Ana | dev | Seoul |\n| Bo | ops | Busan |";
    expect(tablesToBullets(text)).toBe(
      "**Ana**\n- Role: dev\n- City: Seoul\n\n**Bo**\n- Role: ops\n- City: Busan",
    );
  });

  it("fills missing trailing cells with empty values", () => {
    const text = "| K | V |\n| - | - |\n| solo |";
    expect(tablesToBullets(text)).toBe("**solo**\n- V: ");
  });

  it("renders a single-column table as bold rows without bullets", () => {
    const text = "| Only |\n| --- |\n| one |\n| two |";
    expect(tablesToBullets(text)).toBe("**one**\n\n**two**");
  });

  it("renders a header-only table as bold header names", () => {
    const text = "| A | B |\n| - | - |";
    expect(tablesToBullets(text)).toBe("**A**\n**B**");
  });

  it("leaves tables inside code fences untouched", () => {
    const text = "```\n| a | b |\n| - | - |\n| 1 | 2 |\n```";
    expect(tablesToBullets(text)).toBe(text);
  });

  it.each([1, 2, 8])("preserves a terminal %s-column header without a separator", (width) => {
    const columns = Array.from<undefined, string>(
      { length: width },
      (_, index) => `column-${index}`,
    );
    const text = `before\n| ${columns.join(" | ")} |`;
    expect(tablesToBullets(text)).toBe(text);
  });

  it("keeps surrounding prose and converts only the table lines", () => {
    const text = "before\n| H |\n| - |\n| v |\nafter";
    expect(tablesToBullets(text)).toBe("before\n**v**\nafter");
  });
});

describe("chunkMarkdown", () => {
  it("refuses budgets too small for fence bookkeeping", () => {
    expect(() => chunkMarkdown("text", 10)).toThrow(ChunkLengthError);
  });

  it("returns short text as a single chunk", () => {
    expect(chunkMarkdown("hello", 64)).toEqual(["hello"]);
  });

  it("splits at line boundaries and keeps every chunk within budget", () => {
    const text = Array.from<undefined, string>({ length: 30 }, (_, i) => `line number ${i}`).join(
      "\n",
    );
    const chunks = chunkMarkdown(text, 64);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(64);
    expect(chunks.join("\n")).toBe(text);
  });

  it.each([
    64, 65, 100, 200,
  ])("preserves fenced code across a %s-character chunk boundary", (limit) => {
    const code = Array.from<undefined, string>(
      { length: 20 },
      (_, i) => `const x${i} = ${i};`,
    ).join("\n");
    const text = `\`\`\`ts\n${code}\n\`\`\``;
    const chunks = chunkMarkdown(text, limit);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(limit);
      expect(chunk.startsWith("```")).toBe(true);
      expect(chunk.endsWith("```")).toBe(true);
    }
    expect(chunks[1]?.startsWith("```ts\n")).toBe(true);
    expect(chunks.flatMap((chunk) => chunk.split("\n").slice(1, -1)).join("\n")).toBe(code);
  });

  it("does not close a fence on a tilde line inside a backtick fence", () => {
    const filler = "x".repeat(40);
    const text = `\`\`\`\n~~~\n${filler}\n${filler}\n\`\`\`\ntail`;
    const chunks = chunkMarkdown(text, 64);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(64);
    const reassembled = chunks.join("\n");
    expect(reassembled).toContain("~~~");
    expect(reassembled.endsWith("tail")).toBe(true);
  });

  it("hard-splits a single line longer than the budget", () => {
    const text = `short\n${"a".repeat(300)}`;
    const chunks = chunkMarkdown(text, 64);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(64);
    expect(chunks.join("").replaceAll("\n", "")).toContain("a".repeat(64));
  });

  it("hard-splits an overlong line inside a fence and keeps fences balanced", () => {
    const text = `\`\`\`js\n${"b".repeat(200)}\n\`\`\``;
    const chunks = chunkMarkdown(text, 64);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(64);
      expect(chunk.startsWith("```")).toBe(true);
      expect(chunk.endsWith("```")).toBe(true);
    }
  });
});

describe("renderTelegramHtml", () => {
  it("converts headers to bold and strips redundant bold inside them", () => {
    expect(renderTelegramHtml("## Big **Deal** Title")).toBe("<b>Big Deal Title</b>");
  });

  it("converts bold and italic to HTML entities", () => {
    expect(renderTelegramHtml("**bold** and *ital*")).toBe("<b>bold</b> and <i>ital</i>");
  });

  it("escapes HTML syntax in plain text", () => {
    expect(renderTelegramHtml("a<b && c>d")).toBe("a&lt;b &amp;&amp; c&gt;d");
  });

  it("escapes HTML syntax inside styled bodies", () => {
    expect(renderTelegramHtml("**a & b**")).toBe("<b>a &amp; b</b>");
  });

  it("converts links, escaping their attributes and labels", () => {
    expect(renderTelegramHtml("[docs](https://x.dev/?a=1&b=2)")).toBe(
      '<a href="https://x.dev/?a=1&amp;b=2">docs</a>',
    );
  });

  it("keeps bold styling around a link via nested placeholder restore", () => {
    expect(renderTelegramHtml("**see [site](https://a.io)**")).toBe(
      '<b>see <a href="https://a.io">site</a></b>',
    );
  });

  it("protects inline code bodies and escapes HTML syntax inside them", () => {
    expect(renderTelegramHtml("run `a<b&c` now")).toBe("run <code>a&lt;b&amp;c</code> now");
  });

  it("protects fenced code and escapes HTML syntax in the body", () => {
    expect(renderTelegramHtml("```py\nx = '<&';\n```")).toBe(
      "<pre><code class=\"language-py\">x = '&lt;&amp;';\n</code></pre>",
    );
  });

  it("protects a single-line fenced span from styling", () => {
    expect(renderTelegramHtml("```raw**not bold**```")).toBe("<pre><code>raw**not bold**</code></pre>");
  });

  it("rewrites tables before conversion so groups render as bold", () => {
    expect(renderTelegramHtml("| H | V |\n| - | - |\n| k | 1 |")).toBe("<b>k</b>\n- V: 1");
  });

  it("strips the sentinel character so placeholder framing cannot be forged", () => {
    expect(renderTelegramHtml("a\uE0000\uE000b")).toBe("a0b");
  });
});

describe("renderDiscordMarkdown", () => {
  it("rewrites tables and passes every other construct through", () => {
    const text = "**bold** stays\n| H | V |\n| - | - |\n| k | 1 |";
    expect(renderDiscordMarkdown(text)).toBe("**bold** stays\n**k**\n- V: 1");
  });
});
