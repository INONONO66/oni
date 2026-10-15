import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Machine } from "@openomni/protocol";
import { z } from "zod";
import { createMachineEnrollmentStore } from "../../../src/index.js";

const enrollment = Machine.Enrollment.parse({
  machineId: "worker", name: "Worker", tags: ["pool"], allowedCapabilities: ["kernel.py"],
  allowedExports: ["workspace"], publicKey: "a".repeat(64), enrolledAt: 100,
});

test("machine enrollment roundtrips independently and updates one revision per write", () => {
  const db = new Database(":memory:");
  const store = createMachineEnrollmentStore(db);
  try {
    expect(store.get("missing")).toBeUndefined();
    expect(store.remove("missing", 100)).toBe(false);
    expect(store.put(enrollment)).toEqual(enrollment);
    store.put({ ...enrollment, name: "Updated", enrolledAt: 200 });
    expect(store.get("worker")).toEqual({
      machineId: "worker", enrollment: { ...enrollment, name: "Updated", enrolledAt: 200 },
      revision: 1, removedAt: null, updatedAt: 200,
    });
    store.put({ ...enrollment, machineId: "first" });
    expect(store.list().map((row) => row.machineId)).toEqual(["first", "worker"]);
    expect(z.object({ name: z.string() }).array().parse(
      db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all(),
    )).toEqual([{ name: "machine_enrollment" }]);
  } finally { db.close(); }
});

test("seed preserves live rows and durable tombstones across reopen until explicit re-enrollment", () => {
  const directory = mkdtempSync(join(tmpdir(), "machine-enrollment-"));
  const path = join(directory, "store.sqlite");
  const db = new Database(path);
  const store = createMachineEnrollmentStore(db);
  try {
    store.seed([enrollment]);
    store.seed([{ ...enrollment, publicKey: "b".repeat(64) }]);
    expect(store.get("worker")?.enrollment).toEqual(enrollment);
    expect(store.remove("worker", 150)).toBe(true);
    expect(store.remove("worker", 160)).toBe(false);
  } finally { db.close(); }
  const reopened = new Database(path);
  try {
    const recovered = createMachineEnrollmentStore(reopened);
    recovered.seed([enrollment]);
    expect(recovered.list()).toEqual([]);
    expect(recovered.get("worker")).toMatchObject({ revision: 1, removedAt: 150, updatedAt: 150 });
    recovered.put({ ...enrollment, publicKey: "c".repeat(64), enrolledAt: 200 });
    expect(recovered.get("worker")).toMatchObject({ revision: 2, removedAt: null, updatedAt: 200 });
    expect(recovered.list()).toEqual([{ ...enrollment, publicKey: "c".repeat(64), enrolledAt: 200 }]);
  } finally { reopened.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("invalid enrollments fail closed before writes and seed failures roll back the whole batch", () => {
  const db = new Database(":memory:");
  const store = createMachineEnrollmentStore(db);
  try {
    const invalid = { ...enrollment, allowedCapabilities: [] };
    expect(() => store.put(invalid)).toThrow(z.ZodError);
    expect(() => store.seed([enrollment, invalid])).toThrow(z.ZodError);
    expect(store.list()).toEqual([]);
    store.put(enrollment);
    expect(() => store.remove("worker", -1)).toThrow(z.ZodError);
    expect(store.get("worker")?.removedAt).toBeNull();
  } finally { db.close(); }
});

test.each(["{}", JSON.stringify({ ...enrollment, machineId: "different" })])(
  "corrupt enrollment JSON fails both read surfaces instead of granting authority: %s", (data) => {
    const db = new Database(":memory:");
    const store = createMachineEnrollmentStore(db);
    try {
      store.put(enrollment);
      db.query("UPDATE machine_enrollment SET enrollment = ?").run(data);
      expect(() => store.get("worker")).toThrow(z.ZodError);
      expect(() => store.list()).toThrow(z.ZodError);
    } finally { db.close(); }
  },
);

test("read-only clients can read existing enrollment rows without schema writes", () => {
  const db = new Database(":memory:");
  createMachineEnrollmentStore(db).put(enrollment);
  db.run("PRAGMA query_only = ON");
  try {
    const reader = createMachineEnrollmentStore(db);
    expect(reader.list()).toEqual([enrollment]);
    expect(() => reader.put(enrollment)).toThrow("readonly");
  } finally { db.close(); }
});
