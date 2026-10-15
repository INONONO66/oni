import type { PlainValue } from "@openomni/protocol";
import { RenderLimitExceeded } from "../../errors.js";
import type { NativeStep } from "../../support/translate.js";

export type SlackBlock = Record<string, PlainValue>;

const STATUS = {
  ok: ":white_check_mark:", warn: ":warning:", fail: ":x:", progress: ":hourglass_flowing_sand:",
} as const;

export function renderSlack(step: NativeStep): readonly SlackBlock[] {
  const { element, spec } = step;
  switch (element.type) {
    case "Stack":
      return [{ type: "section", text: { type: "mrkdwn", text: step.digest } }];
    case "Markdown":
      return [{ type: "markdown", text: element.props.text }];
    case "Code":
      return [{ type: "section", text: { type: "mrkdwn", text: `\`\`\`${element.props.text}\`\`\`` } }];
    case "Table": {
      const rows = [element.props.columns.map((column) => column.header), ...element.props.rows];
      if (rows.length > 100 || rows.some((row) => row.length > 20 || row.some((cell) => cell.length > 2000)))
        return [{ type: "section", text: { type: "mrkdwn", text: `\`\`\`${step.digest}\`\`\`` } }];
      return [{ type: "table", rows: rows.map((row) => row.map((text) => ({ type: "raw_text", text }))) }];
    }
    case "Card":
      return [
        { type: "header", text: { type: "plain_text", text: element.props.title } },
        { type: "section", text: { type: "mrkdwn", text: element.props.body ?? element.props.title },
          ...(element.props.image?.startsWith("https://") ? { accessory: { type: "image", image_url: element.props.image, alt_text: element.props.title } } : {}) },
      ];
    case "Buttons": {
      if (element.children.length > 5)
        throw new RenderLimitExceeded({ kind: "buttons", count: element.children.length, limit: 5 });
      const buttons = element.children.flatMap((child) => {
        const button = spec.elements[child];
        if (button?.type !== "Button") return [];
        const props = button.props;
        return [{
          type: "button", text: { type: "plain_text", text: props.label },
          action_id: "url" in props ? child : props.id,
          ...("url" in props ? { url: props.url } : {}),
          ...(props.style === "primary" || props.style === "danger" ? { style: props.style } : {}),
        }];
      });
      return [{ type: "actions", elements: buttons }];
    }
    case "Button": {
      const props = element.props;
      return [{ type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: props.label },
        action_id: "url" in props ? step.id : props.id,
        ...("url" in props ? { url: props.url } : {}) }] }];
    }
    case "Status":
      return [{ type: "section", text: { type: "mrkdwn", text: `*${STATUS[element.props.kind]} ${element.props.title}*${element.props.body === undefined ? "" : `\n${element.props.body}`}` } }];
    case "Divider":
      return [{ type: "divider" }];
    case "Context":
      return [{ type: "context", elements: [{ type: "mrkdwn", text: element.props.text }] }];
    case "Poll":
    case "Carousel":
    case "Image":
    case "File":
      return [{ type: "section", text: { type: "mrkdwn", text: step.digest } }];
  }
}

export function splitSlackBlocks(blocks: readonly SlackBlock[]): readonly (readonly SlackBlock[])[] {
  const batches: SlackBlock[][] = [];
  for (let index = 0; index < blocks.length; index += 50) batches.push(blocks.slice(index, index + 50));
  if (batches.some((batch) => batch.length > 50))
    throw new RenderLimitExceeded({ kind: "blocks", count: blocks.length, limit: 50 });
  return batches;
}
