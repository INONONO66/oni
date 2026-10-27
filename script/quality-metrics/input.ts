import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { resolve, relative } from "node:path";
import { decodeJson } from "../quality-json";
import { parseEntry } from "../quality-inventory";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type ObjectValue = { [key: string]: Json };
export class MetricsError {
  readonly name = "MetricsError";
  readonly stack = "";
  constructor(
    readonly code: string,
    readonly path: string,
    readonly message: string,
  ) {}
}
export function fail(code: string, path: string, message: string): never {
  throw new MetricsError(code, path, message);
}
export function sha(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
export function object(value: Json | undefined): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("schema", "", "expected object");
  return value;
}
export function text(value: Json | undefined): string {
  if (typeof value !== "string") fail("schema", "", "expected string");
  return value;
}
export function integer(value: Json | undefined): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    fail("schema", "", "expected nonnegative integer");
  return value;
}
export function array(value: Json | undefined): Json[] {
  if (!Array.isArray(value)) fail("schema", "", "expected array");
  return value;
}
export function hash(value: Json | undefined): string {
  const result = text(value);
  if (!/^[a-f0-9]{64}$/.test(result)) fail("identity", "", "expected SHA-256");
  return result;
}
export function decode(input: string): Json {
  try { return decodeJson(input); }
  catch { return fail("input", "", "malformed JSON"); }
}
export function readJson(path: string): Json {
  return decode(readFileSync(path, "utf8"));
}
export function pathValue(value: Json | undefined): string {
  const path = text(value);
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((p) => p === ".." || p === ".")
  )
    fail("inventory", path, "expected canonical relative path");
  return path;
}
export type Entry = {
  path: string;
  sha256: string;
  bytes: number;
  category: string;
  language: string;
};
export type Source = Entry & { text: string };
function entry(value: Json): Entry {
  try { return parseEntry(value); }
  catch { return fail("inventory", "", "invalid source entry"); }
}
export function content(root: string, path: string): Buffer {
  const absolute = realpathSync(resolve(root, path));
  if (relative(realpathSync(root), absolute).startsWith(".."))
    fail("inventory", path, "source escapes root");
  return readFileSync(absolute);
}
function source(root: string, e: Entry): Source {
  const bytes = content(root, e.path);
  if (sha(bytes) !== e.sha256 || bytes.length !== e.bytes)
    fail("tamper", e.path, "source identity differs");
  const value = bytes.toString("utf8");
  if (sha(value) !== e.sha256) fail("input", e.path, "source must be UTF-8");
  return { ...e, text: value };
}
export function loadInventory(root: string, path: string) {
  return inventoryFrom(root, readFileSync(path), path);
}
export function inventoryFrom(root: string, bytes: Buffer, path: string) {
  const inv = object(decode(bytes.toString("utf8")));
  if (inv.version !== 1) fail("inventory", path, "unsupported inventory version");
  const contractHash = hash(inv.contractHash);
  const files = array(inv.files)
    .map(entry)
    .map((e) => source(root, e));
  const historical = array(inv.historical)
    .map(entry)
    .map((e) => source(root, e));
  const configurations = array(inv.configurations).map((value) => {
    const v = object(value),
      path = pathValue(v.path),
      sha256 = hash(v.sha256);
    if (sha(content(root, path)) !== sha256) fail("tamper", path, "configuration differs");
    return { path, sha256 };
  });
  const all = [...files, ...historical];
  if (!files.length || new Set(all.map((e) => e.path)).size !== all.length)
    fail("inventory", path, "empty or overlapping inventory");
  return { inventoryHash: sha(bytes), contractHash, files, historical, configurations };
}
export type Inventory = ReturnType<typeof loadInventory>;
export function toolVersion(name: string, expected: string) {
  const path = require.resolve(`${name}/package.json`);
  const bytes = readFileSync(path);
  const version = text(object(decode(bytes.toString("utf8"))).version);
  if (version !== expected) fail("toolchain", name, `expected ${expected}, got ${version}`);
  const entry = require.resolve(name);
  return {
    name,
    version,
    packageHash: sha(bytes),
    entryHash: sha(readFileSync(entry)),
    invocation:
      name === "jscpd"
        ? "distribution identity; @jscpd/core and @jscpd/tokenizer APIs invoked"
        : "runtime API",
  };
}
