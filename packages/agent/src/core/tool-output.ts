/**
 * An over-budget tool result is stored ONCE under its `canonicalDigest` and
 * everything downstream carries a bounded preview plus the id; nothing is
 * destroyed. The preview takes at most half the budget less the marker line
 * because the stored ref duplicates it, so the projected row stays under budget.
 */
import { Buffer } from "node:buffer";
import { canonicalDigest, canonicalJson, type PlainValue, type ToolOutputRef } from "@openomni/protocol";

/** Applies when no `session.configure{settings.toolOutputBudgetBytes}` row pins one. */
export const DEFAULT_TOOL_OUTPUT_BUDGET_BYTES = 32_768;

export interface ToolOutputPorts {
  readonly budgetBytes: number;
  readonly put: (write: {
    readonly outputId: string;
    readonly bytes: Uint8Array;
    readonly mediaType?: string;
  }) => void;
}

/** Code-point-safe: the UTF-8 encoding fits `maxBytes`. */
function utf8Prefix(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let kept = Math.max(0, maxBytes);
  for (;;) {
    // Never split a surrogate pair.
    if ((text.codePointAt(kept - 1) ?? 0) > 0xffff) kept -= 1;
    const prefix = text.slice(0, kept);
    if (Buffer.byteLength(prefix, "utf8") <= maxBytes) return prefix;
    kept -= 1;
  }
}

function marker(outputId: string, bytes: number): string {
  return `\n[output ${outputId}: ${bytes} bytes; read with tool_output("${outputId}")]`;
}

function previewOf(text: string, budgetBytes: number, markerText: string): string {
  const reserve = Buffer.byteLength(markerText, "utf8");
  return utf8Prefix(text, Math.max(0, Math.floor((budgetBytes - reserve) / 2)));
}

/** Over budget the full text is stored and the model reads `preview + marker`. */
export function projectToolOutput(
  rendered: string,
  ports: ToolOutputPorts,
): { readonly content: string; readonly outputRef?: ToolOutputRef } {
  const bytes = Buffer.byteLength(rendered, "utf8");
  if (bytes <= ports.budgetBytes) return { content: rendered };
  const outputId = canonicalDigest(rendered);
  ports.put({ outputId, bytes: new TextEncoder().encode(rendered), mediaType: "text/plain" });
  const markerText = marker(outputId, bytes);
  const preview = previewOf(rendered, ports.budgetBytes, markerText);
  return {
    content: `${preview}${markerText}`,
    outputRef: { outputId, bytes, mediaType: "text/plain", preview },
  };
}

function plainObject(value: PlainValue): Record<string, PlainValue> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

/**
 * Over budget the row carries `{outputRef}` with a top-level `revert` key preserved verbatim: crash
 * recovery reads it off the boundary result.
 */
export function projectResultValue(value: PlainValue, ports: ToolOutputPorts): PlainValue {
  const json = canonicalJson(value);
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes <= ports.budgetBytes) return value;
  const outputId = canonicalDigest(value);
  ports.put({ outputId, bytes: new TextEncoder().encode(json), mediaType: "application/json" });
  const preview = previewOf(json, ports.budgetBytes, marker(outputId, bytes));
  const revert = plainObject(value)?.revert;
  return {
    outputRef: { outputId, bytes, mediaType: "application/json", preview },
    ...(revert === undefined ? {} : { revert }),
  };
}
