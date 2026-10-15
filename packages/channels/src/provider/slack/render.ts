import type { Outbound, PlainValue } from "@openomni/protocol";
import { DeliveryNotSent, RenderLimitExceeded } from "../../errors.js";
import { chunkMarkdown } from "../../support/format/chunk.js";
import { bounded } from "../../support/render-limits.js";
import type { NativeStep } from "../../support/translate.js";

export type SlackBlock = Record<string, PlainValue>;
export const URL_ACTION_PREFIX = "url:";

const STATUS = {
  ok: ":white_check_mark:", warn: ":warning:", fail: ":x:", progress: ":hourglass_flowing_sand:",
} as const;

export function escapeSlackText(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function sections(text: string, accessory?: PlainValue): SlackBlock[] {
  return chunkMarkdown(text, 3000).map((chunk, index) => ({
    type: "section",
    text: { type: "mrkdwn", text: chunk },
    ...(index === 0 && accessory !== undefined ? { accessory } : {}),
  }));
}

function buttonElement(id: string, element: Extract<Outbound.Element, { type: "Button" }>): PlainValue {
  const props = element.props;
  if ("id" in props && props.id.startsWith(URL_ACTION_PREFIX))
    throw new DeliveryNotSent({ operation: "slack.button", cause: "callback id uses the reserved URL prefix" });
  return {
    type: "button", text: { type: "plain_text", text: bounded(props.label, "label", 75) },
    action_id: bounded("url" in props ? `${URL_ACTION_PREFIX}${id}` : props.id, "action_id", 255),
    ...("url" in props ? { url: props.url } : {}),
    ...(props.style === "primary" || props.style === "danger" ? { style: props.style } : {}),
  };
}

export function renderSlack(step: NativeStep): readonly SlackBlock[] {
  const { element, spec } = step;
  switch (element.type) {
    case "Markdown":
      return [{ type: "markdown", text: element.props.text }];
    case "Code":
      return sections(`\`\`\`${element.props.lang ?? ""}\n${escapeSlackText(element.props.text)}\n\`\`\``);
    case "Table": {
      const rows = [element.props.columns.map((column) => column.header), ...element.props.rows];
      if (rows.length > 100 || rows.some((row) => row.length > 20 || row.some((cell) => cell.length > 2000)))
        return sections(`\`\`\`\n${escapeSlackText(step.digest)}\n\`\`\``);
      return [{ type: "table", rows: rows.map((row) => row.map((text) => ({ type: "raw_text", text }))) }];
    }
    case "Card": {
      const title = bounded(element.props.title, "title", 150);
      return [
        { type: "header", text: { type: "plain_text", text: title } },
        ...sections(escapeSlackText(element.props.body ?? title),
          element.props.image?.startsWith("https://")
            ? { type: "image", image_url: element.props.image, alt_text: title }
            : undefined),
      ];
    }
    case "Buttons": {
      if (element.children.length > 5)
        throw new RenderLimitExceeded({ kind: "buttons", count: element.children.length, limit: 5 });
      const buttons = element.children.flatMap((child) => {
        const button = spec.elements[child];
        if (button?.type !== "Button") return [];
        return [buttonElement(child, button)];
      });
      return [{ type: "actions", elements: buttons }];
    }
    case "Button":
      return [{ type: "actions", elements: [buttonElement(step.id, element)] }];
    case "Status":
      return sections(`*${STATUS[element.props.kind]} ${escapeSlackText(element.props.title)}*${element.props.body === undefined ? "" : `\n${escapeSlackText(element.props.body)}`}`);
    case "Divider":
      return [{ type: "divider" }];
    case "Context":
      return chunkMarkdown(escapeSlackText(element.props.text), 2000).map((text) => ({
        type: "context", elements: [{ type: "mrkdwn", text }],
      }));
    case "Stack":
    case "Poll":
    case "Carousel":
    case "Image":
    case "File":
      return sections(escapeSlackText(step.digest));
  }
}

export function splitSlackBlocks(blocks: readonly SlackBlock[]): readonly (readonly SlackBlock[])[] {
  const batches: SlackBlock[][] = [];
  for (let index = 0; index < blocks.length; index += 50) batches.push(blocks.slice(index, index + 50));
  return batches;
}
