import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const PACKAGE = resolve(import.meta.dir, "..");
const REPO = resolve(PACKAGE, "../..");
const HELPERS = join(PACKAGE, "test/helpers");
const BENCH = join(PACKAGE, "bench");

function filesUnder(dir: string, suffix: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((path) => path.endsWith(suffix) && !path.includes("node_modules"))
    .map((path) => join(dir, path))
    .sort();
}

/** The argument list of the call whose `(` sits at `open`, split at top-level commas. */
function callArguments(source: string, open: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let start = open + 1;
  for (let at = open; at < source.length; at += 1) {
    const char = source[at];
    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") {
      depth -= 1;
      if (depth === 0) return [...args, source.slice(start, at).trim()];
    } else if (char === "," && depth === 1) {
      args.push(source.slice(start, at).trim());
      start = at + 1;
    }
  }
  return args;
}

/** Headers of the blocks enclosing `index`, innermost first. */
function enclosingHeaders(source: string, index: number): string[] {
  const headers: string[] = [];
  let depth = 0;
  for (let at = index - 1; at >= 0; at -= 1) {
    const char = source[at];
    if (char === "}") depth += 1;
    else if (char === "{") {
      if (depth === 0) headers.push(source.slice(source.lastIndexOf("\n", at) + 1, at).trim());
      else depth -= 1;
    }
  }
  return headers;
}

const LOOP_HEADER = /^(?:for|while|do)\b/;
const BOUNDED_FOR = /^for \(let (\w+) = [^;]+; \1 < \w+; /;

/** Every `yieldNow` inside a loop must sit in a counter-bounded `for`, and no `setTimeout` takes a zero delay. */
function helperHazards(path: string): string[] {
  const source = readFileSync(path, "utf8");
  const where = (index: number) => `${relative(PACKAGE, path)}:${source.slice(0, index).split("\n").length}`;
  const hazards: string[] = [];
  for (const match of source.matchAll(/\bsetTimeout\(/g)) {
    const delay = callArguments(source, match.index + match[0].length - 1)[1];
    if (delay === undefined || delay === "0") hazards.push(`${where(match.index)} zero-delay setTimeout`);
  }
  for (const match of source.matchAll(/\byieldNow\b/g)) {
    const loop = enclosingHeaders(source, match.index).find((header) => LOOP_HEADER.test(header));
    if (loop !== undefined && !BOUNDED_FOR.test(loop)) hazards.push(`${where(match.index)} unbounded yieldNow spin`);
  }
  return hazards;
}

test("helper scan: no unbounded yieldNow spin and no zero-delay setTimeout in test/helpers", () => {
  const helpers = filesUnder(HELPERS, ".ts");
  expect(helpers.length).toBeGreaterThan(0);
  expect(helpers.flatMap(helperHazards)).toEqual([]);
});

test("helper scan: the detector flags an unbounded spin and a zero-delay timer", () => {
  const source = [
    "while (!ready()) { yield* Effect.yieldNow; }",
    "for (let turn = 0; turn < MAX; turn += 1) { yield* Effect.yieldNow; }",
    "setTimeout(() => wake(), 0);",
    "setTimeout(() => fail(), capMs);",
  ].join("\n");
  const at = (needle: string, from = 0) => source.indexOf(needle, from);
  const second = at("yieldNow", at("yieldNow") + 1);
  expect(enclosingHeaders(source, at("yieldNow"))).toEqual(["while (!ready())"]);
  expect(BOUNDED_FOR.test(enclosingHeaders(source, second)[0] ?? "")).toBe(true);
  expect(callArguments(source, at("setTimeout(") + "setTimeout".length)).toEqual(["() => wake()", "0"]);
  expect(callArguments(source, at("setTimeout(() => fail") + "setTimeout".length)[1]).toBe("capMs");
});

/** Bench entries: test files the runner discovers, plus the files the bench script and workflow invoke. */
function benchEntries(): string[] {
  const scripts = JSON.parse(readFileSync(join(PACKAGE, "package.json"), "utf8")).scripts as Record<string, string>;
  const workflow = readFileSync(join(REPO, ".github/workflows/benchmark.yml"), "utf8");
  const invoked = [
    ...Object.values(scripts).flatMap((script) => [...script.matchAll(/\bbench\/[\w-]+\.ts\b/g)].map((m) => m[0])),
    ...[...workflow.matchAll(/--cwd packages\/agent (bench\/[\w-]+\.ts)\b/g)].map((m) => m[1] ?? ""),
  ].map((path) => join(PACKAGE, path));
  return [...filesUnder(BENCH, ".test.ts"), ...invoked];
}

function benchImports(path: string): string[] {
  const source = readFileSync(path, "utf8");
  return [...source.matchAll(/(?:from\s+|import\()\s*"(\.[^"]*)"/g)]
    .map((match) => resolve(BENCH, match[1] ?? ""))
    .filter((target) => target === BENCH || target.startsWith(`${BENCH}/`))
    .map((target) => (target === BENCH ? join(BENCH, "index.ts") : `${target}.ts`))
    .filter((target) => existsSync(target));
}

test("bench discovery: every bench file is a discovered test or reachable from an invoked entry", () => {
  const reached = new Set<string>();
  const pending = benchEntries();
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (reached.has(next)) continue;
    reached.add(next);
    pending.push(...benchImports(next));
  }
  expect(filesUnder(BENCH, ".ts").filter((path) => !reached.has(path))).toEqual([]);
  expect(existsSync(join(BENCH, "bucket-lookup.ts"))).toBe(false);
});

test("bench discovery: every package .bench.ts suite is invoked by the benchmark workflow", () => {
  const workflow = readFileSync(join(REPO, ".github/workflows/benchmark.yml"), "utf8");
  const suites = filesUnder(join(PACKAGE, "test"), ".bench.ts").map((path) => relative(REPO, path));
  expect(suites.length).toBeGreaterThan(0);
  expect(suites.filter((suite) => !workflow.includes(`./${suite}`))).toEqual([]);
});
