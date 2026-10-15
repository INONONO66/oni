import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  const driver = createFsDriver(new Map([["work", root]]));
  try {
    expect(await driver.stream({ op: "begin", mode: "write", transferId: "write-1", export: "work", path: "target" }))
      .toMatchObject({ status: "begun", seq: 0 });
    expect(await driver.stream({ op: "finish", transferId: "write-1" }))
      .toMatchObject({ status: "refused", reason: "invalid_sequence" });
    const chunk = { op: "write", transferId: "write-1", seq: 0, data: "YQ==", last: true, digest: "0".repeat(64) } as const;
    expect(await driver.stream(chunk)).toMatchObject({ status: "refused", reason: "digest_mismatch" });
    expect(await driver.stream({ ...chunk, digest: createHash("sha256").update("a").digest("hex") }))
      .toEqual({ status: "written", seq: 0, bytesWritten: 1, last: true });
    expect(await driver.stream({ op: "finish", transferId: "write-1" })).toEqual({ status: "finished" });
  } finally {
    driver.close();
    rmSync(root, { recursive: true, force: true });
  }
});
