import { Outbound } from "@openomni/protocol";
import { RenderLimitExceeded } from "../errors.js";

export type Downgrade =
  | "table-to-code"
  | "table-to-bullets"
  | "table-to-image"
  | "card-to-image"
  | "card-to-caption-keyboard"
  | "carousel-to-sequence"
  | "carousel-to-album"
  | "poll-to-buttons"
  | "status-to-bold"
  | "buttons-to-numbered-list"
  | "divider-to-rule";

export type Downgraded =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "sequence"; readonly ids: readonly string[]; readonly spec?: Outbound.Spec }
  | { readonly kind: "album"; readonly ids: readonly string[] }
  | { readonly kind: "caption-keyboard"; readonly caption: string; readonly image?: string; readonly buttons: readonly string[] }
  | { readonly kind: "image"; readonly element: Outbound.Element; readonly caption: string };

/** Pure translation of named platform compromises; rasterization is performed at the send boundary. */
export function downgrade(name: Downgrade, id: string, spec: Outbound.Spec): Downgraded {
  const element = spec.elements[id];
  if (element === undefined) return { kind: "text", text: "" };
  const digest = Outbound.text({ kind: "message", spec: { root: id, elements: spec.elements } });
  switch (name) {
    case "table-to-code":
      return { kind: "text", text: `\`\`\`\n${digest}\n\`\`\`` };
    case "table-to-bullets":
      return element.type === "Table"
        ? { kind: "text", text: element.props.rows.map((row) =>
          row.map((value, index) => `- ${element.props.columns[index]?.header ?? index + 1}: ${value}`).join("\n")).join("\n\n") }
        : { kind: "text", text: digest };
    case "table-to-image":
    case "card-to-image":
      return { kind: "image", element, caption: digest };
    case "carousel-to-sequence":
      return { kind: "sequence", ids: element.children };
    case "carousel-to-album":
      return { kind: "album", ids: element.children };
    case "poll-to-buttons":
      if (element.type !== "Poll") return { kind: "text", text: digest };
      if (element.props.options.length < 2 || element.props.options.length > 10)
        throw new RenderLimitExceeded({ kind: "options", count: element.props.options.length, limit: 10 });
      return {
        kind: "sequence",
        ids: [`${id}:question`, ...Array.from({ length: Math.ceil(element.props.options.length / 5) }, (_, index) => `${id}:choices:${index}`)],
        spec: {
          root: `${id}:question`,
          elements: {
            [`${id}:question`]: { type: "Markdown", props: { text: element.props.question }, children: [] },
            ...Object.fromEntries(element.props.options.map((option, index) => [
              `${id}:option:${index}`,
              { type: "Button", props: { label: option, id: `${id}:option:${index}` }, children: [] },
            ])),
            ...Object.fromEntries(Array.from({ length: Math.ceil(element.props.options.length / 5) }, (_, index) => [
              `${id}:choices:${index}`,
              { type: "Buttons", props: {}, children: element.props.options.slice(index * 5, index * 5 + 5)
                .map((_, offset) => `${id}:option:${index * 5 + offset}`) },
            ])),
          },
        },
      };
    case "status-to-bold":
      return { kind: "text", text: `**${digest}**` };
    case "buttons-to-numbered-list":
      return {
        kind: "text",
        text: element.children.map((child, index) => {
          const button = spec.elements[child];
          return button?.type === "Button"
            ? `${index + 1}. ${button.props.label}${"url" in button.props ? ` (${button.props.url})` : ""}`
            : `${index + 1}. ${Outbound.text({ kind: "message", spec: { root: child, elements: spec.elements } })}`;
        }).join("\n"),
      };
    case "divider-to-rule":
      return { kind: "text", text: "───" };
    case "card-to-caption-keyboard":
      return element.type === "Card"
        ? { kind: "caption-keyboard", caption: digest, image: element.props.image,
          buttons: element.children.flatMap((child) => {
            const nested = spec.elements[child];
            return nested?.type === "Buttons" ? nested.children : nested?.type === "Button" ? [child] : [];
          }) }
        : { kind: "text", text: digest };
  }
}
