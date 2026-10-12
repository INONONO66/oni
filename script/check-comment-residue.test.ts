/**
 * #1343 comment-residue gate: discriminating fixtures. Every case builds a
 * scratch agent tree plus its own pin table, so a new hit, a stale pin, an
 * unpinned file, JSDoc growth, and ratio growth each fail with the typed
 * message, while the exact structural-header exemption stays narrow.
 */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkCommentResidue,
  classifyResidue,
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
    structuralHeaders: [],
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

test("#1343: comment-ratio growth fails; a stale ceiling also fails", async () => {
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
    const stale = await checkCommentResidue(
      root,
      pinsOf({ "core/a.ts": [0, 0] }, { ratioBasisPoints: 5_001 }),
    );
    expect(stale).toEqual([
      "VIOLATION [comment-residue] comment-ratio ceiling exceeds actual (5001bp > 5000bp): lower the ceiling",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── structural-header exemption: exact marker only, issue residue still counts ───

test("#1343: an exact exempted marker skips the divider count; a neighboring marker and its issue token still count", async () => {
  const root = scratchTree({
    "inspect/index.ts": [
      "// ─── #1305: stored tool output read-back ───",
      "// ─── neighboring marker ───",
      "export const i = 1;",
    ].join("\n"),
  });
  try {
    const violations = await checkCommentResidue(
      root,
      pinsOf(
        { "inspect/index.ts": [0, 1] },
        {
          ratioBasisPoints: 6_666,
          structuralHeaders: [
            {
              file: "packages/agent/src/inspect/index.ts",
              marker: "// ─── #1305: stored tool output read-back ───",
            },
          ],
        },
      ),
    );
    // The exempted line's #1305 token still counts: pin [0, 1] fails on issues.
    expect(violations).toEqual([
      "VIOLATION [comment-residue] packages/agent/src/inspect/index.ts: issue-number comment lines 1 > pin 0 — shrink only, never grow",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── the shipped baseline: real pins pass on the real tree ───

test("#1343: the pinned baseline passes and stays within the documented exemption budget", async () => {
  expect(await checkCommentResidue()).toEqual([]);
  expect(RESIDUE_PINS.structuralHeaders.length).toBeLessThanOrEqual(10);
});
