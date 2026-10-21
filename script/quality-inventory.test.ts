import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildInventory,
  jsonArray,
  jsonObject,
  contractSchema,
  decodeJson,
  inventorySchema,
  verifyInventory,
  type Inventory,
} from "./quality-inventory";

const contract = contractSchema.parse({
  version: 1,
  typescript: "5.9.2",
  roots: ["."],
  projects: ["tsconfig.json"],
  topology: false,
});

test("JSON boundary retains native syntax errors and validates finite structural payloads", () => {
  expect(jsonArray([{ one: 1 }, { two: 2 }], jsonObject)).toEqual([{ one: 1 }, { two: 2 }]);
  expect(decodeJson('{"nested":[null,true,false,-1.5,"value"]}')).toEqual({
    nested: [null, true, false, -1.5, "value"],
  });
  for (const input of ['{"a":', '{"a":"unterminated}', '{"a":1 "b":2}', "undefined", "{a:1}", ""])
    expect(() => decodeJson(input)).toThrow();
  for (const value of [
    { ...contract, version: 2 },
    { ...contract, roots: [] },
    { ...contract, roots: ["../outside"] },
    { ...contract, projects: [] },
    { ...contract, extra: true },
    { ...contract, topology: true },
  ])
    expect(() => contractSchema.parse(value)).toThrow();
  const entry: Inventory["files"][number] = {
    path: "a.ts",
    sha256: "a".repeat(64),
    bytes: 0,
    category: "production",
    language: "typescript",
  };
  const inventory: Inventory = {
    version: 1,
    contractHash: "hash",
    files: [entry],
    historical: [],
    embedded: [],
    configurations: [],
  };
  expect(inventorySchema.parse(inventory)).toEqual(inventory);
  for (const invalid of [
    { ...entry, sha256: "bad" },
    { ...entry, bytes: -1 },
    { ...entry, bytes: 0.5 },
    { ...entry, bytes: Infinity },
    { ...entry, language: "other" },
    { ...entry, category: "other" },
    { ...entry, path: "/absolute" },
    { ...entry, extra: true },
  ])
    expect(() => inventorySchema.parse({ ...inventory, files: [invalid] })).toThrow();
  expect(() => inventorySchema.parse({ ...inventory, extra: true })).toThrow();
});

test("inventory includes declarations, TSX, tests, checked-in fixtures, benchmarks, gates, JS and SQL", () => {
  const root = mkdtempSync(join(tmpdir(), "oni-inventory-"));
  try {
    const sources = [
      "a.d.ts",
      "app.tsx",
      "test/case.test.ts",
      "script/fixtures/case.ts",
      "bench/case.mts",
      "script/gate.cts",
      "script/test_driver.py",
      "script/driver_test.py",
      "npm/launcher.js",
      "migration.sql",
      "apps/example/src/runtime.config.ts",
    ];
    for (const path of [...sources, "dist/ignored.ts", "node_modules/ignored.ts"]) {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), "export const value = 1;\n");
    }
    const inventory = buildInventory(root, contract);
    expect(inventory.files.map((file) => file.path)).toEqual(sources.sort());
    expect(inventory.files.find((file) => file.path === "script/fixtures/case.ts")?.category).toBe(
      "fixture",
    );
    expect(inventory.files.find((file) => file.path === "script/gate.cts")?.category).toBe(
      "tooling",
    );
    for (const path of ["test/case.test.ts", "script/test_driver.py", "script/driver_test.py"]) {
      expect(inventory.files.find((file) => file.path === path)?.category).toBe("test");
    }
    expect(inventory.files.find((file) => file.path === "bench/case.mts")?.category).toBe(
      "benchmark",
    );
    expect(inventory.files.find((file) => file.path === "migration.sql")?.language).toBe("sql");
    expect(
      inventory.files.find((file) => file.path === "apps/example/src/runtime.config.ts")?.category,
    ).toBe("production");
    expect(inventory.files.every((file) => file.sha256.length === 64)).toBe(true);
    expect(buildInventory(root, contract)).toEqual(inventory);
    writeFileSync(join(root, "new.ts"), "export const added = 1;\n");
    expect(() => verifyInventory(buildInventory(root, contract), inventory)).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inventory fails closed for missing roots and overlapping membership", () => {
  const root = mkdtempSync(join(tmpdir(), "oni-inventory-"));
  try {
    writeFileSync(join(root, "a.ts"), "export const value = 1;");
    expect(() => buildInventory(root, { ...contract, roots: ["absent"] })).toThrow();
    expect(() => buildInventory(root, { ...contract, roots: [".", "."] })).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
