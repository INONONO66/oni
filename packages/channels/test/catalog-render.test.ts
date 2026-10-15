import { afterEach, describe, expect, test } from "bun:test";
import { Outbound } from "@openomni/protocol";
import { z } from "zod";
import { CallbackDataTooLong, RenderLimitExceeded } from "../src/errors";
import { renderDiscord } from "../src/provider/discord/render";
import { DiscordProvider } from "../src/provider/discord/provider";
import { GitHubProvider } from "../src/provider/github/provider";
import { renderSlack } from "../src/provider/slack/render";
import { SlackProvider } from "../src/provider/slack/provider";
import { renderTelegram } from "../src/provider/telegram/render";
import { TelegramProvider } from "../src/provider/telegram/provider";
import { WebhookProvider } from "../src/provider/webhook/provider";
import { downgrade } from "../src/support/downgrade";
import { escapeTelegramHtml, renderTelegramHtml } from "../src/support/format/telegram";
import { renderElementImage } from "../src/support/render-image";
import { type NativeStep, translate } from "../src/support/translate";
import { injectedOptions } from "./helpers/injected";

const spec: Outbound.Spec = {
  root: "choices",
  elements: {
    choices: { type: "Buttons", props: {}, children: ["yes", "docs"] },
    yes: { type: "Button", props: { label: "Yes", id: "vote:yes", style: "primary" }, children: [] },
    docs: { type: "Button", props: { label: "Docs", url: "https://example.test" }, children: [] },
    poll: { type: "Poll", props: { question: "Ready?", options: ["Yes", "No"], multi: true }, children: [] },
    card: { type: "Card", props: { title: "Report", body: "Finished", image: "https://example.test/report.png" }, children: [] },
    other: { type: "Card", props: { title: "Next", image: "https://example.test/next.png" }, children: [] },
    carousel: { type: "Carousel", props: {}, children: ["card", "other"] },
    table: { type: "Table", props: { columns: [{ header: "Name" }, { header: "Score" }], rows: [["A", "9"]] }, children: [] },
    markdown: { type: "Markdown", props: { text: "**ready**" }, children: [] },
    code: { type: "Code", props: { text: "const ready = true;", lang: "ts" }, children: [] },
    status: { type: "Status", props: { kind: "progress", title: "Working", body: "Soon" }, children: [] },
    divider: { type: "Divider", props: {}, children: [] },
    context: { type: "Context", props: { text: "Secondary" }, children: [] },
    image: { type: "Image", props: { ref: "https://example.test/image.png", caption: "Image" }, children: [] },
    file: { type: "File", props: { ref: "https://example.test/report.pdf", name: "report.pdf" }, children: [] },
    plain: { type: "Card", props: { title: "Plain", body: "Body" }, children: [] },
    sequence: { type: "Carousel", props: {}, children: ["card", "plain"] },
  },
};

function step(id: string): NativeStep {
  const element = spec.elements[id];
  if (element === undefined) throw new Error(`missing fixture element ${id}`);
  return { id, element, spec, digest: Outbound.text({ kind: "message", spec: { ...spec, root: id } }) };
}

describe("catalog native renderers", () => {
  test("Slack posts standard markdown as a markdown block and buttons as actions", () => {
    expect(renderSlack(step("markdown"))).toEqual([{ type: "markdown", text: "**ready**" }]);
    expect(renderSlack(step("choices"))).toEqual([{ type: "actions", elements: [
      { type: "button", text: { type: "plain_text", text: "Yes" }, action_id: "vote:yes", style: "primary" },
      { type: "button", text: { type: "plain_text", text: "Docs" }, action_id: "url:docs", url: "https://example.test" },
    ] }]);
  });

  test("Slack renders a table block with raw text cells", () => {
    expect(renderSlack(step("table"))).toEqual([{ type: "table", rows: [
      [{ type: "raw_text", text: "Name" }, { type: "raw_text", text: "Score" }],
      [{ type: "raw_text", text: "A" }, { type: "raw_text", text: "9" }],
    ] }]);
  });

  test("Slack renders the remaining native blocks and text fallbacks", () => {
    expect(renderSlack(step("code"))).toEqual([{ type: "section",
      text: { type: "mrkdwn", text: "```ts\nconst ready = true;\n```" } }]);
    expect(renderSlack(step("card"))).toEqual([
      { type: "header", text: { type: "plain_text", text: "Report" } },
      { type: "section", text: { type: "mrkdwn", text: "Finished" },
        accessory: { type: "image", image_url: "https://example.test/report.png", alt_text: "Report" } },
    ]);
    expect(renderSlack(step("yes"))).toEqual([{ type: "actions", elements: [
      { type: "button", text: { type: "plain_text", text: "Yes" }, action_id: "vote:yes", style: "primary" },
    ] }]);
    expect(renderSlack(step("status"))).toEqual([{ type: "section",
      text: { type: "mrkdwn", text: "*:hourglass_flowing_sand: Working*\nSoon" } }]);
    expect(renderSlack(step("divider"))).toEqual([{ type: "divider" }]);
    expect(renderSlack(step("context"))).toEqual([{ type: "context",
      elements: [{ type: "mrkdwn", text: "Secondary" }] }]);
    for (const id of ["carousel", "poll", "image", "file"])
      expect(renderSlack(step(id))).toEqual([{ type: "section",
        text: { type: "mrkdwn", text: step(id).digest } }]);
  });

  test("Slack falls back to code when a table cell exceeds the block limit", () => {
    const table = spec.elements.table;
    if (table?.type !== "Table") throw new Error("missing table fixture");
    const oversized: NativeStep = { ...step("table"), element: {
      ...table, props: { ...table.props, rows: [["x".repeat(2001), "9"]] },
    } };
    expect(renderSlack(oversized)).toEqual([{ type: "section",
      text: { type: "mrkdwn", text: "```\nName | Score\nA | 9\n```" } }]);
  });

  test("Slack escapes mrkdwn and splits long code into bounded sections", () => {
    const code: Outbound.Element = { type: "Code", props: {
      lang: "ts", text: `if (a<b && c>d) ${"x".repeat(4000)} <!channel>`,
    }, children: [] };
    const blocks = renderSlack({ ...step("code"), element: code });
    expect(blocks.length).toBeGreaterThan(1);
    expect(blocks.every((block) => block.type === "section"
      && typeof block.text === "object" && block.text !== null
      && "text" in block.text && typeof block.text.text === "string"
      && block.text.text.length <= 3000)).toBe(true);
    expect(JSON.stringify(blocks)).toContain("a&lt;b &amp;&amp; c&gt;d");
    expect(JSON.stringify(blocks)).not.toContain("<!channel>");
  });

  test("Discord renders button rows, media gallery, and native poll", () => {
    expect(renderDiscord(step("choices"))).toEqual({ components: [{ type: 1, components: [
      { type: 2, label: "Yes", style: 1, custom_id: "vote:yes" },
      { type: 2, label: "Docs", style: 5, url: "https://example.test" },
    ] }] });
    expect(renderDiscord(step("carousel"))).toEqual({ flags: 1 << 15, components: [{ type: 12,
      items: [
        { media: { url: "https://example.test/report.png" }, description: "Report\n\nFinished" },
        { media: { url: "https://example.test/next.png" }, description: "Next" },
      ] }] });
    expect(renderDiscord(step("poll"))).toEqual({ poll: {
      question: { text: "Ready?" },
      answers: [{ poll_media: { text: "Yes" } }, { poll_media: { text: "No" } }],
      duration: 24, allow_multiselect: true,
    } });
  });

  test("Discord renders cards, status, single buttons, and text fallbacks", () => {
    expect(renderDiscord(step("card"))).toEqual({ embeds: [{
      title: "Report", description: "Finished", image: { url: "https://example.test/report.png" },
    }] });
    expect(renderDiscord(step("yes"))).toEqual({ components: [{ type: 1, components: [
      { type: 2, label: "Yes", style: 1, custom_id: "vote:yes" },
    ] }] });
    expect(renderDiscord(step("status"))).toEqual({ content: "**⏳ Working**\nSoon" });
    for (const id of ["markdown", "code", "table", "context", "divider", "image", "file"])
      expect(renderDiscord(step(id))).toEqual({ content: step(id).digest });
  });

  test("Discord bounds component and embed collections", () => {
    const buttons: Outbound.Element = {
      type: "Buttons", props: {}, children: Array.from({ length: 26 }, (_, index) => `button-${index}`),
    };
    const cards: Outbound.Element = {
      type: "Carousel", props: {}, children: Array.from({ length: 11 }, (_, index) => `card-${index}`),
    };
    expect(() => renderDiscord({ ...step("choices"), element: buttons })).toThrow(RenderLimitExceeded);
    expect(() => renderDiscord({ ...step("carousel"), element: cards })).toThrow(RenderLimitExceeded);
    expect(() => renderDiscord(step("sequence"))).toThrow(RenderLimitExceeded);
  });

  test("Telegram renders HTML keyboard, media album, and native poll", () => {
    expect(renderTelegram(step("choices"))).toEqual({ method: "sendMessage", body: {
      text: "[Yes]\n\n[Docs](https://example.test)", parse_mode: "HTML",
      reply_markup: { inline_keyboard: [
        [{ text: "Yes", callback_data: "vote:yes" }],
        [{ text: "Docs", url: "https://example.test" }],
      ] },
    } });
    expect(renderTelegram(step("carousel"))).toEqual({ method: "sendMediaGroup", body: {
      media: [
        { type: "photo", media: "https://example.test/report.png", caption: "Report\n\nFinished\n\nNext", parse_mode: "HTML" },
        { type: "photo", media: "https://example.test/next.png" },
      ],
    } });
    expect(renderTelegram(step("poll"))).toEqual({ method: "sendPoll", body: {
      question: "Ready?", options: ["Yes", "No"], allows_multiple_answers: true,
    } });
    expect(renderTelegram(step("card"))).toEqual({ method: "sendPhoto", body: {
      photo: "https://example.test/report.png", caption: "<b>Report</b>\nFinished",
      parse_mode: "HTML",
    } });
  });

  test("Telegram refuses callbacks whose UTF-8 bytes exceed 64", () => {
    const long = "한".repeat(22);
    const longButton: Outbound.Element = { type: "Button", props: { id: long, label: "Long" }, children: [] };
    const longStep: NativeStep = { ...step("yes"), element: longButton,
      spec: { ...spec, elements: { ...spec.elements, yes: longButton } } };
    expect(() => renderTelegram(longStep)).toThrow(CallbackDataTooLong);
  });

  test("Telegram uses sendPhoto for a one-card image carousel", () => {
    const carousel: Outbound.Element = { type: "Carousel", props: {}, children: ["card"] };
    expect(renderTelegram({ ...step("carousel"), element: carousel, digest: "Report\n\nFinished" }))
      .toEqual({ method: "sendPhoto", body: {
        photo: "https://example.test/report.png", caption: "Report\n\nFinished", parse_mode: "HTML",
      } });
  });

  test.each([
    { name: "Discord button label", kind: "label", render: () => renderDiscord({
      ...step("yes"), element: { type: "Button", props: { label: "x".repeat(81), id: "go" }, children: [] },
    }) },
    { name: "Discord custom id", kind: "custom_id", render: () => renderDiscord({
      ...step("yes"), element: { type: "Button", props: { label: "Go", id: "x".repeat(101) }, children: [] },
    }) },
    { name: "Discord poll question", kind: "question", render: () => renderDiscord({
      ...step("poll"), element: { type: "Poll", props: { question: "x".repeat(301), options: ["A", "B"] }, children: [] },
    }) },
    { name: "Discord poll answer", kind: "answer", render: () => renderDiscord({
      ...step("poll"), element: { type: "Poll", props: { question: "Q", options: ["x".repeat(56), "B"] }, children: [] },
    }) },
    { name: "Discord message content", kind: "content", render: () => renderDiscord({
      ...step("status"), element: { type: "Status", props: { kind: "ok", title: "x".repeat(2000) }, children: [] },
    }) },
    { name: "Discord embed title", kind: "title", render: () => renderDiscord({
      ...step("plain"), element: { type: "Card", props: { title: "" }, children: [] },
    }) },
    { name: "Discord embed description", kind: "description", render: () => renderDiscord({
      ...step("plain"), element: { type: "Card", props: { title: "Title", body: "x".repeat(4097) }, children: [] },
    }) },
    { name: "Discord gallery description", kind: "description", render: () => {
      const oversized = { type: "Card" as const,
        props: { title: "Report", body: "x".repeat(1025), image: "https://example.test/report.png" },
        children: [] };
      return renderDiscord({ ...step("carousel"), spec: { ...spec, elements: {
        ...spec.elements, card: oversized,
      } } });
    } },
    { name: "Slack empty header", kind: "title", render: () => renderSlack({
      ...step("plain"), element: { type: "Card", props: { title: "" }, children: [] },
    }) },
    { name: "Slack long header", kind: "title", render: () => renderSlack({
      ...step("plain"), element: { type: "Card", props: { title: "x".repeat(151) }, children: [] },
    }) },
    { name: "Slack button label", kind: "label", render: () => renderSlack({
      ...step("yes"), element: { type: "Button", props: { label: "x".repeat(76), id: "go" }, children: [] },
    }) },
    { name: "Slack action id", kind: "action_id", render: () => renderSlack({
      ...step("yes"), element: { type: "Button", props: { label: "Go", id: "x".repeat(256) }, children: [] },
    }) },
    { name: "Telegram photo caption", kind: "caption", render: () => renderTelegram({
      ...step("card"), element: { type: "Card", props: {
        title: "Report", body: "x".repeat(1025), image: "https://example.test/report.png",
      }, children: [] },
    }) },
    { name: "Telegram album caption", kind: "caption", render: () => renderTelegram({
      ...step("carousel"), spec: { ...spec, elements: { ...spec.elements, card: { type: "Card", props: {
        title: "Report", body: "x".repeat(1025), image: "https://example.test/report.png",
      }, children: [] } } },
    }) },
    { name: "Telegram status text", kind: "content", render: () => renderTelegram({
      ...step("status"), element: { type: "Status", props: { kind: "ok", title: "x".repeat(4096) }, children: [] },
    }) },
    { name: "Telegram empty Buttons", kind: "buttons", render: () => renderTelegram({
      ...step("choices"), element: { type: "Buttons", props: {}, children: [] },
    }) },
  ])("$name refuses overlong or empty fields before send", ({ kind, render }) => {
    let failure: Error | undefined;
    try { render(); } catch (error) {
      if (!(error instanceof Error)) throw error;
      failure = error;
    }
    expect(failure).toBeInstanceOf(RenderLimitExceeded);
    expect(failure).toMatchObject({ kind });
  });

  test("Telegram renders plain cards, status, and text fallbacks", () => {
    expect(renderTelegram(step("plain"))).toEqual({ method: "sendMessage", body: {
      text: "<b>Plain</b>\nBody", parse_mode: "HTML",
    } });
    expect(renderTelegram(step("status"))).toEqual({ method: "sendMessage", body: {
      text: "<b>⏳ Working</b>\nSoon", parse_mode: "HTML",
    } });
    for (const id of ["markdown", "code", "table", "context", "divider", "image", "file"])
      expect(renderTelegram(step(id))).toEqual({ method: "sendMessage", body: {
        text: escapeTelegramHtml(step(id).digest),
        parse_mode: "HTML",
      } });
    expect(() => renderTelegram(step("sequence"))).toThrow(RenderLimitExceeded);
  });

  test("Telegram escapes the HTML fallback carried with inline buttons", () => {
    const unsafe: Outbound.Element = {
      type: "Button", props: { id: "safe", label: "<Choose>" }, children: [],
    };
    expect(renderTelegram({
      ...step("yes"),
      element: unsafe,
      digest: "[<Choose>]",
      spec: { ...spec, elements: { ...spec.elements, yes: unsafe } },
    })).toEqual({ method: "sendMessage", body: {
      text: "[&lt;Choose&gt;]", parse_mode: "HTML",
      reply_markup: { inline_keyboard: [[{ text: "<Choose>", callback_data: "safe" }]] },
    } });
  });
});

describe("catalog downgrades", () => {
  test("Telegram HTML encodes markdown and escapes literal tags and link attributes", () => {
    expect(renderTelegramHtml("**A & B** [link](https://example.test/?x=1&y=2) <raw>"))
      .toBe('<b>A &amp; B</b> <a href="https://example.test/?x=1&amp;y=2">link</a> &lt;raw&gt;');
    expect(renderTelegramHtml("```ts\nconst x = '<';\n```"))
      .toBe('<pre><code class="language-ts">const x = \'&lt;\';\n</code></pre>');
  });
  test("table bullets preserve every column without relying on a GFM separator", () => {
    expect(downgrade("table-to-bullets", "table", spec)).toEqual({
      kind: "text", text: "- Name: A\n- Score: 9",
    });
  });

  test("every named text and sequence downgrade preserves its intended reading", () => {
    expect(downgrade("table-to-code", "table", spec)).toEqual({
      kind: "text", text: "```\nName | Score\nA | 9\n```",
    });
    expect(downgrade("table-to-bullets", "plain", spec)).toEqual({
      kind: "text", text: "Plain\n\nBody",
    });
    expect(downgrade("table-to-image", "table", spec)).toMatchObject({
      kind: "image", caption: "Name | Score\nA | 9",
    });
    expect(downgrade("carousel-to-sequence", "carousel", spec)).toEqual({
      kind: "sequence", ids: ["card", "other"],
    });
    expect(downgrade("carousel-to-album", "carousel", spec)).toEqual({
      kind: "album", ids: ["card", "other"],
    });
    expect(downgrade("status-to-bold", "status", spec)).toEqual({
      kind: "text", text: "**PROGRESS: Working\n\nSoon**",
    });
    expect(downgrade("buttons-to-numbered-list", "choices", spec)).toEqual({
      kind: "text", text: "1. Yes\n2. Docs (https://example.test)",
    });
    const malformed: Outbound.Spec = {
      root: "invalid",
      elements: { ...spec.elements,
        invalid: { type: "Buttons", props: {}, children: ["context"] } },
    };
    expect(downgrade("buttons-to-numbered-list", "invalid", malformed)).toEqual({
      kind: "text", text: "1. Secondary",
    });
    expect(downgrade("divider-to-rule", "divider", spec)).toEqual({
      kind: "text", text: "───",
    });
    expect(downgrade("card-to-caption-keyboard", "card", spec)).toEqual({
      kind: "caption-keyboard", caption: "Report\n\nFinished",
      image: "https://example.test/report.png", buttons: [],
    });
    expect(downgrade("card-to-caption-keyboard", "status", spec)).toEqual({
      kind: "text", text: "PROGRESS: Working\n\nSoon",
    });
    expect(downgrade("table-to-code", "missing", spec)).toEqual({ kind: "text", text: "" });
  });

  test("poll-to-buttons produces actionable postback choices and question", () => {
    const result = downgrade("poll-to-buttons", "poll", spec);
    expect(result.kind).toBe("sequence");
    if (result.kind !== "sequence") return;
    expect(result.ids).toEqual(["poll:question", "poll:choices:0"]);
    expect(result.spec?.elements["poll:option:0"]).toEqual({
      type: "Button", props: { id: "poll:option:0", label: "Yes" }, children: [],
    });
  });

  test("native and downgraded polls refuse unsupported option counts", () => {
    const poll = spec.elements.poll;
    if (poll?.type !== "Poll") throw new Error("missing poll fixture");
    const invalid: Outbound.Spec = { ...spec, elements: { ...spec.elements,
      poll: { ...poll, props: { ...poll.props, options: ["Only one"] } } } };
    expect(() => downgrade("poll-to-buttons", "poll", invalid)).toThrow(RenderLimitExceeded);
    expect(() => renderDiscord({ ...step("poll"), spec: invalid, element: invalid.elements.poll ?? poll }))
      .toThrow(RenderLimitExceeded);
  });

  test("image downgrade remains a declared result, never a silent text send", () => {
    expect(downgrade("card-to-image", "card", spec)).toMatchObject({ kind: "image", caption: "Report\n\nFinished" });
  });

  test("table image rasterization produces PNG bytes with its bundled font", async () => {
    const element = spec.elements.table;
    if (element === undefined) throw new Error("missing table fixture");
    const image = await renderElementImage(element, "Name | Score\nA | 9");
    expect(image.mime).toBe("image/png");
    expect([...image.bytes.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  });
});

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function capture(platform: "slack" | "discord" | "telegram"): Request[] {
  const calls: Request[] = [];
  globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(String(input), init);
    calls.push(request);
    return platform === "slack" ? Response.json({ ok: true, ts: "1.2" })
      : platform === "telegram" ? Response.json({ ok: true, result: { message_id: 12 } })
      : Response.json({ id: "12" });
  }, { preconnect: originalFetch.preconnect });
  return calls;
}

describe("catalog surface request bodies", () => {
  test("Slack sends Block Kit with a notification fallback", async () => {
    const calls = capture("slack");
    const runtime = SlackProvider.create({ botToken: "xoxb-test", appToken: "xapp-test" }, {}, () => undefined, injectedOptions());
    expect(await runtime.deliveryRoute?.("T1:U1", { kind: "message", spec: { ...spec, root: "choices" } }, "slack-native",
      { channelId: "C1" })).toEqual({ value: "accepted", externalMessageId: "1.2" });
    expect(await calls[0]?.json()).toEqual({
      channel: "C1", text: "[Yes]\n\n[Docs](https://example.test)",
      blocks: [{ type: "actions", elements: [
        { type: "button", text: { type: "plain_text", text: "Yes" },
          action_id: "vote:yes", style: "primary" },
        { type: "button", text: { type: "plain_text", text: "Docs" },
          action_id: "url:docs", url: "https://example.test" },
      ] }],
    });
  });

  test("Discord sends components in its existing message endpoint", async () => {
    const calls = capture("discord");
    const runtime = DiscordProvider.create({ token: "dc-test" }, {}, () => undefined, injectedOptions());
    expect(await runtime.deliveryRoute?.("U1", { kind: "message", spec: { ...spec, root: "choices" } }, "discord-native",
      { channelId: "C1" })).toEqual({ value: "accepted", externalMessageId: "12" });
    expect(await calls[0]?.json()).toEqual({ components: [{ type: 1, components: [
      { type: 2, label: "Yes", style: 1, custom_id: "vote:yes" },
      { type: 2, label: "Docs", style: 5, url: "https://example.test" },
    ] }] });
  });

  test("Telegram sends a poll through sendPoll with chat identity", async () => {
    const calls = capture("telegram");
    const runtime = TelegramProvider.create({ token: "tg-test" }, {}, () => undefined, injectedOptions());
    expect(await runtime.deliveryRoute?.("123", { kind: "message", spec: { ...spec, root: "poll" } }, "telegram-native"))
      .toEqual({ value: "accepted", externalMessageId: "12" });
    expect(calls[0]?.url).toBe("https://api.telegram.org/bottg-test/sendPoll");
    expect(await calls[0]?.json()).toEqual({ chat_id: "123",
      question: "Ready?", options: ["Yes", "No"], allows_multiple_answers: true });
  });

  test("GitHub posts a spec digest including the link through its real comment route", async () => {
    const posted: string[] = [];
    globalThis.fetch = Object.assign(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "GET") return Response.json([]);
      const payload = z.object({ body: z.string() }).parse(JSON.parse(String(init?.body)));
      posted.push(payload.body);
      return Response.json({ id: 12 });
    }, { preconnect: originalFetch.preconnect });
    const runtime = GitHubProvider.create({ secret: "hook", token: "token" }, {}, () => undefined, injectedOptions());
    expect(await runtime.deliveryRoute?.("owner/repo#7",
      { kind: "message", spec: { ...spec, root: "choices" } }, "gh-spec"))
      .toEqual({ value: "accepted", externalMessageId: "12" });
    expect(posted).toEqual(["[Yes]\n\n[Docs](https://example.test)\n\n<!-- openomni-delivery:gh-spec -->"]);
  });

  test("the webhook text-only policy retains the spec digest", async () => {
    const sent: string[] = [];
    expect(WebhookProvider.capabilities.deliver).toBe(false);
    await translate({ kind: "message", spec: { ...spec, root: "choices" } },
      WebhookProvider.capabilities.render, {
        text: async (text) => { sent.push(text); return "receipt"; },
      });
    expect(sent).toEqual(["[Yes]\n\n[Docs](https://example.test)"]);
  });

  test("Slack classifies a button limit as rejected before any API call", async () => {
    const calls = capture("slack");
    const children = Array.from({ length: 6 }, (_, index) => `choice-${index}`);
    const oversized: Outbound.Spec = {
      root: "buttons",
      elements: {
        buttons: { type: "Buttons", props: {}, children },
        ...Object.fromEntries(children.map((id) => [
          id, { type: "Button", props: { id, label: id }, children: [] },
        ])),
      },
    };
    const runtime = SlackProvider.create({ botToken: "xoxb-test", appToken: "xapp-test" }, {}, () => undefined, injectedOptions());
    expect(await runtime.deliveryRoute?.("T1:U1", { kind: "message", spec: oversized }, "slack-limit",
      { channelId: "C1" })).toEqual({ value: "rejected" });
    expect(calls).toEqual([]);
  });

  test("Telegram rejects an oversized callback before the preceding text posts", async () => {
    const calls = capture("telegram");
    const oversized: Outbound.Spec = {
      root: "stack",
      elements: {
        stack: { type: "Stack", props: {}, children: ["intro", "choices"] },
        intro: { type: "Markdown", props: { text: "before" }, children: [] },
        choices: { type: "Buttons", props: {}, children: ["choice"] },
        choice: { type: "Button", props: { id: "한".repeat(22), label: "Long" }, children: [] },
      },
    };
    const runtime = TelegramProvider.create({ token: "tg-test" }, {}, () => undefined, injectedOptions());
    expect(await runtime.deliveryRoute?.("123", { kind: "message", spec: oversized }, "tg-limit"))
      .toEqual({ value: "rejected" });
    expect(calls).toEqual([]);
  });
});
