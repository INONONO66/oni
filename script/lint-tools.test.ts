import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureOutput } from "./capture-output.test-helper";
import { normalizeKnipIssues, runKnip } from "./check-dead-exports";
import type { PlainValue } from "../packages/protocol/src/json";
import type { AnyToolDefinition, ToolCategory } from "../packages/protocol/src/tool";
import {
  checkEarned,
  checkNaming,
  checkToolLint,
  checkVocabRatchet,
  definitionInvariantViolations,
  diffSnapshots,
  diffToolSchemaSnapshots,
  lintToolSurface,
  namingViolations,
  recordToolLocation,
  main as lintToolsMain,
  selfTest,
  type Baseline,
  type LocatedDefinition,
  type ToolSurface,
  defaultChecks,
  selfTestFailures,
  reportViolations,
} from "./lint-tools";

function definition(
  name: string,
  category: ToolCategory = "query",
  overrides: Partial<AnyToolDefinition> = {},
): AnyToolDefinition {
  return {
    name,
    category,
    description: `${name} description`,
    input: {} as never,
    output: {} as never,
    visibility: { model: ["resident"], cell: ["resident"] },
    execute: async () => undefined,
    render: () => "",
    ...overrides,
  };
}

function located(item: AnyToolDefinition, directory = item.category): LocatedDefinition {
  return {
    definition: item,
    filePath: `apps/openomni/src/tools/${directory}/${item.name.replaceAll("_", "-")}.ts`,
  };
}

function messages(
  definitions: readonly AnyToolDefinition[],
  locations: readonly LocatedDefinition[],
) {
  return definitionInvariantViolations(definitions, locations).map(({ message }) => message);
}

const DELETED_SYMBOLS = ["TranscriptStore", "claimSurface", "McpClient", "runtime/mcp"] as const;
const knipFixtures: string[] = [];

afterEach(async () => {
  await Promise.all(knipFixtures.splice(0).map((fixture) => rm(fixture, { recursive: true })));
});

async function deletedSymbolViolations(): Promise<string[]> {
  const violations: string[] = [];
  const repoRoot = join(import.meta.dir, "..");
  for (const root of ["apps", "packages", "script"] as const) {
    let scanned = 0;
    const glob = new Bun.Glob(`${root}/**/*.{ts,tsx}`);
    for await (const filePath of glob.scan({ cwd: repoRoot, onlyFiles: true })) {
      if (
        /\.(?:test|spec)\.tsx?$/.test(filePath) ||
        /\/(?:test|tests|__tests__|fixtures|dist|node_modules)\//.test(filePath)
      )
        continue;
      scanned += 1;
      const source = await Bun.file(join(repoRoot, filePath)).text();
      for (const symbol of DELETED_SYMBOLS) {
        if (filePath.includes(symbol) || source.includes(symbol)) {
          violations.push(`${symbol} ${filePath}`);
        }
      }
    }
    expect(scanned, `empty production census: ${root}`).toBeGreaterThan(0);
  }
  return violations.sort((left, right) => left.localeCompare(right));
}

describe("tool surface lint (#949 sealed catalog grammar)", () => {
  test("camelCase names, including the retired sendMessage spelling, fail the tool-name rule", () => {
    for (const name of ["sendMessage", "DoThingNowFastPlease"]) {
      expect(
        lintToolSurface({ name, description: "x", inputSchema: { type: "object" } }).map(
          (failure) => failure.rule,
        ),
      ).toEqual(["tool-name"]);
    }
  });
  test("seven public fields is the sealed budget; an eighth is over", () => {
    const surface = (count: number) => {
      const properties: Record<string, PlainValue> = {};
      for (let index = 0; index < count; index++) properties[`f${index}`] = {};
      return lintToolSurface({
        name: "grep",
        description: "x",
        inputSchema: { type: "object", properties },
      }).map((failure) => failure.rule);
    };
    expect(surface(7)).toEqual([]);
    expect(surface(8)).toEqual(["tool-max-fields"]);
  });

  test("unresolved references and invalid union members cannot inflate the field budget", () => {
    const inputSchema: PlainValue = {
      type: "object",
      properties: { a: {} },
      allOf: [{ $ref: "#/$defs/missing" }],
      anyOf: [null, { properties: { b: {} } }],
      oneOf: [false, { properties: { c: {} } }],
    };
    expect(lintToolSurface({ name: "grep", description: "x", inputSchema })).toEqual([]);
  });

  test("a reference to a scalar, array, or null does not contribute object fields", () => {
    for (const target of ["scalar", ["array"], null]) {
      expect(lintToolSurface({
        name: "grep",
        description: "ok",
        inputSchema: {
          $defs: { target },
          properties: { a: {}, b: {}, c: {}, d: {}, e: {}, f: {}, g: {} },
          $ref: "#/$defs/target",
        },
      })).toEqual([]);
    }
  });

  test("local references count decoded property names toward the budget", () => {
    const inputSchema: PlainValue = {
      $defs: { "common/fields": { properties: { h: {} } } },
      properties: { a: {}, b: {}, c: {}, d: {}, e: {}, f: {}, g: {} },
      $ref: "#/$defs/common~1fields",
    };
    expect(
      lintToolSurface({ name: "grep", description: "x", inputSchema }).map(({ rule }) => rule),
    ).toEqual(["tool-max-fields"]);
  });
});

describe("deleted surface census", () => {
  test("deleted production symbols stay absent", async () => {
    expect(await deletedSymbolViolations()).toEqual([]);
  });

  // Two Knip subprocesses may exceed Bun's default timeout on a cold install.
  test("Knip detects a synthetic unused package-root export and clears after removal", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "openomni-knip-"));
    knipFixtures.push(fixture);
    await writeFile(
      join(fixture, "package.json"),
      `${JSON.stringify({ name: "dead-export-fixture", type: "module" })}\n`,
    );
    await writeFile(join(fixture, "knip.json"), `${JSON.stringify({ entry: ["index.ts"] })}\n`);
    await writeFile(join(fixture, "index.ts"), "export const DormantStore = 1;\n");

    expect(normalizeKnipIssues(await runKnip(fixture, false, true))).toEqual([
      "exports index.ts DormantStore",
    ]);

    await writeFile(join(fixture, "index.ts"), "export {};\n");
    expect(normalizeKnipIssues(await runKnip(fixture, false, true))).toEqual([]);
  }, 30_000);
});

describe("lint-tools definition invariants", () => {
  test("a correctly located definition passes", () => {
    const item = definition("healthy_query");
    expect(definitionInvariantViolations([item], [located(item)])).toEqual([]);
  });

  test("category is independent of the target directory", () => {
    const item = definition("read");
    expect(
      definitionInvariantViolations(
        [item],
        [{ definition: item, filePath: "apps/openomni/src/tools/fs/read.ts" }],
      ),
    ).toEqual([]);
  });

  test("the file name is the tool name in kebab-case (KERNEL 3.5)", () => {
    const item = definition("send_message");
    expect(
      definitionInvariantViolations(
        [item],
        [{ definition: item, filePath: "apps/openomni/src/tools/send-message.ts" }],
      ),
    ).toEqual([]);
    for (const filePath of [
      "apps/openomni/src/tools/send_message.ts",
      "apps/openomni/src/tools/messaging.ts",
    ]) {
      expect(messages([item], [{ definition: item, filePath }])).toContainEqual(
        expect.stringContaining("[tool-file-name]"),
      );
    }
  });

  test("every catalog definition must map to a source file", () => {
    const item = definition("unlocated_query");
    expect(messages([item], [])).toContainEqual(expect.stringContaining("[tool-source-location]"));
  });

  test("tool names must be unique", () => {
    const first = definition("duplicate_name");
    const second = definition("duplicate_name", "mutation");
    expect(
      messages([first, second], [located(first), located(second)]).filter((message) =>
        message.includes("[tool-name-unique]"),
      ),
    ).toHaveLength(2);
  });

  test("derived snapshot drift fails and identical snapshots pass", () => {
    const snapshot = [{ name: "read", safe: true }];
    expect(diffToolSchemaSnapshots(snapshot, snapshot)).toEqual([]);
    expect(diffToolSchemaSnapshots(snapshot, [{ name: "write", safe: false }])).toMatchObject([
      { check: "tool-schema-snapshot", subject: "catalogDefinitions" },
    ]);
  });

  test("removed protocol types and fields fail while additive fields pass", () => {
    expect(diffSnapshots({ "Tool.Call": ["id"] }, {})).toMatchObject([
      { check: "schema-snapshot", subject: "Tool.Call" },
    ]);
    expect(
      diffSnapshots({ "Tool.Call": ["id"] }, { "Tool.Call": ["payload"] })[0]?.message,
    ).toContain("id");
    expect(diffSnapshots({ "Tool.Call": ["id"] }, { "Tool.Call": ["id", "extra"] })).toEqual([]);
  });
});

test("the vocab ratchet reports newly unmapped and stale grandfathered namespaces", async () => {
  const baseline: Baseline = JSON.parse(
    readFileSync(join(import.meta.dir, "conformance/lint-tools-baseline.json"), "utf8"),
  );
  const newViolation = await checkVocabRatchet({
    ...baseline,
    vocab: {
      unmappedNamespaces: baseline.vocab.unmappedNamespaces.filter((name) => name !== "bus"),
    },
  });
  expect(newViolation).toMatchObject([{ check: "vocab-ratchet", subject: "bus" }]);

  const staleViolation = await checkVocabRatchet({
    ...baseline,
    vocab: { unmappedNamespaces: [...baseline.vocab.unmappedNamespaces, "actor"] },
  });
  expect(staleViolation).toMatchObject([{ check: "vocab-ratchet", subject: "actor" }]);
});

test("the shipped catalog passes tool lint and earned-definition checks in-process", async () => {
  const baseline: Baseline = JSON.parse(
    readFileSync(join(import.meta.dir, "conformance/lint-tools-baseline.json"), "utf8"),
  );
  expect(await checkToolLint(baseline)).toEqual([]);
  expect(await checkEarned()).toEqual([]);
});

test("the protocol tree passes the vocab ratchet and naming checks in-process regardless of cwd", async () => {
  const baseline: Baseline = JSON.parse(
    readFileSync(join(import.meta.dir, "conformance/lint-tools-baseline.json"), "utf8"),
  );
  const previousCwd = process.cwd();
  process.chdir(tmpdir());
  try {
    expect(await checkVocabRatchet(baseline)).toEqual([]);
    expect(await checkNaming(baseline)).toEqual([]);
  } finally {
    process.chdir(previousCwd);
  }
});

test("the full conformance gate passes in-process against the shipped tree", async () => {
  const output = await captureOutput(async () => {
    // main exits the process on any violation, so returning is the verdict.
    await expect(lintToolsMain([])).resolves.toBeUndefined();
  });
  expect(output).toStartWith("OK: conformance lint");
});

test("the self-test discriminates on its known-bad fixtures in-process", () => {
  // selfTest exits the process on a failed discrimination, so returning at all
  // is the assertion; the spawned --self-test lane checks the same behavior.
  expect(selfTest()).toBeUndefined();
});

test("a definition cannot claim two distinct source files", () => {
  const item = definition("read");
  const locations = new Map<AnyToolDefinition, string>();
  recordToolLocation(locations, item, "tools/read.ts");
  recordToolLocation(locations, item, "tools/read.ts");
  expect(locations.get(item)).toBe("tools/read.ts");
  expect(() => recordToolLocation(locations, item, "bundles/read/index.ts")).toThrow(
    "tool read has ambiguous source: tools/read.ts, bundles/read/index.ts",
  );
  expect(locations.get(item)).toBe("tools/read.ts");
});

test("naming lint reports only new banned identifiers in a source fixture", () => {
  expect(namingViolations(
    "packages/protocol/src/fixture.ts",
    "export const OldTask = 1; export class NewEnvelope {} export const CleanSchema = 1;",
    new Set(["packages/protocol/src/fixture.ts:OldTask"]),
  )).toEqual([{
    check: "naming",
    subject: "packages/protocol/src/fixture.ts:NewEnvelope",
    message: "new protocol identifier uses a banned noun (runtime/task/envelope) or a *Module wrapper name (#465 naming rules)",
  }]);
});

test("tool lint reports unexcepted fixture defects and honors a named exception", async () => {
  const baseline: Baseline = {
    vocab: { unmappedNamespaces: [] },
    naming: { grandfathered: [] },
    tools: { exceptions: { badName: ["tool-name"] } },
  };
  const surfaces: readonly ToolSurface[] = [
    { name: "badName", description: " ", inputSchema: { properties: {} } },
    {
      name: "otherBadName",
      description: "ok",
      inputSchema: {
        properties: { a: {}, b: {}, c: {}, d: {}, e: {}, f: {}, g: {}, h: {} },
      },
    },
  ];

  expect(await checkToolLint(baseline, surfaces)).toEqual([
    {
      check: "tool-lint",
      subject: "badName",
      message: "[tool-description] description is required",
    },
    {
      check: "tool-lint",
      subject: "otherBadName",
      message: "[tool-name] name must be snake_case (dot namespacing allowed), ≤3 segments",
    },
    {
      check: "tool-lint",
      subject: "otherBadName",
      message: "[tool-max-fields] public input schema exceeds 7 top-level fields",
    },
  ]);
});

test("update mode builds both snapshots without writing conformance baselines", async () => {
  const writes: { path: string; contents: string }[] = [];
  const output = await captureOutput(() => lintToolsMain(["--update"], {
    writeSnapshot: (path, contents) => { writes.push({ path, contents }); },
  }));
  expect(writes.map(({ path }) => path.replaceAll("\\", "/").split("/").at(-1))).toEqual([
    "schema-snapshot.json", "tool-schema-snapshot.json",
  ]);
  const schema = JSON.parse(writes[0]?.contents ?? "null");
  const tools = JSON.parse(writes[1]?.contents ?? "null");
  expect(Object.keys(schema).length).toBeGreaterThan(0);
  expect(tools.length).toBeGreaterThan(0);
  expect(output).toBe(
    `OK: snapshots regenerated (${Object.keys(schema).length} protocol types, ${tools.length} derived tool specs) — these diffs are the review surface\n`,
  );
});

test("reportViolations writes the exact violating check and exits 1", () => {
  const errors: string[] = [];
  const stderr = spyOn(process.stderr, "write").mockImplementation((chunk) => {
    errors.push(String(chunk));
    return true;
  });
  const exit = spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`exit ${code}`);
  });
  try {
    expect(() => reportViolations([
      { check: "naming", subject: "fixture.ts:BadTask", message: "banned noun" },
    ])).toThrow("exit 1");
    expect(errors).toEqual(["VIOLATION [naming] fixture.ts:BadTask — banned noun\n"]);
  } finally {
    exit.mockRestore();
    stderr.mockRestore();
  }
});

test("self-test reports a broken check and exits 1", () => {
  const errors: string[] = [];
  const check = spyOn(defaultChecks, "unmappedNamespaces").mockImplementation(() => []);
  const stderr = spyOn(process.stderr, "write").mockImplementation((chunk) => {
    errors.push(String(chunk));
    return true;
  });
  const exit = spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`exit ${code}`);
  });
  try {
    expect(() => selfTest()).toThrow("exit 1");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every((line) => line.startsWith("SELF-TEST FAIL:"))).toBe(true);
  } finally {
    exit.mockRestore();
    stderr.mockRestore();
    check.mockRestore();
  }
});

test("self-test CLI mode returns its discrimination verdict", async () => {
  expect(await captureOutput(() => lintToolsMain(["--self-test"]))).toBe(
    "OK: lint-tools self-test — all checks discriminate on known-bad fixtures\n",
  );
});

test("self-test detects mutant check implementations", () => {
  expect(selfTestFailures({ ...defaultChecks, exemplar: undefined })).toHaveLength(1);
  const failures = selfTestFailures({
    ...defaultChecks,
    unmappedNamespaces: (names) => names.includes("wait") ? ["wait"] : [],
    lintToolSurface: (tool) => JSON.stringify(tool.inputSchema).includes('"path"')
      ? [{ rule: "tool-name", message: "mutant" }] : [],
    namingOffenders: (_path, source) => source.includes("WaitSchema") ? ["x"] : [],
    definitionInvariantViolations: () => [],
    topLevelFieldCount: () => 0,
    diffSnapshots: (_previous, current) => JSON.stringify(current).includes('"extra"')
      ? [{ check: "schema-snapshot", subject: "Tool.Call", message: "mutant" }] : [],
    diffToolSchemaSnapshots: (_previous, current) => current[0]?.name === "a"
      ? [{ check: "tool-schema-snapshot", subject: "catalogDefinitions", message: "mutant" }] : [],
  });
  expect(failures).toHaveLength(18);
});
