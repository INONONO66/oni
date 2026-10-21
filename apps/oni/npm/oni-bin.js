#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Oni runs on Bun (bun:sqlite, Bun.serve). This stub keeps
// `npm i -g oni` working from any node: under bun it imports the
// bundle directly; under node it re-executes the bundle with bun.
const entry = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "app", "main.js");

if (typeof Bun === "undefined") {
  const candidates = [
    process.env.BUN_INSTALL ? join(process.env.BUN_INSTALL, "bin", "bun") : undefined,
    join(homedir(), ".bun", "bin", "bun"),
  ].filter((path) => path !== undefined && existsSync(path));
  const bun = candidates[0] ?? "bun";
  const child = spawn(bun, [entry, ...process.argv.slice(2)], { stdio: "inherit" });
  child.on("error", () => {
    console.error("Oni runs on the Bun runtime, and no bun executable was found.");
    console.error("Install it first: curl -fsSL https://bun.sh/install | bash");
    process.exit(1);
  });
  child.on("exit", (code) => process.exit(code ?? 1));
} else {
  await import(entry);
}
