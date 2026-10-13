import { afterEach, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { TOPOLOGY } from "./topology";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function put(root: string, path: string, source: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), source);
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "openomni-gates-"));
  roots.push(root);
  put(root, "package.json", JSON.stringify({ workspaces: ["packages/*", "apps/*"] }));
  mkdirSync(join(root, "script"));
  symlinkSync(join(import.meta.dir, "../node_modules"), join(root, "node_modules"));
  for (const name of [
    "topology.ts",
    "check-deps.ts",
    "check-import-cycles.ts",
    "lint-side-effects.ts",
    "lint-tools.test.ts",
    "main-runner.ts",
    "command-output.ts",
    "quality-json.ts",
    "capture-output.test-helper.ts",
  ]) {
    copyFileSync(join(import.meta.dir, name), join(root, "script", name));
  }
  for (const name of ["lint-tools.ts", "check-dead-exports.ts"]) {
    symlinkSync(join(import.meta.dir, name), join(root, "script", name));
  }
  for (const workspace of TOPOLOGY) {
    put(
      root,
      `${workspace.dir}/package.json`,
      JSON.stringify({ name: workspace.packageName, main: "src/index.ts" }),
    );
    put(root, `${workspace.dir}/src/index.ts`, "export {};\n");
  }
  // The copied gates import ../packages/protocol/src/json.js; mirror the real
  // module and its one relative import (the NamedError factory behind
  // CanonicalJsonError) so the fixture resolves it exactly like the repository does.
  for (const name of ["json.ts", "error/index.ts"]) {
    const target = join(root, "packages/protocol/src", name);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(import.meta.dir, "../packages/protocol/src", name), target);
  }
  return root;
}

function run(root: string, args: string[], cwd = root) {
  const result = Bun.spawnSync([process.execPath, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 15_000,
  });
  return { code: result.exitCode, output: result.stdout.toString() + result.stderr.toString() };
}

for (const extension of ["ts", "tsx"]) {
  for (const [name, path, source] of [
    ["direction", "packages/ui/src/view", 'import "@openomni/protocol";'],
    ["deep package", "apps/openomni/src/view", 'import "@openomni/protocol/src/index";'],
    ["deep relative", "apps/openomni/src/view", 'import { x } from "../../../other";'],
    ["driver band", "packages/channels/src/view", 'import "@openomni/agent";'],
    ["golden principle", "apps/openomni/src/view", "try { work(); } catch {}"],
  ]) {
    test(`dependency CLI discovers ${name} in ${extension}`, () => {
      const root = fixture();
      const file = `${path}.${extension}`;
      put(root, file, source ?? "");
      const result = run(root, ["script/check-deps.ts"]);
      expect(result.code).toBe(1);
      expect(result.output).toContain(file);
    });
  }
}

test("dependency CLI permits allowed TSX imports and excludes test sources", () => {
  const root = fixture();
  put(root, "apps/openomni/src/view.tsx", 'import "@openomni/protocol";');
  put(root, "packages/ui/src/view.test.tsx", 'import "@openomni/protocol";');
  put(root, "packages/ui/src/__tests__/view.tsx", 'import "@openomni/protocol";');
  expect(run(root, ["script/check-deps.ts"]).code).toBe(0);
});

for (const specifier of ["./panel", "./panel/index.tsx"]) {
  test(`cycle CLI discovers directory edge ${specifier}`, () => {
    const root = fixture();
    put(
      root,
      "packages/ui/src/entry.ts",
      `import { panel } from "${specifier}"; export const entry = panel;`,
    );
    put(
      root,
      "packages/ui/src/panel/index.tsx",
      'import { entry } from "../entry"; export const panel = entry;',
    );
    const result = run(root, ["script/check-import-cycles.ts"]);
    expect(result.code).toBe(1);
    expect(result.output).toContain("CYCLE:");
    expect(result.output).toContain("packages/ui/src/panel/index.tsx");
  });
}

test("cycle CLI preserves external, asset, lazy and type-only edge exclusions", () => {
  const root = fixture();
  put(
    root,
    "packages/ui/src/entry.ts",
    'import type { Panel } from "./panel"; import "react"; import "./style.css"; import("./panel"); export const entry = 1;',
  );
  put(
    root,
    "packages/ui/src/panel/index.tsx",
    'import { entry } from "../entry"; export type Panel = typeof entry;',
  );
  expect(run(root, ["script/check-import-cycles.ts"]).code).toBe(0);
});

for (const cwd of [".", "script"]) {
  for (const planted of [false, true]) {
    test(`deleted-symbol census discovers production from ${cwd}, planted=${planted}`, () => {
      const root = fixture();
      put(
        root,
        "apps/openomni/src/planted.tsx",
        planted ? "export const TranscriptStore = 1;" : "export const live = 1;",
      );
      put(root, "packages/ui/src/ignored.spec.tsx", "export const TranscriptStore = 1;");
      const result = run(
        root,
        [
          "test",
          join(root, "script/lint-tools.test.ts"),
          "--test-name-pattern",
          "deleted production symbols stay absent",
        ],
        join(root, cwd),
      );
      expect(result.code).toBe(planted ? 1 : 0);
      if (planted) expect(result.output).toContain("TranscriptStore apps/openomni/src/planted.tsx");
    });
  }
}

test("deleted-symbol census rejects an empty production root", () => {
  const root = fixture();
  rmSync(join(root, "apps"), { recursive: true });
  const result = run(root, [
    "test",
    "script/lint-tools.test.ts",
    "--test-name-pattern",
    "deleted production symbols stay absent",
  ]);
  expect(result.code).toBe(1);
});

for (const projected of [false, true]) {
  test(`side-effect CLI associates the emitting binding, projected=${projected}`, () => {
    const root = fixture();
    const bind =
      "const sink = createProjectedSink(events, configuredSink, sessionID, trace.traceId);";
    put(
      root,
      "packages/llm/src/processor/index.ts",
      projected
        ? `function emit() { ${bind} sink.onMessage(message); }`
        : `function unrelated() { ${bind} } function emit(sink) { sink.onMessage(message); }`,
    );
    expect(run(root, ["script/lint-side-effects.ts"]).code).toBe(projected ? 0 : 1);
  });
}
