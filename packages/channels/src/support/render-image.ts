import { readFile } from "node:fs/promises";
import { renderToPng } from "@json-render/image/render";
import type { Outbound } from "@openomni/protocol";
import type { MediaBytes } from "../types.js";

const fontUrl = new URL("../../assets/microfont.woff.base64", import.meta.url);

/** Package-local CC0 font and PNG renderer; no font is fetched during a send. */
export async function renderElementImage(element: Outbound.Element, caption: string): Promise<MediaBytes> {
  const font = Buffer.from((await readFile(fontUrl, "utf8")).trim(), "base64");
  const rows = element.type === "Table"
    ? [element.props.columns.map((column) => column.header).join("  |  "),
      ...element.props.rows.map((row) => row.join("  |  "))]
    : caption.split("\n");
  const spec = {
    root: "frame",
    elements: {
      frame: { type: "Frame", props: {
        width: 960, height: Math.max(160, Math.min(4000, 80 + rows.length * 40)),
        backgroundColor: "#ffffff", display: "flex", flexDirection: "column", padding: 32,
      }, children: rows.map((_, index) => `line-${index}`) },
      ...Object.fromEntries(rows.map((text, index) => [`line-${index}`, {
        type: "Text", props: { text, fontSize: 22, color: "#161616" }, children: [],
      }])),
    },
  };
  const bytes = await renderToPng(spec, {
    fonts: [{ name: "Microfont", data: font, weight: 400, style: "normal" }],
  });
  return { bytes, name: `${element.type.toLowerCase()}.png`, mime: "image/png" };
}
