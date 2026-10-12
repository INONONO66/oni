import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { baselineFor, classifyResidue, residueViolations, trackedAgentFiles } from "./check-comment-residue";

const a = "packages/agent/src/core/a.ts";
const b = "packages/agent/src/core/b.ts";
const original = { [a]: "// see #1234\n// ─── migrated ───\nexport const a = 1;\n", [b]: "export const b = 2;\n" };
const pin = baselineFor(original);

test("the committed pin set covers every tracked production file, including src roots", () => {
  const committed = JSON.parse(readFileSync(join(import.meta.dir, "conformance/comment-residue-pins.json"), "utf8")) as ReturnType<typeof baselineFor>;
  const paths = Object.keys(trackedAgentFiles());
  expect(paths).toContain("packages/agent/src/index.ts");
  expect(paths).toContain("packages/agent/src/bundle.ts");
  expect(Object.keys(committed.files).sort()).toEqual(paths.sort());
});

test("ratio counts syntax comments, not template prose or mixed executable lines", () => {
  expect(classifyResidue(a, "export const x = 1; /*\n * explanation\n */\n").commentLines).toBe(2);
  expect(classifyResidue(a, "export const s = `\n// text\n`;\n").commentLines).toBe(0);
  expect(classifyResidue(a, "const x = 1; // mixed\n// alone\n").commentLines).toBe(1);
});

test("comments in empty function bodies are discovered even with no semantic child", () => {
  const path = "packages/agent/src/core/empty.ts";
  expect(classifyResidue(path, "function noop() {\n// #9999\n// ─── migrated\n}")).toMatchObject({ issues: 1, dividers: 1 });
  expect(classifyResidue(path, "function noop() {\n/**\n * one\n * two\n * three\n * four\n * five\n */\n}").longJsdoc).toBe(1);
});

test("the exact baseline passes", () => {
  expect(residueViolations(original, pin)).toEqual([]);
});

test("a new issue-number comment fails per file", () => {
  expect(residueViolations({ ...original, [a]: `${original[a]}// see #9999\n` }, pin)).toContain(
    `${a}: issues actual 2, pin 1 (growth)`,
  );
});

test("removing an issue hit without lowering its pin fails", () => {
  expect(residueViolations({ ...original, [a]: "// ─── migrated ───\nexport const a = 1;\n" }, pin)).toContain(
    `${a}: issues actual 0, pin 1 (stale pin)`,
  );
});

test("a new divider fails", () => {
  expect(residueViolations({ ...original, [b]: "// ─── new ───\nexport const b = 2;\n" }, pin)).toContain(
    `${b}: dividers actual 1, pin 0 (growth)`,
  );
});

test("only the exact structural header is exempt; its issue number remains", () => {
  const path = "packages/agent/src/inspect/index.ts";
  const result = classifyResidue(path, "// ─── #1305: stored tool output read-back ───\n// ─── #1306: neighbouring header ───\n");
  expect(result).toMatchObject({ issues: 2, dividers: 1 });
  expect(classifyResidue(b, "// ─── #1305: stored tool output read-back ───\n").dividers).toBe(1);
});

test("issue numbers in code, strings and inline comments are not comment-only hits", () => {
  const source = 'const text = "#1234"; // #1235\nconst code = `#1236`;\n// #1237\n';
  expect(classifyResidue(a, source).issues).toBe(1);
});

test("a newly tracked file needs an explicit zero pin", () => {
  expect(residueViolations({ ...original, "packages/agent/src/new.ts": "// #9999\n" }, pin)).toContain(
    "packages/agent/src/new.ts: unpinned source file",
  );
});

test("moving residue between files reports growth and stale pin", () => {
  const found = residueViolations({ [a]: "// ─── migrated ───\nexport const a = 1;\n", [b]: "// #1234\nexport const b = 2;\n" }, pin);
  expect(found).toContain(`${a}: issues actual 0, pin 1 (stale pin)`);
  expect(found).toContain(`${b}: issues actual 1, pin 0 (growth)`);
});

test("long JSDoc blocks cannot grow above their baseline ceiling", () => {
  const source = "/**\n * one\n * two\n * three\n * four\n * five\n */\nexport const b = 2;\n";
  expect(residueViolations({ ...original, [b]: source }, pin)).toContain("long JSDoc blocks actual 1, ceiling 0");
});

test("comment ratio cannot grow above its measured ceiling", () => {
  const found = residueViolations({ ...original, [b]: "// one\n// two\nexport const b = 2;\n" }, pin);
  expect(found.some((message) => message.startsWith("comment ratio actual "))).toBe(true);
});
