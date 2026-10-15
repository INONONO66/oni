import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Reads a shipped role file. Imported with `{ type: "macro" }`, so the text is
 * inlined when the source is transpiled or bundled and the packaged CLI needs
 * no markdown files beside it.
 */
export function roleText(name: "resident" | "child"): string {
  return readFileSync(join(import.meta.dir, "..", "..", "..", "prompts", "roles", `${name}.md`), "utf-8");
}
