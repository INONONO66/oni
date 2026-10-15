import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const CHANNEL_ROOT = fileURLToPath(new URL("../src", import.meta.url));
// zod is pure schema validation — no I/O, no authority — and providers declare
// their credential/settings schemas in-band (docs/provisioning-and-providers.md §4).
const DRIVER_ALLOWED_PACKAGES = new Set(["@openomni/protocol", "zod", "effect"]);
const JUDGMENT_ALLOWED_PACKAGES = new Set(["@openomni/agent"]);
const JUDGMENT_DIRS = ["src/router/", "src/authn/", "src/store/"] as const;
// #1317: the channel-facing persistence band owns its SQLite adapters, so the
// runtime's built-in driver is legal there — and only there.
const SQLITE_BAND_DIR = "src/store/sqlite/";

type ScannedSource = Readonly<{ path: string; text: string }>;

function channelSources(): readonly ScannedSource[] {
  return readdirSync(CHANNEL_ROOT, { recursive: true })
    .map(String)
    .filter((entry) => entry.endsWith(".ts"))
    .map((entry) => ({
      path: join("src", entry),
      text: ts.sys.readFile(join(CHANNEL_ROOT, entry)) ?? "",
    }));
}

function collectModuleSpecifiers(source: ts.SourceFile): readonly string[] {
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      specifiers.push(node.moduleReference.expression.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = node.arguments[0];
      specifiers.push(
        argument !== undefined && ts.isStringLiteralLike(argument)
          ? argument.text
          : "<non-literal dynamic import>",
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers;
}

function packageName(specifier: string): string {
  if (!specifier.startsWith("@")) return specifier.split("/", 1)[0] ?? specifier;
  return specifier.split("/", 2).join("/");
}

function isAllowed(specifier: string, path: string): boolean {
  if (specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("node:")) {
    return true;
  }
  if (specifier === "bun:sqlite" && path.startsWith(SQLITE_BAND_DIR)) return true;
  if (specifier === "@json-render/image/render" && path === "src/support/render-image.ts")
    return true;
  const dependency = packageName(specifier);
  if (DRIVER_ALLOWED_PACKAGES.has(dependency)) return true;
  return (
    JUDGMENT_DIRS.some((directory) => path.startsWith(directory)) &&
    JUDGMENT_ALLOWED_PACKAGES.has(dependency)
  );
}

function detectBandViolations(sources: readonly ScannedSource[]): readonly string[] {
  const violations: string[] = [];
  for (const { path, text } of sources) {
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    for (const specifier of collectModuleSpecifiers(source)) {
      if (!isAllowed(specifier, path)) violations.push(`${path}: imports ${specifier}`);
    }
  }
  return violations;
}

describe("channels band import boundary", () => {
  test("keeps the real source tree on its package allowlist", () => {
    expect(detectBandViolations(channelSources())).toEqual([]);
  });

  test("rejects arbitrary external packages", () => {
    expect(
      detectBandViolations([{ path: "src/websocket.ts", text: 'import ky from "ky";' }]),
    ).toEqual(["src/websocket.ts: imports ky"]);
  });

  test("confines the image renderer dependency to the rasterizer", () => {
    expect(detectBandViolations([
      { path: "src/provider/slack/render.ts", text: 'import { renderToPng } from "@json-render/image/render";' },
    ])).toEqual(["src/provider/slack/render.ts: imports @json-render/image/render"]);
  });

  test("rejects non-literal dynamic imports", () => {
    expect(
      detectBandViolations([
        { path: "src/websocket.ts", text: "const loaded = await import(moduleName);" },
      ]),
    ).toEqual(["src/websocket.ts: imports <non-literal dynamic import>"]);
  });

  test("rejects bun:sqlite outside the sqlite store band", () => {
    expect(
      detectBandViolations([
        { path: "src/websocket.ts", text: 'import { Database } from "bun:sqlite";' },
      ]),
    ).toEqual(["src/websocket.ts: imports bun:sqlite"]);
  });

  test("rejects import-equals require from a driver", () => {
    expect(
      detectBandViolations([
        {
          path: "src/websocket.ts",
          text: 'import Ledger = require("@openomni/agent");',
        },
      ]),
    ).toEqual(["src/websocket.ts: imports @openomni/agent"]);
  });
});
