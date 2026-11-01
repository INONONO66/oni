import { CliError } from "./errors";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { Result } from "effect";
import { ThrownError } from "../thrown";

/**
 * The one durable CLI-owned config surface: `~/.oni/env`. Onboarding
 * writes it, `oni start` reads it back into the process environment,
 * and `loadConfig` stays env-only — no second config format exists.
 */
export interface EnvEntry {
  readonly key: string;
  readonly value: string;
}

const KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/** KEY=VALUE lines (optional `export ` prefix); blank lines and `#` comments skipped; last duplicate wins. */
export function parseEnvFile(text: string): ReadonlyMap<string, string> {
  const entries = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const raw = line.trim();
    if (raw.length === 0 || raw.startsWith("#")) continue;
    const trimmed = raw.startsWith("export ") ? raw.slice("export ".length).trim() : raw;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    if (!KEY_PATTERN.test(key)) continue;
    entries.set(key, unquote(trimmed.slice(separator + 1).trim()));
  }
  return entries;
}

function isQuoted(value: string): boolean {
  return (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  );
}

function unquote(value: string): string {
  return isQuoted(value) ? value.slice(1, -1) : value;
}

export function renderEnvFile(entries: readonly EnvEntry[]): string {
  const lines = entries.map((entry) => {
    if (!KEY_PATTERN.test(entry.key)) {
      throw new CliError(`invalid env key: ${entry.key}`);
    }
    if (/[\n\r]/.test(entry.value)) {
      throw new CliError(`env value for ${entry.key} must not contain line breaks`);
    }
    // Round-trip: a value the parser would unquote gets one protective
    // quote layer, so `"secret"` reads back as `"secret"`, not `secret`.
    // Edge whitespace gets the same layer — the parser trims bare values.
    const value =
      isQuoted(entry.value) || /^\s|\s$/.test(entry.value) ? `"${entry.value}"` : entry.value;
    return `${entry.key}=${value}`;
  });
  return `${lines.join("\n")}\n`;
}

/**
 * Secrets file: written 0600 from the first byte. The content lands in a
 * fresh temp file (never world-readable, never a followed symlink) and is
 * renamed over the destination atomically — a crash cannot leave a partial
 * or loosely-moded env file, and a symlink at the path is replaced, not
 * followed.
 */
export function writeEnvFile(path: string, entries: readonly EnvEntry[]): void {
  mkdirSync(dirname(path), { recursive: true });
  // Unpredictable name + O_EXCL: a planted symlink or file at the temp path
  // fails the write instead of being followed or reused.
  const temp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  const written = Result.try({
    try: () => {
      writeFileSync(temp, renderEnvFile(entries), { mode: 0o600, flag: "wx" });
      chmodSync(temp, 0o600);
      renameSync(temp, path);
    },
    catch: ThrownError.parse,
  });
  if (Result.isFailure(written)) {
    rmSync(temp, { force: true });
    throw written.failure;
  }
}

/**
 * The app's ambient-environment owner alongside `src/config.ts` (#1245):
 * every other module receives environment values from here rather than
 * reading `process.env` itself.
 */
function processEnvironment(): Record<string, string | undefined> {
  return process.env;
}

/**
 * Loads the env file into `env` without overriding keys the process already
 * has — an explicit `ONI_*` export always beats the file. A missing
 * file is not an error: `oni start` with a fully exported environment
 * is a supported shape.
 */
export function applyEnvFile(
  path: string,
  env: Record<string, string | undefined> = processEnvironment(),
): void {
  if (!existsSync(path)) return;
  for (const [key, value] of mergeEnvFile(readFileSync(path, "utf-8"), env)) {
    env[key] = value;
  }
}

export function mergeEnvFile(
  text: string,
  env: Readonly<Record<string, string | undefined>> = processEnvironment(),
): ReadonlyMap<string, string> {
  const merged = new Map(parseEnvFile(text));
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) merged.set(key, value);
  }
  return merged;
}
