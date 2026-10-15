import type { PlainValue } from "@openomni/protocol";
import { CallbackDataTooLong, RenderLimitExceeded } from "../../errors.js";
import { cardCaption } from "../../support/downgrade.js";
import { escapeTelegramHtml } from "../../support/format/telegram.js";
import { bounded } from "../../support/render-limits.js";
import type { NativeStep } from "../../support/translate.js";

export type TelegramBody = Record<string, PlainValue>;
type TelegramNative = { readonly method: "sendMessage" | "sendPoll" | "sendPhoto" | "sendMediaGroup"; readonly body: TelegramBody };

function inlineKeyboard(ids: readonly string[], step: NativeStep): PlainValue[] {
  const buttons = ids.flatMap((id) => {
    const element = step.spec.elements[id];
    return element?.type === "Buttons" ? element.children : [id];
  });
  if (buttons.length > 100)
    throw new RenderLimitExceeded({ kind: "buttons", count: buttons.length, limit: 100 });
  return buttons.flatMap((id) => {
    const button = step.spec.elements[id];
    if (button?.type !== "Button") return [];
    const p = button.props;
    if ("id" in p && Buffer.byteLength(p.id, "utf8") > 64)
      throw new CallbackDataTooLong({ id: p.id, bytes: Buffer.byteLength(p.id, "utf8") });
    return [[{ text: p.label, ...("url" in p ? { url: p.url } : { callback_data: p.id }) }]];
  });
}

function renderKeyboard(step: NativeStep): TelegramNative {
  const children = step.element.type === "Buttons" ? step.element.children : [step.id];
  const keyboard = inlineKeyboard(children, step);
  if (keyboard.length === 0)
    throw new RenderLimitExceeded({ kind: "buttons", count: 0, limit: 100 });
  return { method: "sendMessage", body: { text: bounded(escapeTelegramHtml(step.digest), "content", 4096),
    parse_mode: "HTML", reply_markup: { inline_keyboard: keyboard } } };
}

function renderAlbum(step: NativeStep): TelegramNative {
  const { element, spec } = step;
  if (element.children.length < 1 || element.children.length > 10)
    throw new RenderLimitExceeded({ kind: "cards", count: element.children.length, limit: 10 });
  const cards = element.children.flatMap((id) => {
    const card = spec.elements[id];
    return card?.type === "Card" && card.props.image?.startsWith("https://") ? [{ card, image: card.props.image }] : [];
  });
  if (cards.length !== element.children.length)
    throw new RenderLimitExceeded({ kind: "cards", count: cards.length, limit: 10 });
  const caption = bounded(escapeTelegramHtml(cards.map(({ card }) => cardCaption(card)).join("\n\n")), "caption", 1024);
  const [first] = cards;
  if (cards.length === 1 && first !== undefined)
    return { method: "sendPhoto", body: { photo: first.image, caption, parse_mode: "HTML" } };
  return { method: "sendMediaGroup", body: { media: cards.map(({ image }, index) =>
    ({ type: "photo", media: image, ...(index === 0 ? { caption, parse_mode: "HTML" } : {}) })) } };
}

export function renderTelegram(step: NativeStep): TelegramNative {
  const { element } = step;
  switch (element.type) {
    case "Buttons":
    case "Button":
      return renderKeyboard(step);
    case "Card": {
      const caption = `<b>${escapeTelegramHtml(element.props.title)}</b>${element.props.body === undefined ? "" : `\n${escapeTelegramHtml(element.props.body)}`}`;
      return element.props.image === undefined || !element.props.image.startsWith("https://")
        ? { method: "sendMessage", body: { text: bounded(caption, "content", 4096), parse_mode: "HTML" } }
        : { method: "sendPhoto", body: { photo: element.props.image,
          caption: bounded(caption, "caption", 1024), parse_mode: "HTML" } };
    }
    case "Carousel":
      return renderAlbum(step);
    case "Poll":
      if (element.props.options.length < 2 || element.props.options.length > 10)
        throw new RenderLimitExceeded({ kind: "options", count: element.props.options.length, limit: 10 });
      return { method: "sendPoll", body: { question: element.props.question,
        options: element.props.options, allows_multiple_answers: element.props.multi ?? false } };
    case "Status": {
      const icon = { ok: "✅", warn: "⚠️", fail: "❌", progress: "⏳" }[element.props.kind];
      return { method: "sendMessage", body: { text: bounded(`<b>${icon} ${escapeTelegramHtml(element.props.title)}</b>${element.props.body === undefined ? "" : `\n${escapeTelegramHtml(element.props.body)}`}`, "content", 4096), parse_mode: "HTML" } };
    }
    case "Stack":
    case "Markdown":
    case "Code":
    case "Table":
    case "Context":
    case "Divider":
    case "Image":
    case "File":
      return { method: "sendMessage", body: { text: bounded(escapeTelegramHtml(step.digest), "content", 4096), parse_mode: "HTML" } };
  }
}
