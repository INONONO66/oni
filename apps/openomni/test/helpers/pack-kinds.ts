import { readdirSync } from "node:fs";
import { join } from "node:path";
import { loadToolPacks } from "../../src/bundles/tools/tool-packs/index";
import { readOwnerPolicy } from "../../src/composition/policy";
import { AppInvariantError } from "../../src/invariant";

export interface PackKind {
  readonly kind: string;
  readonly fixturesRoot: string;
  readonly load: (path: string) => readonly object[];
  readonly codes: ReadonlySet<string>;
  readonly valid: readonly string[];
  readonly invalid: readonly { readonly name: string; readonly code: string }[];
  readonly fixturePath: (path: string) => string;
}

const refuse = (message: string, code: string): never => {
  throw new AppInvariantError(message, code);
};

const root = join(import.meta.dir, "../fixtures/packs");
/** Fixture case directories under `path`, sorted so test order never depends on the filesystem. */
export const cases = (path: string): readonly string[] =>
  readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
/** Invalid cases carry their expected refusal code as the `<code>--<case>` directory prefix. */
export const refusals = (path: string): readonly { readonly name: string; readonly code: string }[] =>
  cases(path).map((name) => ({ name, code: name.split("--")[0] ?? "" }));

export const packKinds: readonly PackKind[] = [
  {
    kind: "tool",
    fixturesRoot: join(root, "tool"),
    load: (path) => loadToolPacks(path, new Set(["self"]), () => undefined, refuse).map((pack) => ({
      name: pack.name,
      tools: pack.tools.map((tool) => ({ name: tool.name, description: tool.description })),
    })),
    codes: new Set(["invalid_tool_pack", "unknown_machine", "tool_name_collision"]),
    valid: cases(join(root, "tool/valid")),
    invalid: refusals(join(root, "tool/invalid")),
    fixturePath: (path) => path,
  },
  {
    kind: "policy",
    fixturesRoot: join(root, "policy"),
    load: (path) => {
      const policy = readOwnerPolicy(path);
      return [...policy.rows, ...policy.delegationRows];
    },
    codes: new Set(["unreadable_path", "invalid_policy_file", "unknown_point", "unknown_handler"]),
    valid: cases(join(root, "policy/valid")),
    invalid: refusals(join(root, "policy/invalid")),
    fixturePath: (path) => join(path, "policy.json"),
  },
];
