import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Bundled and compiled child processes use a JS sibling; source execution uses TS. */
export function processEntryPath(baseUrl: string): string {
  const compiled = fileURLToPath(new URL("./process-entry.js", baseUrl));
  if (existsSync(compiled)) return compiled;
  return fileURLToPath(new URL("./process-entry.ts", baseUrl));
}
