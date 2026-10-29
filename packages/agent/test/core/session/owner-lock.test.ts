import { afterAll, expect, test } from "bun:test";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireOwnerLock, inheritOwnerLock, OwnerLockHeld, ownersSince } from "../../../src/core/session/owner-lock";

const root = mkdtempSync(join(tmpdir(), "owner-lock-"));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const catalogOf = (name: string) => join(root, name, "catalog.sqlite");
const module = join(import.meta.dir, "../../../src/core/session/owner-lock.ts");

function refusalOf(body: () => void): OwnerLockHeld | undefined {
  try {
    body();
  } catch (cause) {
    if (cause instanceof OwnerLockHeld) return cause;
    throw cause;
  }
  return undefined;
}

function holder(script: string, fd?: number) {
  return Bun.spawn([process.execPath, "-e", `import * as L from ${JSON.stringify(module)};\n${script}`], {
    stdio: fd === undefined ? ["pipe", "pipe", "inherit"] : ["pipe", "pipe", "inherit", fd],
  });
}

async function firstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  let text = "";
  while (!text.includes("\n")) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += new TextDecoder().decode(chunk.value);
  }
  reader.releaseLock();
  return text.trim();
}

test("a live holder refuses a second owner with the holder named; release is idempotent and frees the catalog", () => {
  const catalog = catalogOf("live");
  const first = acquireOwnerLock(catalog, "oni:first");
  expect(JSON.parse(readFileSync(`${catalog}.owner`, "utf8"))).toEqual({ owner: "oni:first", pid: process.pid });
  expect(refusalOf(() => acquireOwnerLock(catalog, "oni:second"))).toMatchObject({ path: `${catalog}.owner`, holder: "oni:first" });
  first.release();
  const second = acquireOwnerLock(catalog, "oni:second");
  first.release();
  expect(refusalOf(() => acquireOwnerLock(catalog, "oni:third"))?.holder).toBe("oni:second");
  second.release();
});

test("a holder that dies before writing its record releases the lock with the process", async () => {
  const catalog = catalogOf("crash");
  acquireOwnerLock(catalog, "oni:seed").release();
  const child = holder(`const fd = require("node:fs").openSync(${JSON.stringify(`${catalog}.owner`)}, "w");
require("bun:ffi").dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", { flock: { args: ["i32", "i32"], returns: "i32" } }).symbols.flock(fd, 6);
console.log("HELD"); await Bun.stdin.text();`);
  expect(await firstLine(child.stdout)).toBe("HELD");
  expect(refusalOf(() => acquireOwnerLock(catalog, "oni:next"))?.holder).toBe("unrecorded");
  child.stdin.end();
  expect(await child.exited).toBe(0);
  const lock = acquireOwnerLock(catalog, "oni:next");
  expect(JSON.parse(readFileSync(`${catalog}.owner`, "utf8")).owner).toBe("oni:next");
  lock.release();
});

test("a child that inherited the descriptor shares the lock past the parent's release until it exits", async () => {
  const catalog = catalogOf("inherit");
  const parent = acquireOwnerLock(catalog, "oni:parent");
  const child = holder(`L.inheritOwnerLock(${JSON.stringify(catalog)}, 3); console.log("ADOPTED"); await Bun.stdin.text();`, parent.fd);
  expect(await firstLine(child.stdout)).toBe("ADOPTED");
  parent.release();
  expect(refusalOf(() => acquireOwnerLock(catalog, "oni:deploy"))?.holder).toBe("oni:parent");
  child.stdin.end();
  expect(await child.exited).toBe(0);
  acquireOwnerLock(catalog, "oni:deploy").release();
});

test("a descriptor that does not hold the lock is refused for inheritance", () => {
  const catalog = catalogOf("forged");
  const lock = acquireOwnerLock(catalog, "oni:holder");
  const independent = openSync(`${catalog}.owner`, "r");
  const other = openSync(catalog.replace("catalog.sqlite", ""), "r");
  expect(refusalOf(() => inheritOwnerLock(catalog, independent))?.holder).toBe("oni:holder");
  expect(refusalOf(() => inheritOwnerLock(catalog, other))).toBeInstanceOf(OwnerLockHeld);
  expect(refusalOf(() => inheritOwnerLock(catalog, 987_654))).toBeInstanceOf(OwnerLockHeld);
  closeSync(independent);
  closeSync(other);
  lock.release();
});

test("ownersSince names exactly the owners between two log offsets", () => {
  const catalog = catalogOf("log");
  expect(ownersSince(catalog, 0)).toEqual([]);
  const before = acquireOwnerLock(catalog, "oni:before");
  expect(before.logStart).toBe(0);
  before.release();
  expect(ownersSince(catalog, before.logEnd)).toEqual([]);
  acquireOwnerLock(catalog, "oni:candidate").release();
  acquireOwnerLock(catalog, "oni:stray").release();
  const restore = acquireOwnerLock(catalog, "oni:restore");
  expect(ownersSince(catalog, before.logEnd, restore.logStart)).toEqual(["oni:candidate", "oni:stray"]);
  expect(ownersSince(catalog, before.logEnd)).toEqual(["oni:candidate", "oni:stray", "oni:restore"]);
  restore.release();
});
