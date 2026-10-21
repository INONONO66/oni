import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Machine } from "../packages/protocol/src/index.js";
import { PlainValueSchema } from "../packages/protocol/src/json.js";
import { machineSchemas, main, renderMachineSchemas } from "./generate-machine-schema";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(): { readonly root: string; readonly dir: URL } {
  const root = mkdtempSync(join(tmpdir(), "machine-schema-"));
  roots.push(root);
  return { root, dir: new URL(`${pathToFileURL(root).href}/schema/`) };
}

async function capture(run: () => Promise<void>): Promise<{ logs: string[]; errors: string[]; exitCode: number }> {
  const logs: string[] = [];
  const errors: string[] = [];
  // Earlier suites in the same shard may leave an exit code behind, and once
  // set it cannot go back to undefined; every run starts from success (0).
  const previousExitCode = process.exitCode ?? 0;
  process.exitCode = 0;
  const log = spyOn(console, "log").mockImplementation((message: string) => {
    logs.push(message);
  });
  const error = spyOn(console, "error").mockImplementation((message: string) => {
    errors.push(message);
  });
  try {
    await run();
    return { logs, errors, exitCode: process.exitCode ?? 0 };
  } finally {
    log.mockRestore();
    error.mockRestore();
    process.exitCode = previousExitCode;
  }
}

test("renders one draft-7 file per machine schema plus a sorted index", () => {
  const files = renderMachineSchemas();
  const names = machineSchemas().map(({ name }) => name);
  expect(names).toEqual([...names].sort());
  expect(names).toContain("WireMethod");
  expect(names).toContain("EventAttached");
  expect(files.size).toBe(names.length + 1);
  const index = PlainValueSchema.parse(JSON.parse(files.get("index.json") ?? "null"));
  expect(index).toEqual({
    contractVersion: Machine.contractVersion,
    schemas: names.map((name) => ({ name, file: `${name}.json` })),
  });
  const offer = PlainValueSchema.parse(JSON.parse(files.get("Offer.json") ?? "null"));
  expect(offer).toMatchObject({ $schema: "http://json-schema.org/draft-07/schema#", type: "object" });
});

test("writes the export into a missing directory and prunes files the contract no longer has", async () => {
  const { root, dir } = scratch();
  const expected = renderMachineSchemas();
  const first = await capture(() => main([], dir));
  expect(first.logs).toEqual([`Wrote ${expected.size} machine JSON Schema files`]);
  expect(first.exitCode).toBe(0);
  expect(readdirSync(join(root, "schema")).sort()).toEqual([...expected.keys()].sort());
  expect(readFileSync(join(root, "schema", "index.json"), "utf8")).toBe(expected.get("index.json") ?? "");

  writeFileSync(join(root, "schema", "Stale.json"), "{}\n");
  writeFileSync(join(root, "schema", "notes.txt"), "kept: not a schema file\n");
  await capture(() => main([], dir));
  expect(readdirSync(join(root, "schema")).sort()).toEqual([...expected.keys(), "notes.txt"].sort());
});

test("--check reports a current export and leaves the exit code at success", async () => {
  const { dir } = scratch();
  await capture(() => main([], dir));
  const check = await capture(() => main(["--check"], dir));
  expect(check).toEqual({ logs: ["Machine JSON Schema export is current"], errors: [], exitCode: 0 });
});

test("--check lists stale, extra and missing files in sorted order and fails", async () => {
  const { root, dir } = scratch();
  await capture(() => main([], dir));
  writeFileSync(join(root, "schema", "Offer.json"), "{}\n");
  writeFileSync(join(root, "schema", "Extra.json"), "{}\n");
  rmSync(join(root, "schema", "AbsolutePath.json"));
  const check = await capture(() => main(["--check"], dir));
  expect(check.exitCode).toBe(1);
  expect(check.logs).toEqual([]);
  expect(check.errors).toEqual([
    "Machine JSON Schema export is stale (AbsolutePath.json, Extra.json, Offer.json). Run: bun run script/generate-machine-schema.ts",
  ]);
});

test("--check against a missing directory reports every file stale", async () => {
  const { dir } = scratch();
  const check = await capture(() => main(["--check"], dir));
  expect(check.exitCode).toBe(1);
  expect(check.errors).toHaveLength(1);
  expect(check.errors[0]).toContain(`(${[...renderMachineSchemas().keys()].sort().join(", ")})`);
});

test("a directory read failure other than ENOENT propagates", async () => {
  const { root } = scratch();
  mkdirSync(join(root, "schema"));
  writeFileSync(join(root, "schema", "file"), "");
  const notADirectory = new URL(`${pathToFileURL(root).href}/schema/file/`);
  await expect(capture(() => main([], notADirectory))).rejects.toMatchObject({ code: "ENOTDIR" });
});
