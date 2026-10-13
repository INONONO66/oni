/**
 * Comment-residue gate: discriminating fixtures. Every case builds a scratch
 * agent tree plus its own pin table, so a new hit, a stale pin, an unpinned
 * file, JSDoc growth, ratio growth, and a stale or over-budget allow-list each
 * fail with the typed message, while the exact listed note stays exempt.
 */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkCommentResidue,
  classifyResidue,
  main,
  RESIDUE_PINS,
  type ResiduePins,
} from "./check-comment-residue";

function scratchTree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "residue-"));
  for (const [file, source] of Object.entries(files)) {
    const path = join(root, "packages/agent/src", file);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, source);
  }
  return root;
}

function pinsOf(
  files: Record<string, readonly [number, number]>,
  overrides: Partial<Omit<ResiduePins, "files">> = {},
): ResiduePins {
  return {
    files: new Map(Object.entries(files).map(([k, v]) => [`packages/agent/src/${k}`, v])),
    ratioBasisPoints: 10_000,
    jsdocOverSix: 0,
    durableByteNotes: [],
    ...overrides,
  };
}

// ─── classifier: comment-only lines, not code or strings ───

test("#1343 classifier: trailing comments and issue tokens in strings are code, not residue", () => {
  const residue = classifyResidue(
    ["const x = 1; // #1234 trailing comment is code", 'const y = "#1234 in a string";'].join("\n"),
  );
  expect(residue.issueLines).toBe(0);
  expect(residue.commentLines).toBe(0);
  expect(residue.nonblankLines).toBe(2);
});

test("#1343 classifier: comment-only issue lines, dividers, and JSDoc >6 lines are counted", () => {
  const residue = classifyResidue(
    [
      "// #1234 residue",
      "// ─── divider ───",
      "/**",
      " * one",
      " * two",
      " * three",
      " * four",
      " * five",
      " */",
      "export const a = 1;",
    ].join("\n"),
  );
  expect(residue.issueLines).toBe(1);
  expect(residue.dividerLines).toBe(1);
  expect(residue.jsdocOverSix).toBe(1);
  expect(residue.commentLines).toBe(9);
});

test("#1349 classifier: a divider inside a block comment or JSDoc is still a divider; a trailing one after code is not", () => {
  const residue = classifyResidue(
    [
      "/*",
      " ─── bare run in a block ───",
      " */",
      "/**",
      " * ─── section ───",
      " * prose",
      " */",
      "/* ─── one-line block ─── */",
      "// ── two glyphs are prose, not a divider",
      "export const a = 1; /* ─── trailing after code ─── */",
    ].join("\n"),
  );
  expect(residue.dividerLines).toBe(3);
  expect(residue.commentLines).toBe(9);
  expect(residue.nonblankLines).toBe(10);
});

test("#1343 classifier: a block opened after code counts its continuation lines; template text is code", () => {
  const residue = classifyResidue(
    [
      "const x = 1; /* opener after code",
      " #1234 inside the block is a comment line",
      " */ const y = 2;",
      "const t = `",
      "// #5678 template text, not a comment",
      "`;",
    ].join("\n"),
  );
  expect(residue.commentLines).toBe(1);
  expect(residue.issueLines).toBe(1);
  expect(residue.dividerLines).toBe(0);
  expect(residue.nonblankLines).toBe(6);
});

// ─── growth, slack, unpinned, stale ───

test("#1343: a new issue-number hit above the pin fails shrink-only", async () => {
  const root = scratchTree({ "core/a.ts": "// #1234 old\n// #5678 new\nexport const a = 1;\n" });
  try {
    const violations = await checkCommentResidue(root, pinsOf({ "core/a.ts": [1, 0] }, { ratioBasisPoints: 6_666 }));
    expect(violations).toEqual([
      "VIOLATION [comment-residue] packages/agent/src/core/a.ts: issue-number comment lines 2 > pin 1 — shrink only, never grow",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1343: a removed hit without lowering the pin fails closed (slack)", async () => {
  const root = scratchTree({ "core/a.ts": "export const a = 1;\n" });
  try {
    const violations = await checkCommentResidue(root, pinsOf({ "core/a.ts": [1, 0] }, { ratioBasisPoints: 0 }));
    expect(violations).toEqual([
      "VIOLATION [comment-residue] packages/agent/src/core/a.ts: pin exceeds actual issue-number comment lines (1 > 0): lower the pin",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1343: moving a divider between files fails both files, not the package total", async () => {
  const root = scratchTree({
    "core/a.ts": "export const a = 1;\n",
    "core/b.ts": "// ─── moved here ───\nexport const b = 1;\n",
  });
  try {
    const violations = await checkCommentResidue(
      root,
      pinsOf({ "core/a.ts": [0, 1], "core/b.ts": [0, 0] }, { ratioBasisPoints: 3_333 }),
    );
    expect(violations).toEqual([
      "VIOLATION [comment-residue] packages/agent/src/core/a.ts: pin exceeds actual divider lines (1 > 0): lower the pin",
      "VIOLATION [comment-residue] packages/agent/src/core/b.ts: divider lines 1 > pin 0 — shrink only, never grow",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1343: an unpinned new file with residue fails closed; a pinned absent file is stale", async () => {
  const root = scratchTree({ "core/new.ts": "// #1234 residue\nexport const n = 1;\n" });
  try {
    const violations = await checkCommentResidue(root, pinsOf({ "core/gone.ts": [0, 0] }, { ratioBasisPoints: 5_000 }));
    expect(violations).toEqual([
      "VIOLATION [comment-residue] packages/agent/src/core/new.ts is not pinned (issue lines 1, dividers 0): add explicit pins",
      "VIOLATION [comment-residue] packages/agent/src/core/gone.ts is pinned but absent: remove the stale pin",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── ceilings: JSDoc growth and ratio growth ───

test("#1343: extending a JSDoc past the ceiling fails even with unchanged issue counts", async () => {
  const jsdoc = ["/**", ...Array.from({ length: 6 }, (_, i) => ` * line ${i}`), " */"].join("\n");
  const root = scratchTree({ "core/a.ts": `${jsdoc}\nexport const a = 1;\n` });
  try {
    const violations = await checkCommentResidue(
      root,
      pinsOf({ "core/a.ts": [0, 0] }, { ratioBasisPoints: 8_888 }),
    );
    expect(violations).toEqual([
      "VIOLATION [comment-residue] JSDoc blocks over six lines 1 > ceiling 0 — shrink only, never grow",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1343: comment-ratio growth fails; added plain code lowers the ratio and passes (ceiling, not pin)", async () => {
  // 1 comment line / 2 nonblank lines = 5000bp.
  const root = scratchTree({ "core/a.ts": "// prose comment\nexport const a = 1;\n" });
  try {
    const grown = await checkCommentResidue(
      root,
      pinsOf({ "core/a.ts": [0, 0] }, { ratioBasisPoints: 4_999 }),
    );
    expect(grown).toEqual([
      "VIOLATION [comment-residue] package comment ratio 5000bp > ceiling 4999bp — shrink only, never grow",
    ]);
    // Slack under the ceiling is legal: an agent feature PR adds code freely.
    expect(
      await checkCommentResidue(root, pinsOf({ "core/a.ts": [0, 0] }, { ratioBasisPoints: 5_001 })),
    ).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1343: adding plain code lines to a pinned tree passes under an unchanged ratio ceiling", async () => {
  // Baseline 1/2 = 5000bp pinned as the ceiling; three added code lines drop
  // the ratio to 1/5 = 2000bp and the gate stays green.
  const root = scratchTree({
    "core/a.ts":
      "// prose comment\nexport const a = 1;\nexport const b = 2;\nexport const c = 3;\nexport const d = 4;\n",
  });
  try {
    expect(
      await checkCommentResidue(root, pinsOf({ "core/a.ts": [0, 0] }, { ratioBasisPoints: 5_000 })),
    ).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1343: the JSDoc>6 count is a tight pin — a ceiling above the actual fails closed", async () => {
  const jsdoc = ["/**", ...Array.from({ length: 6 }, (_, i) => ` * line ${i}`), " */"].join("\n");
  const root = scratchTree({ "core/a.ts": `${jsdoc}\nexport const a = 1;\n` });
  try {
    const stale = await checkCommentResidue(
      root,
      pinsOf({ "core/a.ts": [0, 0] }, { ratioBasisPoints: 8_889, jsdocOverSix: 2 }),
    );
    expect(stale).toEqual([
      "VIOLATION [comment-residue] JSDoc ceiling exceeds actual (2 > 1): lower the ceiling",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── durable-byte allow-list: exact line only, budget and staleness enforced ───

const BYTE_NOTE = "// #1305: pre-rename session files persist the retired role byte.";

test("#1349: a listed durable-byte note is excluded from the issue count; an unlisted neighbor still fails", async () => {
  const root = scratchTree({
    "core/store/catalog.ts": [BYTE_NOTE, "// #1234 unlisted provenance", "export const c = 1;"].join("\n"),
  });
  const note = {
    file: "packages/agent/src/core/store/catalog.ts",
    marker: BYTE_NOTE,
    reason: "the role byte is persisted; the number names the migration that froze it",
  };
  try {
    const violations = await checkCommentResidue(
      root,
      pinsOf({ "core/store/catalog.ts": [0, 0] }, { ratioBasisPoints: 6_666, durableByteNotes: [note] }),
    );
    expect(violations).toEqual([
      "VIOLATION [comment-residue] packages/agent/src/core/store/catalog.ts: issue-number comment lines 1 > pin 0 — shrink only, never grow",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1349: the exact allow-list passes with zero pins; a pattern-shaped near miss does not qualify", async () => {
  const root = scratchTree({
    "core/store/catalog.ts": [BYTE_NOTE, "export const c = 1;"].join("\n"),
  });
  const note = {
    file: "packages/agent/src/core/store/catalog.ts",
    marker: BYTE_NOTE,
    reason: "the role byte is persisted; the number names the migration that froze it",
  };
  try {
    expect(
      await checkCommentResidue(
        root,
        pinsOf({ "core/store/catalog.ts": [0, 0] }, { ratioBasisPoints: 5_000, durableByteNotes: [note] }),
      ),
    ).toEqual([]);
    const nearMiss = { ...note, marker: "// #1305: pre-rename session files persist the retired role byte" };
    expect(
      await checkCommentResidue(
        root,
        pinsOf({ "core/store/catalog.ts": [0, 0] }, { ratioBasisPoints: 5_000, durableByteNotes: [nearMiss] }),
      ),
    ).toEqual([
      "VIOLATION [comment-residue] packages/agent/src/core/store/catalog.ts: issue-number comment lines 1 > pin 0 — shrink only, never grow",
      'VIOLATION [comment-residue] packages/agent/src/core/store/catalog.ts: listed durable-byte note "// #1305: pre-rename session files persist the retired role byte" is absent: retire the entry',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1349: a listed note whose line was deleted is stale and fails closed", async () => {
  const root = scratchTree({ "core/store/catalog.ts": "export const c = 1;\n" });
  try {
    const violations = await checkCommentResidue(
      root,
      pinsOf(
        { "core/store/catalog.ts": [0, 0] },
        {
          ratioBasisPoints: 0,
          durableByteNotes: [
            { file: "packages/agent/src/core/store/catalog.ts", marker: BYTE_NOTE, reason: "gone" },
          ],
        },
      ),
    );
    expect(violations).toEqual([
      `VIOLATION [comment-residue] packages/agent/src/core/store/catalog.ts: listed durable-byte note ${JSON.stringify(BYTE_NOTE)} is absent: retire the entry`,
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1349: an over-budget durable-byte allow-list is itself a violation", async () => {
  const root = scratchTree({ "core/a.ts": "export const a = 1;\n" });
  const notes = Array.from({ length: 11 }, (_, i) => ({
    file: "packages/agent/src/core/a.ts",
    marker: `// #${1000 + i} byte note ${i}`,
    reason: `note ${i}`,
  }));
  try {
    const violations = await checkCommentResidue(
      root,
      pinsOf({ "core/a.ts": [0, 0] }, { durableByteNotes: notes }),
    );
    expect(violations[0]).toBe(
      "VIOLATION [comment-residue] durable-byte notes 11 > budget 10: retire notes instead of adding them",
    );
    expect(violations).toHaveLength(12);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1349: one file growing an issue comment fails its per-file pin while the package ratio stays under 8%", async () => {
  const code = Array.from({ length: 19 }, (_, i) => `export const v${i} = ${i};`);
  // 1 comment line / 20 nonblank lines = 500bp, under the 800bp rule.
  const root = scratchTree({ "core/a.ts": ["// #1234 grew here", ...code].join("\n") });
  try {
    const violations = await checkCommentResidue(
      root,
      pinsOf({ "core/a.ts": [0, 0] }, { ratioBasisPoints: 800 }),
    );
    expect(violations).toEqual([
      "VIOLATION [comment-residue] packages/agent/src/core/a.ts: issue-number comment lines 1 > pin 0 — shrink only, never grow",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── main: --measure, OK, and violation branches, in process ───

function captureIo(): { out: string[]; err: string[]; io: { stdout: (t: string) => void; stderr: (t: string) => void } } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { stdout: (t) => out.push(t), stderr: (t) => err.push(t) } };
}

test("#1343 main --measure: prints the pin table and the ceiling line for the given root", async () => {
  const root = scratchTree({ "core/a.ts": "// #1234 residue\nexport const a = 1;\n" });
  const { out, err, io } = captureIo();
  try {
    await main(["--measure"], root, io);
    expect(err).toEqual([]);
    expect(out.join("")).toBe(
      '  ["packages/agent/src/core/a.ts", [1, 0]],\n// ratioBasisPoints: 5000 (1/2), jsdocOverSix: 0\n',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1343 main: violations print to stderr and set the exit code", async () => {
  const root = scratchTree({ "core/unpinned.ts": "// #1234 residue\nexport const a = 1;\n" });
  const { out, err, io } = captureIo();
  const previousExitCode = process.exitCode;
  try {
    await main([], root, io);
    expect(process.exitCode).toBe(1);
    expect(out).toEqual([]);
    expect(err.join("")).toContain(
      "VIOLATION [comment-residue] packages/agent/src/core/unpinned.ts is not pinned",
    );
  } finally {
    // Bun keeps a code assigned `undefined`, so restore 0 or the runner exits 1.
    process.exitCode = previousExitCode ?? 0;
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1343 main: the pinned baseline passes through the OK branch", async () => {
  const { out, err, io } = captureIo();
  const previousExitCode = process.exitCode;
  try {
    await main([], join(import.meta.dir, ".."), io);
    expect(process.exitCode).toBe(previousExitCode);
    expect(err).toEqual([]);
    expect(out.join("")).toBe(
      `OK: comment residue pinned — ${RESIDUE_PINS.files.size} files, ratio ceiling ${RESIDUE_PINS.ratioBasisPoints}bp (growth-only), JSDoc>6 pin ${RESIDUE_PINS.jsdocOverSix} (tight), durable-byte notes ${RESIDUE_PINS.durableByteNotes.length}/10\n`,
    );
  } finally {
    process.exitCode = previousExitCode ?? 0;
  }
});
