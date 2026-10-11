import { expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mutationMain, normalizeMutation } from "./quality-native-mutation";
import { decodeJson, digest, jsonObject } from "./quality-inventory";
import { mutationFixture } from "./quality-mutation-fixture";

const { fixture, dependencies, decision } = mutationFixture("native-wrapper");

function prepareNative(root: string, demoProject = false): string[] {
  if (demoProject) {
    // Native campaigns own the compiler-project setup alongside their copied tools.
    cpSync(join(root, "src/tsconfig.json"), join(root, "packages/demo/tsconfig.json"));
    const path = join(root, "contract.json");
    writeFileSync(path, JSON.stringify({
      ...jsonObject(decodeJson(readFileSync(path, "utf8"))),
      roots: ["src", "packages"],
      projects: ["src/tsconfig.json", "packages/demo/tsconfig.json"],
    }));
  }
  cpSync(import.meta.dir, join(root, "script"), { recursive: true });
  cpSync(dependencies, join(root, "node_modules"), { recursive: true, dereference: true });
  return ["--root", root, "--contract", "contract.json", "--decision", decision];
}
function completeReceipt<R extends object, C extends object, S extends object>(
  inventoryHash: string, result: R, counts: C, census: S[],
) {
  return {
    version: 1, complete: true, full: true,
    originalHashesVerified: true, cleanupVerified: true,
    inventorySha256: inventoryHash, errors: [],
    results: [result], counts, census,
  };
}

test("native pilot executes the real campaign without creating a full ratchet measurement", async () => {
  const input = await fixture("export const run = () => true;", "", {
    "src/a.test.ts": "",
    "src/z.test.ts": 'import {test,expect} from "bun:test";import {run} from "./a";test("behavior",()=>expect(run()).toBe(true));',
  });
  expect(await mutationMain([
    ...prepareNative(input.root),
    "--pilot", "--limit", "1", "--target", "src/a.ts", "--mutant-memory-mb", "7168",
  ])).toBe(0);
  const result = jsonObject(decodeJson(readFileSync(join(input.root, "quality-mutation-results/native.json"), "utf8")));
  expect(result.command).toEqual(expect.arrayContaining(["--mutant-memory-mb", "7168"]));
  const document = jsonObject(result.document);
  expect(document.full).toBe(false);
  expect(document.complete).toBe(true);
  expect(jsonObject(document.selectedCounts).killed).toBe(1);
  expect(existsSync(join(input.root, "quality-mutation-results/current.json"))).toBe(false);
  await expect(mutationMain(["--limit", "1"])).rejects.toThrow("--limit/--target require --pilot");
  await expect(mutationMain(["--target", "src/a.ts"])).rejects.toThrow("--limit/--target require --pilot");
  // The budget plus the settle allowance must fit the runner deadline; the
  // refusal names the maximum so the workflow input can be corrected.
  const shard = ["--shard", "0", "--shard-count", "2", "--progress", "p.jsonl"];
  await expect(mutationMain([...shard, "--budget-minutes", "341"])).rejects.toThrow(
    "--budget-minutes exceeds the runner deadline (maximum 340)",
  );
}, 90000);

test("native full campaign records a complete measurement receipt and exits by survivor count", async () => {
  const input = await fixture("", "", {
    "src/a.test.ts": 'import "../support/assertion";',
    "packages/demo/src/main.ts": "export const run = true;",
    "support/assertion.ts": 'import {test,expect} from "bun:test";import {run} from "../packages/demo/src/main";test("behavior",()=>expect(run).toBe(true));',
  });
  // Candidate ownership follows each project's root files, not an importer's.
  expect(await mutationMain(prepareNative(input.root, true))).toBe(0);
  const native = jsonObject(decodeJson(readFileSync(join(input.root, "quality-mutation-results/native.json"), "utf8")));
  expect(native.command).toEqual(expect.arrayContaining(["--mutant-memory-mb", "6144"]));
  const document = jsonObject(native.document);
  expect(document.full).toBe(true);
  expect(document.complete).toBe(true);
  expect(jsonObject(document.counts).killed).toBe(1);
  const current = jsonObject(decodeJson(readFileSync(join(input.root, "quality-mutation-results/current.json"), "utf8")));
  expect(current.analyzed).toEqual(["mutation"]);
  expect(current.findings).toEqual([]);
}, 90000);

test("mutation normalization rejects pilots missing candidates and stale killed sources", () => {
  const root = mkdtempSync(join(tmpdir(), "quality-mutation-receipt-"));
  const source = "export const enabled = true;\n",
    path = "script/a.ts";
  const identity = {
    inventoryHash: "a".repeat(64),
    contractHash: "b".repeat(64),
    paths: [path],
    typescript: [path],
  };
  const result = {
    selected: true,
    restored: true,
    outcome: "killed",
    path,
    sourceSha256: digest(source),
    startOffset: 23,
    endOffset: 27,
    operator: "boolean",
    replacementSha256: digest("false"),
  };
  const receipt = completeReceipt(identity.inventoryHash, result, {
      killed: 1,
      survived: 0,
      noCoverage: 0,
      invalid: 0,
      infrastructure: 0,
      uncompleted: 0,
  }, [{ path, sha256: digest(source), operators: [{ candidates: 1 }] }]);
  try {
    mkdirSync(join(root, "script"));
    writeFileSync(join(root, path), source);
    expect(normalizeMutation(receipt, identity, root).findings).toEqual([]);
    for (const changed of [
      { ...receipt, full: false },
      { ...receipt, complete: false },
      { ...receipt, census: [] },
      { ...receipt, results: [] },
      { ...receipt, counts: { ...receipt.counts, killed: 2 } },
      { ...receipt, results: [{ ...result, selected: false }] },
      { ...receipt, results: [{ ...result, sourceSha256: "c".repeat(64) }] },
    ])
      expect(() => normalizeMutation(changed, identity, root)).toThrow();
    const survived = {
      ...receipt,
      results: [{ ...result, outcome: "survived" }],
      counts: { ...receipt.counts, killed: 0, survived: 1 },
    };
    expect(normalizeMutation(survived, identity, root).findings).toHaveLength(1);
    writeFileSync(join(root, path), `${source}// changed\n`);
    expect(() => normalizeMutation(receipt, identity, root)).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("embedded Python mutants retain original host coordinates and cannot disappear at normalization", () => {
  const root = mkdtempSync(join(tmpdir(), "quality-embedded-mutant-"));
  try {
    const hostPath = "packages/codemode/src/kernel.ts",
      path = `${hostPath}#PYTHON_DRIVER`;
    const source = "print(True)\n";
    const identity = {
      inventoryHash: "a".repeat(64),
      contractHash: "b".repeat(64),
      paths: [hostPath],
      typescript: [hostPath],
      embedded: [{ path, hostPath, text: source, sha256: digest(source), lineOffset: 10 }],
    };
    const result = {
      selected: true,
      restored: true,
      outcome: "survived",
      path,
      sourceSha256: digest(source),
      startOffset: 6,
      endOffset: 10,
      operator: "py-boolean",
      replacementSha256: digest("False"),
    };
    const receipt = completeReceipt(identity.inventoryHash, result, {
        killed: 0,
        survived: 1,
        noCoverage: 0,
        invalid: 0,
        infrastructure: 0,
        uncompleted: 0,
    }, [
        { path: hostPath, operators: [{ candidates: 0 }] },
        { path, operators: [{ candidates: 1 }] },
    ]);
    expect(normalizeMutation(receipt, identity, root).findings).toEqual([
      {
        gate: "mutation",
        path: hostPath,
        line: 11,
        symbol: `PYTHON_DRIVER:py-boolean:${digest("False")}:True`,
        value: 1,
      },
    ]);
    expect(() =>
      normalizeMutation({ ...receipt, census: receipt.census.slice(0, 1) }, identity, root),
    ).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
