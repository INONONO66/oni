import * as childProcess from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, spyOn, test } from "bun:test";
import { z } from "zod";
import { AppInvariantError } from "../src/invariant";
import { packKinds, type PackKind } from "./helpers/pack-kinds";

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
  valid: readdirSync(join(probeRoot, "valid")),
  invalid: readdirSync(join(probeRoot, "invalid")).map((name) => ({
    name,
    code: name.split("--")[0] ?? "",
  })),
  fixturePath: (path) => path,
};

const kinds: readonly PackKind[] = [...packKinds, probe];

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
  for (const name of kind.valid) {
    test(`${kind.kind}: ${name} loads reproducibly without process creation`, () => {
      const path = kind.fixturePath(join(kind.fixturesRoot, "valid", name));
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
      const path = kind.fixturePath(join(kind.fixturesRoot, "invalid", name));
      const bunSpawn = spyOn(Bun, "spawn");
      const nodeSpawn = spyOn(childProcess, "spawn");
      const fetch = spyOn(globalThis, "fetch");
      try {
        const error = refusal(() => kind.load(path));
        expect(kind.codes.has(code)).toBe(true);
        expect(error).toBeInstanceOf(AppInvariantError);
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

const valid = kinds.reduce((count, kind) => count + kind.valid.length, 0);
const invalid = kinds.reduce((count, kind) => count + kind.invalid.length, 0);
console.log(`kinds=${kinds.length} fixtures=${valid + invalid} assertions=${valid * 5 + invalid * 8}`);
