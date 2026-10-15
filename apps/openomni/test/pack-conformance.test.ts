import * as childProcess from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, spyOn, test } from "bun:test";
import { z } from "zod";
import { AppInvariantError } from "../src/invariant";
import { cases, packKinds, type PackKind, refusals } from "./helpers/pack-kinds";

// The probe has no production pack loader. Its registration still runs through
// the same fixture discovery and assertions as the shipped kinds.
const probeRoot = join(import.meta.dir, "fixtures/packs/probe");
const ProbeFile = z.strictObject({
  rows: z.array(z.strictObject({ id: z.string().min(1) })).min(1),
});
const probe: PackKind = {
  kind: "probe",
  fixturesRoot: probeRoot,
  load: (path) => {
    const parsed = ProbeFile.safeParse(JSON.parse(readFileSync(join(path, "value.json"), "utf8")));
    if (!parsed.success) throw new AppInvariantError(parsed.error.message, "invalid_probe");
    return parsed.data.rows;
  },
  codes: new Set(["invalid_probe"]),
  valid: cases(join(probeRoot, "valid")),
  invalid: refusals(join(probeRoot, "invalid")),
  fixturePath: (path) => path,
};

const kinds: readonly PackKind[] = [...packKinds, probe];
const temporaryFixtures = mkdtempSync(join(tmpdir(), "pack-conformance-"));
afterAll(() => rmSync(temporaryFixtures, { recursive: true, force: true }));

// Raw bytes retain intentionally malformed JSON without making the tracked
// fixture tree fail the repository's JSON formatter.
function fixtureDir(path: string): string {
  const rawFiles = readdirSync(path, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json.raw"));
  if (rawFiles.length === 0) return path;
  const target = join(temporaryFixtures, randomUUID());
  cpSync(path, target, { recursive: true });
  const materialized: string[] = [];
  for (const entry of readdirSync(target, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".json.raw")) {
      const source = join(entry.parentPath, entry.name);
      const file = source.slice(0, -".raw".length);
      renameSync(source, file);
      materialized.push(file);
    }
  }
  // A raw file exists only to carry malformed JSON: every copy must be present
  // and unparseable, otherwise the case would refuse for a different reason
  // (a missing file) and still match the expected code.
  expect(materialized).toHaveLength(rawFiles.length);
  for (const file of materialized) {
    expect(existsSync(file)).toBe(true);
    expect(() => JSON.parse(readFileSync(file, "utf8"))).toThrow();
  }
  return target;
}

function refusal(load: () => readonly object[]): AppInvariantError {
  try {
    load();
  } catch (error) {
    if (error instanceof AppInvariantError) return error;
    throw error;
  }
  throw new Error("fixture silently loaded instead of refusing");
}

for (const kind of kinds) {
  test(`${kind.kind}: every declared refusal code has a fixture and the suite cannot pass vacuously`, () => {
    expect(kind.valid.length).toBeGreaterThan(0);
    expect(kind.invalid.length).toBeGreaterThan(0);
    expect(new Set(kind.invalid.map((entry) => entry.code))).toEqual(new Set(kind.codes));
  });

  for (const name of kind.valid) {
    test(`${kind.kind}: ${name} loads reproducibly without process creation`, () => {
      const path = kind.fixturePath(fixtureDir(join(kind.fixturesRoot, "valid", name)));
      const bunSpawn = spyOn(Bun, "spawn");
      const nodeSpawn = spyOn(childProcess, "spawn");
      const fetch = spyOn(globalThis, "fetch");
      try {
        const first = kind.load(path);
        const second = kind.load(path);
        expect(first.length).toBeGreaterThan(0);
        expect(second).toEqual(first);
        expect(bunSpawn).not.toHaveBeenCalled();
        expect(nodeSpawn).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
      } finally {
        bunSpawn.mockRestore();
        nodeSpawn.mockRestore();
        fetch.mockRestore();
      }
    });
  }

  for (const { name, code } of kind.invalid) {
    test(`${kind.kind}: ${name} refuses with a typed code without process creation`, () => {
      const path = kind.fixturePath(fixtureDir(join(kind.fixturesRoot, "invalid", name)));
      const bunSpawn = spyOn(Bun, "spawn");
      const nodeSpawn = spyOn(childProcess, "spawn");
      const fetch = spyOn(globalThis, "fetch");
      try {
        const error = refusal(() => kind.load(path));
        expect(kind.codes.has(code)).toBe(true);
        expect(kind.codes.has(error.code ?? "")).toBe(true);
        expect(error.code).toBe(code);
        expect(error.message.trim()).not.toBe("");
        expect(bunSpawn).not.toHaveBeenCalled();
        expect(nodeSpawn).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
      } finally {
        bunSpawn.mockRestore();
        nodeSpawn.mockRestore();
        fetch.mockRestore();
      }
    });
  }
}
