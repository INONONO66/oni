import type { PlainValue } from "@openomni/protocol";
import { CallbackDataTooLong, RenderLimitExceeded } from "../../errors.js";
import { escapeTelegramHtml } from "../../support/format/telegram.js";
import type { NativeStep } from "../../support/translate.js";

export type TelegramBody = Record<string, PlainValue>;
type TelegramNative = { readonly method: "sendMessage" | "sendPoll" | "sendPhoto" | "sendMediaGroup"; readonly body: TelegramBody };

function renderKeyboard(step: NativeStep): TelegramNative {
  const { element, spec } = step;
  const children = element.type === "Buttons" ? element.children : [step.id];
  if (children.length > 100)
    throw new RenderLimitExceeded({ kind: "buttons", count: children.length, limit: 100 });
  const keyboard = children.flatMap((id) => {
    const button = spec.elements[id];
    if (button?.type !== "Button") return [];
    const p = button.props;
    if ("id" in p && Buffer.byteLength(p.id, "utf8") > 64)
      throw new CallbackDataTooLong({ id: p.id, bytes: Buffer.byteLength(p.id, "utf8") });
    return [[{ text: p.label, ...("url" in p ? { url: p.url } : { callback_data: p.id }) }]];
  });
  return { method: "sendMessage", body: { text: step.digest,
    parse_mode: "HTML", reply_markup: { inline_keyboard: keyboard } } };
}

function renderAlbum(step: NativeStep): TelegramNative {
  const { element, spec } = step;
  if (element.children.length < 2 || element.children.length > 10)
    throw new RenderLimitExceeded({ kind: "cards", count: element.children.length, limit: 10 });
  const cards = element.children.map((id) => spec.elements[id]);
  if (!cards.every((card) => card?.type === "Card" && card.props.image !== undefined))
    return { method: "sendMessage", body: { text: escapeTelegramHtml(step.digest), parse_mode: "HTML" } };
  return { method: "sendMediaGroup", body: { media: cards.map((card, index) =>
    card?.type === "Card" ? { type: "photo", media: card.props.image ?? "",
      ...(index === 0 ? { caption: escapeTelegramHtml(step.digest), parse_mode: "HTML" } : {}) } : {}) } };
}

export function renderTelegram(step: NativeStep): TelegramNative {
  const { element } = step;
  switch (element.type) {
    case "Buttons":
    case "Button":
      return renderKeyboard(step);
    case "Card":
      return element.props.image === undefined || !element.props.image.startsWith("https://")
        ? { method: "sendMessage", body: { text: `<b>${escapeTelegramHtml(element.props.title)}</b>${element.props.body === undefined ? "" : `\n${escapeTelegramHtml(element.props.body)}`}`, parse_mode: "HTML" } }
        : { method: "sendPhoto", body: { photo: element.props.image,
          caption: `<b>${escapeTelegramHtml(element.props.title)}</b>${element.props.body === undefined ? "" : `\n${escapeTelegramHtml(element.props.body)}`}`, parse_mode: "HTML" } };
    case "Carousel":
      return renderAlbum(step);
    case "Poll":
      if (element.props.options.length < 2 || element.props.options.length > 10)
        throw new RenderLimitExceeded({ kind: "options", count: element.props.options.length, limit: 10 });
      return { method: "sendPoll", body: { question: element.props.question,
        options: element.props.options, allows_multiple_answers: element.props.multi ?? false } };
    case "Status": {
      const icon = { ok: "✅", warn: "⚠️", fail: "❌", progress: "⏳" }[element.props.kind];
      return { method: "sendMessage", body: { text: `<b>${icon} ${escapeTelegramHtml(element.props.title)}</b>${element.props.body === undefined ? "" : `\n${escapeTelegramHtml(element.props.body)}`}`, parse_mode: "HTML" } };
    }
    case "Markdown":
    case "Code":
    case "Table":
    case "Context":
    case "Divider":
    case "Image":
    case "File":
      return { method: "sendMessage", body: { text: escapeTelegramHtml(step.digest), parse_mode: "HTML" } };
  }
}
