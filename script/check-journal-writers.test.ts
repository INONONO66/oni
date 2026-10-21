import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  checkJournalWriters,
  journalWriterDeclarations,
  journalWriterFindings,
} from "./check-journal-writers";

const ROOT = join(import.meta.dir, "..");
const checker = join(import.meta.dir, "check-journal-writers.ts");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const ALARM_DECLARATION = `/**
 * \`alarm\` — one timer kind. Single writer: the core timer constructor
 * (\`packages/agent/src/core/ports/alarm.ts\`).
 */
export const alarm = declare(
  "alarm",
  schema,
);
`;

const OWNER_WRITER = `export function alarmAction() {
  return { id: "a", parentId: null, sessionId: "s", kind: "alarm", ts: 1, irreversible: true };
}
`;

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "journal-writers-"));
  roots.push(root);
  for (const [path, source] of Object.entries(files)) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, source);
  }
  return root;
}

function run(root: string) {
  const result = Bun.spawnSync([process.execPath, checker, "--root", root], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 15_000,
  });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

test("a second append literal for a declared kind outside its writer module fails", () => {
  const root = fixture({
    "packages/protocol/src/journal/core/alarm.ts": ALARM_DECLARATION,
    "packages/agent/src/core/ports/alarm.ts": OWNER_WRITER,
    "apps/oni/src/rogue.ts":
      'const planted = { id: "x", parentId: null, sessionId: "s", kind: "alarm", ts: 2, irreversible: true };\nexport default planted;\n',
  });

  const result = run(root);

  expect(result).toEqual({
    code: 1,
    stdout: "",
    stderr:
      'VIOLATION [journal-writers] apps/oni/src/rogue.ts:1 kind "alarm" is owned by packages/agent/src/core/ports/alarm.ts\n',
  });

  // Same tree in-process: the finding carries the exact location and owner,
  // and the CLI shell reports the violating exit code.
  expect(journalWriterFindings(root)).toEqual([
    {
      file: "apps/oni/src/rogue.ts",
      line: 1,
      kind: "alarm",
      writer: "packages/agent/src/core/ports/alarm.ts",
    },
  ]);
  expect(checkJournalWriters(root)).toBe(1);
});

test("an append literal with an undeclared kind is not a recognized journal row", () => {
  const root = fixture({
    "packages/protocol/src/journal/core/alarm.ts": ALARM_DECLARATION,
    "packages/agent/src/core/ports/alarm.ts": OWNER_WRITER,
    // Only declared kinds are journal rows; a foreign "notice" literal is the
    // append CHECK's problem (sqlite-l0-write refuses unknown kinds), not a
    // writer-census finding.
    "packages/agent/src/core/rogue.ts":
      'export const planted = { id: "n", parentId: null, sessionId: "s", kind: "notice", ts: 5, irreversible: true };\n',
  });

  expect(journalWriterFindings(root)).toEqual([]);
  expect(checkJournalWriters(root)).toBe(0);
});

test("a declaration without a backticked writer module is refused", () => {
  const root = fixture({
    "packages/protocol/src/journal/core/alarm.ts":
      'export const alarm = declare(\n  "alarm",\n  schema,\n);\n',
  });

  expect(() => journalWriterDeclarations(root)).toThrow(
    "journal declaration packages/protocol/src/journal/core/alarm.ts lacks a kind or a backticked writer module",
  );
});

test("the CLI shell refuses a missing or nonexistent root", () => {
  expect(checkJournalWriters(undefined)).toBe(1);
  expect(checkJournalWriters(join(tmpdir(), "journal-writers-missing-root"))).toBe(1);
});

test("intent payload literals without an append shape never count as writers", () => {
  const root = fixture({
    "packages/protocol/src/journal/core/alarm.ts": ALARM_DECLARATION,
    "packages/agent/src/core/ports/alarm.ts": OWNER_WRITER,
    // An alarm prompt origin's shape: a nested payload value carries
    // `kind: "alarm"` but no `irreversible`/`parentId` sibling — not an append row.
    "apps/oni/src/monitor.ts":
      'export const intent = { value: { kind: "alarm", alarmId: "w", occurrenceId: "w:1" } };\n',
  });

  expect(run(root)).toEqual({
    code: 0,
    stdout: "OK: journal kinds with a single declared writer: 1\n",
    stderr: "",
  });
});

test("a directory writer owns every module under it; test files are ignored", () => {
  const root = fixture({
    "packages/protocol/src/journal/capability/compaction.ts":
      '/** Single writer: the compaction capability (`packages/agent/src/plugins/compaction/`). */\nexport const compaction = declare(\n  "compaction",\n  schema,\n);\n',
    "packages/agent/src/plugins/compaction/execute.ts":
      'export const row = { id: "c", parentId: "p", sessionId: "s", kind: "compaction", ts: 3, irreversible: true };\n',
    "packages/agent/src/other.test.ts":
      'export const planted = { id: "t", parentId: null, sessionId: "s", kind: "compaction", ts: 4, irreversible: true };\n',
  });

  expect(run(root)).toEqual({
    code: 0,
    stdout: "OK: journal kinds with a single declared writer: 1\n",
    stderr: "",
  });
});

test("the real tree has 12 declared writers and zero violations", () => {
  const declarations = journalWriterDeclarations(ROOT);
  expect(declarations).toHaveLength(12);
  expect(declarations.map((entry) => entry.kind).sort()).toEqual([
    "action",
    "alarm",
    "compaction",
    "llm",
    "message",
    "policy.decision",
    "prompt",
    "request",
    "session.configure",
    "signal",
    "turn",
  ].concat(["tool"]).sort());
  expect(journalWriterFindings(ROOT)).toEqual([]);
  expect(checkJournalWriters(ROOT)).toBe(0);
});
