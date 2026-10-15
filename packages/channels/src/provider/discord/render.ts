import type { Outbound, PlainValue } from "@openomni/protocol";
import { RenderLimitExceeded } from "../../errors.js";
import { bounded } from "../../support/render-limits.js";
import type { NativeStep } from "../../support/translate.js";

export type DiscordBody = Record<string, PlainValue>;

function cardEmbed(title: string, body?: string, image?: string): PlainValue {
  return { title: bounded(title, "title", 256),
    ...(body === undefined ? {} : { description: bounded(body, "description", 4096) }),
    ...(image === undefined ? {} : { image: { url: image } }) };
}

function buttonComponent(button: Extract<Outbound.Element, { type: "Button" }>): PlainValue {
  const p = button.props;
  return { type: 2, label: bounded(p.label, "label", 80),
    style: "url" in p ? 5 : p.style === "primary" ? 1 : p.style === "danger" ? 4 : 2,
    ...("url" in p ? { url: p.url } : { custom_id: bounded(p.id, "custom_id", 100) }) };
}

function renderCarousel(element: Extract<Outbound.Element, { type: "Carousel" }>, spec: Outbound.Spec): DiscordBody {
  if (element.children.length > 10)
    throw new RenderLimitExceeded({ kind: "cards", count: element.children.length, limit: 10 });
  const cards = element.children.flatMap((id) => {
    const child = spec.elements[id];
    return child?.type === "Card" ? [child] : [];
  });
  if (cards.length !== element.children.length || cards.some((card) => !card.props.image?.startsWith("https://")))
    throw new RenderLimitExceeded({ kind: "cards", count: cards.length, limit: 10 });
  return { flags: 1 << 15, components: [{ type: 12,
    items: cards.map((card) => ({ media: { url: card.props.image ?? "" },
      description: bounded(card.props.body === undefined ? card.props.title
        : `${card.props.title}\n\n${card.props.body}`, "description", 1024) })) }] };
}

function renderButtons(element: Extract<Outbound.Element, { type: "Buttons" }>, spec: Outbound.Spec): DiscordBody {
  if (element.children.length > 25)
    throw new RenderLimitExceeded({ kind: "buttons", count: element.children.length, limit: 25 });
  const buttons = element.children.flatMap((id) => {
    const child = spec.elements[id];
    return child?.type === "Button" ? [buttonComponent(child)] : [];
  });
  const rows: PlainValue[] = [];
  for (let index = 0; index < buttons.length; index += 5)
    rows.push({ type: 1, components: buttons.slice(index, index + 5) });
  return { components: rows };
}

export function renderDiscord(step: NativeStep): DiscordBody {
  const { element, spec } = step;
  switch (element.type) {
    case "Card":
      return { embeds: [cardEmbed(element.props.title, element.props.body, element.props.image)] };
    case "Carousel": {
      return renderCarousel(element, spec);
    }
    case "Buttons": {
      return renderButtons(element, spec);
    }
    case "Button": {
      return { components: [{ type: 1, components: [buttonComponent(element)] }] };
    }
    case "Poll":
      if (element.props.options.length < 2 || element.props.options.length > 10)
        throw new RenderLimitExceeded({ kind: "options", count: element.props.options.length, limit: 10 });
      return { poll: { question: { text: bounded(element.props.question, "question", 300) },
        answers: element.props.options.map((text) => ({ poll_media: { text: bounded(text, "answer", 55) } })),
        duration: 24, allow_multiselect: element.props.multi ?? false } };
    case "Status": {
      const icon = { ok: "✅", warn: "⚠️", fail: "❌", progress: "⏳" }[element.props.kind];
      return { content: bounded(`**${icon} ${element.props.title}**${element.props.body === undefined ? "" : `\n${element.props.body}`}`, "content", 2000) };
    }
    case "Stack":
    case "Markdown":
    case "Code":
    case "Table":
    case "Context":
    case "Divider":
    case "Image":
    case "File":
      return { content: bounded(step.digest, "content", 2000) };
  }
}
