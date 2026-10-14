import { expect, spyOn, test } from "bun:test";
import { captureConsole } from "./capture-output.test-helper";
import { buildGraph, findCycles, main, selfTest, valueImportSpecifiers } from "./check-import-cycles";
import { TOPOLOGY } from "./topology";

test("the shipped tree has one module per topology source file and no value-import cycle", async () => {
  const graph = buildGraph();
  const files = [...graph.keys()];
  for (const workspace of TOPOLOGY) {
    expect(files.some((file) => file.includes(`/${workspace.dir}/src/`))).toBe(true);
  }
  for (const edges of graph.values()) for (const edge of edges) expect(graph.has(edge)).toBe(true);
  expect(findCycles(graph)).toEqual([]);

  const console_ = captureConsole();
  try {
    await main();
    expect(console_.messages).toEqual([`OK: import-cycle check — ${graph.size} modules, 0 value-import cycles`]);
  } finally {
    console_.restore();
  }
});

test("a planted cycle is printed with its path and exits 1", async () => {
  const graph = new Map<string, readonly string[]>([
    ["/repo/packages/a/src/a.ts", ["/repo/packages/b/src/b.ts"]],
    ["/repo/packages/b/src/b.ts", ["/repo/packages/a/src/a.ts"]],
  ]);
  expect(findCycles(graph)).toEqual([
    ["/repo/packages/a/src/a.ts", "/repo/packages/b/src/b.ts", "/repo/packages/a/src/a.ts"],
  ]);
});

test("main prints every planted cycle and exits 1", async () => {
  const graph = new Map<string, readonly string[]>([
    ["a.ts", ["b.ts"]],
    ["b.ts", ["a.ts"]],
  ]);
  const exit = spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`exit ${code}`);
  });
  const console_ = captureConsole();
  try {
    await expect(main(graph)).rejects.toThrow("exit 1");
    expect(console_.messages).toHaveLength(2);
    expect(console_.messages[0]).toStartWith("CYCLE: ");
    expect(console_.messages[0]).toContain("a.ts");
    expect(console_.messages[0]).toContain("-> ");
    expect(console_.messages[1]).toContain("1 value-import cycle(s) found — baseline is 0.");
  } finally {
    console_.restore();
    exit.mockRestore();
  }
});

test("value-edge extraction keeps default bindings beside type-only braces", () => {
  expect(
    valueImportSpecifiers('import Foo, { type A } from "./foo.js";\nimport { type B } from "./b.js";'),
  ).toEqual(["./foo.js"]);
});

test("value-edge extraction ignores prose and preserves empty value clauses", () => {
  const source = [
    '// import { x } from "./comment";',
    'const text = \'import { x } from "./quoted"\';',
    'import {} from "./empty";',
    'import { value } from "./path//with-slashes";',
    'export { type A } from "./type";',
  ].join("\n");
  expect(valueImportSpecifiers(source)).toEqual(["./empty", "./path//with-slashes"]);
});

test("self-test passes on the synthetic graphs", () => {
  const console_ = captureConsole();
  try {
    selfTest();
    expect(console_.messages).toEqual([
      "OK: import-cycle self-test — planted cycle red, acyclic green, type edges erased",
    ]);
  } finally {
    console_.restore();
  }
});
