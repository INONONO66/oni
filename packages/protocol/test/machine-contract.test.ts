import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { machineSchemas } from "../../../script/generate-machine-schema.ts";
import { Machine } from "../src/machine/index.js";

const repoRoot = join(import.meta.dir, "../../..");
const schemaDir = join(import.meta.dir, "../schema/machine");
const fixtureDir = join(import.meta.dir, "../fixtures/machine");
const SchemaIndex = z
  .object({
    contractVersion: z.number(),
    schemas: z.array(z.object({ name: z.string(), file: z.string() }).strict()),
  })
  .strict();
const schemas = new Map(machineSchemas().map(({ name, schema }) => [name, schema]));

function fixtures(kind: "valid" | "invalid"): string[] {
  return readdirSync(join(fixtureDir, kind))
    .filter((file) => file.endsWith(".json"))
    .sort();
}

async function parseFixture(kind: "valid" | "invalid", file: string) {
  const name = file.slice(0, file.indexOf("."));
  const schema = schemas.get(name);
  if (schema === undefined) throw new Error(`fixture ${kind}/${file} names no machine schema`);
  return schema.safeParse(await Bun.file(join(fixtureDir, kind, file)).json());
}

describe("machine wire contract fixtures", () => {
  test.each(fixtures("valid"))("valid/%s parses", async (file) => {
    const parsed = await parseFixture("valid", file);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const fixture = await Bun.file(join(fixtureDir, "valid", file)).json();
    expect(JSON.parse(JSON.stringify(parsed.data))).toEqual(fixture);
  });

  test.each(fixtures("invalid"))("invalid/%s is refused", async (file) => {
    const parsed = await parseFixture("invalid", file);
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const issue = parsed.error.issues[0];
    expect(issue?.code.length).toBeGreaterThan(0);
    // Zod reports root-level schemas and object-level refinements at [].
    const rootFailures = [
      "AbsolutePath.wrong-type.json",
      "CancelResult.positional-array.json",
      "CapabilityId.wrong-type.json",
      "ExecRequest.positional-array.json",
      "ExportName.wrong-type.json",
      "KeyFingerprint.wrong-type.json",
      "MachineId.wrong-type.json",
      "PtySessionName.wrong-type.json",
      "CapacityRow.missing-selector.json",
      "CapacityRow.wrong-type.json",
      "CapacityRows.wrong-type.json",
      "InputAction.unknown-action.json",
      "InputAction.wrong-type.json",
      "PeekAnswer.wrong-type.json",
      "PtyCursor.wrong-type.json",
      "PtyListRequest.wrong-type.json",
      "PtyReadParams.missing-name.json",
      "WireMethod.unknown-method.json",
    ];
    const rootFailure = rootFailures.includes(file);
    expect(issue?.path.length).toBeGreaterThan(rootFailure ? -1 : 0);
  });

  test("every schema has at least one valid and one invalid fixture", () => {
    const covered = (kind: "valid" | "invalid") =>
      new Set(fixtures(kind).map((file) => file.slice(0, file.indexOf("."))));
    expect([...schemas.keys()].filter((name) => !covered("valid").has(name))).toEqual([]);
    expect([...schemas.keys()].filter((name) => !covered("invalid").has(name))).toEqual([]);
  });
});

describe("machine JSON Schema export", () => {
  test("index.json lists exactly the schema files on disk", async () => {
    const index = SchemaIndex.parse(await Bun.file(join(schemaDir, "index.json")).json());
    const onDisk = readdirSync(schemaDir)
      .filter((file) => file.endsWith(".json") && file !== "index.json")
      .sort();
    expect(index.contractVersion).toBe(Machine.contractVersion);
    expect(index.schemas.map((entry) => entry.file).sort()).toEqual(onDisk);
    expect(onDisk).toEqual([...schemas.keys()].map((name) => `${name}.json`).sort());
  });

  test("the committed export is current under --check", async () => {
    const check = Bun.spawn(
      [process.execPath, "run", "script/generate-machine-schema.ts", "--check"],
      {
        cwd: repoRoot,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stderr] = await Promise.all([check.exited, new Response(check.stderr).text()]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
  });
});
