import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeSqliteFiles } from "./sqlite";

test("cleanup reports a non-file database path instead of silently leaving it behind", () => {
  const directory = mkdtempSync(join(tmpdir(), "sqlite-cleanup-"));
  const path = join(directory, "fixture.db");
  mkdirSync(path);
  try {
    expect(() => removeSqliteFiles(path)).toThrow(expect.objectContaining({ code: "ERR_FS_EISDIR" }));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("cleanup removes database sidecars and tolerates already absent files", () => {
  const directory = mkdtempSync(join(tmpdir(), "sqlite-cleanup-"));
  const path = join(directory, "fixture.db");
  for (const suffix of ["", "-wal", "-shm"]) writeFileSync(`${path}${suffix}`, "fixture");
  try {
    removeSqliteFiles(path);
    for (const suffix of ["", "-wal", "-shm"]) expect(existsSync(`${path}${suffix}`)).toBe(false);
    expect(() => removeSqliteFiles(path)).not.toThrow();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
