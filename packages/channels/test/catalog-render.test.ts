import { afterEach, describe, expect, test } from "bun:test";
import { Outbound } from "@openomni/protocol";
import { CallbackDataTooLong, RenderLimitExceeded } from "../src/errors";
import { renderDiscord } from "../src/provider/discord/render";
import { DiscordProvider } from "../src/provider/discord/provider";
import { renderSlack } from "../src/provider/slack/render";
import { SlackProvider } from "../src/provider/slack/provider";
import { renderTelegram } from "../src/provider/telegram/render";
import { TelegramProvider } from "../src/provider/telegram/provider";
import { downgrade } from "../src/support/downgrade";
import { renderTelegramHtml } from "../src/support/format/telegram";
import { renderElementImage } from "../src/support/render-image";
import type { NativeStep } from "../src/support/translate";
import { injectedOptions } from "./helpers/injected";

const spec: Outbound.Spec = {
  root: "choices",
  elements: {
    choices: { type: "Buttons", props: {}, children: ["yes", "docs"] },
    yes: { type: "Button", props: { label: "Yes", id: "vote:yes", style: "primary" }, children: [] },
    docs: { type: "Button", props: { label: "Docs", url: "https://example.test" }, children: [] },
    poll: { type: "Poll", props: { question: "Ready?", options: ["Yes", "No"], multi: true }, children: [] },
    card: { type: "Card", props: { title: "Report", body: "Finished", image: "https://example.test/report.png" }, children: ["choices"] },
    other: { type: "Card", props: { title: "Next", image: "https://example.test/next.png" }, children: [] },
    carousel: { type: "Carousel", props: {}, children: ["card", "other"] },
    table: { type: "Table", props: { columns: [{ header: "Name" }, { header: "Score" }], rows: [["A", "9"]] }, children: [] },
    markdown: { type: "Markdown", props: { text: "**ready**" }, children: [] },
  },
};

function step(id: string): NativeStep {
  const element = spec.elements[id];
  if (element === undefined) throw new Error(`missing fixture element ${id}`);
  return { id, element, spec, digest: Outbound.text({ kind: "message", spec: { ...spec, root: id } }), attachments: {} };
}

describe("catalog native renderers", () => {
  test("Slack posts standard markdown as a markdown block and buttons as actions", () => {
    expect(renderSlack(step("markdown"))).toEqual([{ type: "markdown", text: "**ready**" }]);
    expect(renderSlack(step("choices"))).toEqual([{ type: "actions", elements: [
      { type: "button", text: { type: "plain_text", text: "Yes" }, action_id: "vote:yes", style: "primary" },
      { type: "button", text: { type: "plain_text", text: "Docs" }, action_id: "docs", url: "https://example.test" },
    ] }]);
  });

  test("Slack renders a table block with raw text cells", () => {
    expect(renderSlack(step("table"))).toEqual([{ type: "table", rows: [
      [{ type: "raw_text", text: "Name" }, { type: "raw_text", text: "Score" }],
      [{ type: "raw_text", text: "A" }, { type: "raw_text", text: "9" }],
    ] }]);
  });

  test("Slack falls back to code when a table cell exceeds the block limit", () => {
    const table = spec.elements.table;
    if (table?.type !== "Table") throw new Error("missing table fixture");
    const oversized: NativeStep = { ...step("table"), element: {
      ...table, props: { ...table.props, rows: [["x".repeat(2001), "9"]] },
    } };
    expect(renderSlack(oversized)).toEqual([{ type: "section",
      text: { type: "mrkdwn", text: "```Name | Score\nA | 9```" } }]);
  });

  test("Discord renders button rows, media gallery, and native poll", () => {
    expect(renderDiscord(step("choices"))).toEqual({ components: [{ type: 1, components: [
      { type: 2, label: "Yes", style: 1, custom_id: "vote:yes" },
      { type: 2, label: "Docs", style: 5, url: "https://example.test" },
    ] }] });
    expect(renderDiscord(step("carousel"))).toEqual({ flags: 1 << 15, components: [{ type: 12,
      items: [
        { media: { url: "https://example.test/report.png" }, description: "Report" },
        { media: { url: "https://example.test/next.png" }, description: "Next" },
      ] }] });
    expect(renderDiscord(step("poll"))).toEqual({ poll: {
      question: { text: "Ready?" },
      answers: [{ poll_media: { text: "Yes" } }, { poll_media: { text: "No" } }],
      duration: 24, allow_multiselect: true,
    } });
  });

  test("Telegram renders HTML keyboard, media album, and native poll", () => {
    expect(renderTelegram(step("choices"))).toEqual({ method: "sendMessage", body: {
      text: "[Yes]\n\n[Docs]", parse_mode: "HTML",
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
      parse_mode: "HTML", reply_markup: { inline_keyboard: [
        [{ text: "Yes", callback_data: "vote:yes" }],
        [{ text: "Docs", url: "https://example.test" }],
      ] },
    } });
  });

  test("Telegram refuses callbacks whose UTF-8 bytes exceed 64", () => {
    const long = "한".repeat(22);
    const longButton: Outbound.Element = { type: "Button", props: { id: long, label: "Long" }, children: [] };
    const longStep: NativeStep = { ...step("yes"), element: longButton,
      spec: { ...spec, elements: { ...spec.elements, yes: longButton } } };
    expect(() => renderTelegram(longStep)).toThrow(CallbackDataTooLong);
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
      channel: "C1", text: "[Yes]\n\n[Docs]", blocks: renderSlack(step("choices")),
    });
  });

  test("Discord sends components in its existing message endpoint", async () => {
    const calls = capture("discord");
    const runtime = DiscordProvider.create({ token: "dc-test" }, {}, () => undefined, injectedOptions());
    expect(await runtime.deliveryRoute?.("U1", { kind: "message", spec: { ...spec, root: "choices" } }, "discord-native",
      { channelId: "C1" })).toEqual({ value: "accepted", externalMessageId: "12" });
    expect(await calls[0]?.json()).toEqual(renderDiscord(step("choices")));
  });

  test("Telegram sends a poll through sendPoll with chat identity", async () => {
    const calls = capture("telegram");
    const runtime = TelegramProvider.create({ token: "tg-test" }, {}, () => undefined, injectedOptions());
    expect(await runtime.deliveryRoute?.("123", { kind: "message", spec: { ...spec, root: "poll" } }, "telegram-native"))
      .toEqual({ value: "accepted", externalMessageId: "12" });
    expect(calls[0]?.url).toBe("https://api.telegram.org/bottg-test/sendPoll");
    expect(await calls[0]?.json()).toEqual({ chat_id: "123", ...renderTelegram(step("poll")).body });
  });
});
