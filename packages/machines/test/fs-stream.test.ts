import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Machine } from "@oni/protocol";
import { createFsDriver } from "./helpers/native";

test("transfer cursors replay a lost read frame without advancing the digest twice", async () => {
  const root = mkdtempSync(join(tmpdir(), "om-fs-stream-"));
  const data = Buffer.alloc(262_145, 71);
  writeFileSync(join(root, "source"), data);
  const driver = createFsDriver(new Map([["work", root]]));
  try {
    expect(await driver.stream({ op: "begin", mode: "read", transferId: "read-1", export: "work", path: "source" }))
      .toEqual({ status: "begun", seq: 0, size: data.length });
    const first = await driver.stream({ op: "read", transferId: "read-1", seq: 0 });
    expect(first).toMatchObject({ status: "chunk", seq: 0, last: false });
    expect(await driver.stream({ op: "begin", mode: "read", transferId: "read-1", export: "work", path: "source" }))
      .toMatchObject({ status: "refused", reason: "invalid_sequence" });
    expect(await driver.stream({ op: "read", transferId: "read-1", seq: 0 })).toEqual(first);
    expect(await driver.stream({ op: "read", transferId: "read-1", seq: 2 })).toMatchObject({
      status: "refused", reason: "invalid_sequence",
    });
    const final = await driver.stream({ op: "read", transferId: "read-1", seq: 1 });
    expect(final).toMatchObject({
      status: "chunk", seq: 1, last: true, digest: createHash("sha256").update(data).digest("hex"),
    });
    expect(await driver.stream({ op: "finish", transferId: "read-1" })).toEqual({ status: "finished" });
    expect(await driver.stream({ op: "read", transferId: "read-1", seq: 2 })).toMatchObject({
      status: "refused", reason: "transfer_not_found",
    });
  } finally {
    driver.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a write digest mismatch refuses before accepting its final chunk", async () => {
  const root = mkdtempSync(join(tmpdir(), "om-fs-stream-"));
  writeFileSync(join(root, "target"), "original");
  const driver = createFsDriver(new Map([["work", root]]));
  try {
    expect(await driver({ op: "write", export: "work", path: "target", data: Buffer.alloc(Machine.FS_WRITE_MAX_BYTES + 1).toString("base64") }))
      .toMatchObject({ status: "refused", reason: "too_large" });
    expect(readFileSync(join(root, "target"), "utf8")).toBe("original");
    expect(await driver.stream({ op: "begin", mode: "write", transferId: "write-1", export: "work", path: "target" }))
      .toMatchObject({ status: "begun", seq: 0 });
    expect(await driver.stream({ op: "finish", transferId: "write-1" }))
      .toMatchObject({ status: "refused", reason: "invalid_sequence" });
    expect(await driver.stream({ op: "write", transferId: "write-1", seq: 2, data: "YQ==", last: false }))
      .toMatchObject({ status: "refused", reason: "invalid_sequence" });
    expect(await driver.stream({ op: "write", transferId: "write-1", seq: 0, data: "YQ==", last: false }))
      .toMatchObject({ status: "written", bytesWritten: 1 });
    const bad = { op: "write", transferId: "write-1", seq: 1, data: "Yg==", last: true, digest: "0".repeat(64) } as const;
    expect(await driver.stream(bad)).toMatchObject({ status: "refused", reason: "digest_mismatch" });
    expect(readFileSync(join(root, "target"), "utf8")).toBe("original");
    expect(await driver.stream({ op: "abort", transferId: "write-1" })).toEqual({ status: "finished" });
    expect(readdirSync(root)).toEqual(["target"]);
    expect(await driver.stream({ op: "begin", mode: "write", transferId: "write-1", export: "work", path: "target" }))
      .toMatchObject({ status: "begun", seq: 0 });
    expect(await driver.stream({ op: "write", transferId: "write-1", seq: 0, data: "YQ==", last: true, digest: createHash("sha256").update("a").digest("hex") }))
      .toEqual({ status: "written", seq: 0, bytesWritten: 1, last: true });
    expect(readFileSync(join(root, "target"), "utf8")).toBe("original");
    expect(await driver.stream({ op: "finish", transferId: "write-1" })).toEqual({ status: "finished" });
    expect(readFileSync(join(root, "target"), "utf8")).toBe("a");
    expect(readdirSync(root)).toEqual(["target"]);
  } finally {
    driver.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a bounded transfer pool releases descriptors on abort and detach cleanup", async () => {
  const root = mkdtempSync(join(tmpdir(), "om-fs-stream-"));
  writeFileSync(join(root, "source"), "unchanged");
  const driver = createFsDriver(new Map([["work", root]]));
  const begin = (transferId: string) => driver.stream({ op: "begin", mode: "read", transferId, export: "work", path: "source" });
  try {
    for (let index = 0; index < 32; index += 1) expect(await begin(`slot-${index}`)).toMatchObject({ status: "begun" });
    expect(await begin("overflow")).toMatchObject({ status: "refused", reason: "too_large" });
    expect(await driver.stream({ op: "abort", transferId: "slot-0" })).toEqual({ status: "finished" });
    expect(await begin("replacement")).toMatchObject({ status: "begun" });
    driver.abortAll();
    expect(await driver.stream({ op: "read", transferId: "replacement", seq: 0 }))
      .toMatchObject({ status: "refused", reason: "transfer_not_found" });
    expect(await begin("after-cleanup")).toMatchObject({ status: "begun" });
  } finally {
    driver.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("cleanup releases every transfer even if a staged temp was removed externally", async () => {
  const root = mkdtempSync(join(tmpdir(), "om-fs-stream-"));
  writeFileSync(join(root, "source"), "original");
  const driver = createFsDriver(new Map([["work", root]]));
  try {
    expect(await driver.stream({ op: "begin", mode: "write", transferId: "tampered", export: "work", path: "source" }))
      .toMatchObject({ status: "begun" });
    expect(await driver.stream({ op: "begin", mode: "read", transferId: "survivor", export: "work", path: "source" }))
      .toMatchObject({ status: "begun" });
    const staged = readdirSync(root).find((name) => name.startsWith(".oni-transfer-"));
    if (staged === undefined) throw new Error("missing staged transfer");
    rmSync(join(root, staged));
    expect(() => driver.abortAll()).toThrow("failed to remove staged filesystem transfer");
    expect(await driver.stream({ op: "read", transferId: "survivor", seq: 0 }))
      .toMatchObject({ status: "refused", reason: "transfer_not_found" });
    expect(await driver.stream({ op: "begin", mode: "read", transferId: "fresh", export: "work", path: "source" }))
      .toMatchObject({ status: "begun" });
    expect(readFileSync(join(root, "source"), "utf8")).toBe("original");
  } finally {
    driver.close();
    rmSync(root, { recursive: true, force: true });
  }
});
