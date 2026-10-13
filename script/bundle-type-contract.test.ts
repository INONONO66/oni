import { expect, test } from "bun:test";
import { resolve } from "node:path";
import ts from "typescript";

// #1255: a bundle's acquisition Layer is typed at define time —
// `Layer<never, SessionError, BundleLayerServices>` — so a Layer that reads a
// service outside the generation seed or fails outside
// the typed session errors is refused by the compiler, not discovered at
// acquisition. Kinds, points and steps are capability-owned and never typed
// onto a bundle.
const root = resolve(import.meta.dir, "..");
const header = `import { Context, Effect, Layer } from "effect";
import { defineBundle, seam } from "../packages/agent/src/core/ports/capability";
import { AgentFailure, type SessionError } from "../packages/agent/src/core/ports/failure";
import { Entropy, ObservationSink, type BundleLayerServices } from "../packages/agent/src/core/ports/ports";
class External extends Context.Service<External, boolean>()("@openomni/test/External") {}
const Alarm = seam("@openomni/agent/capability/alarm");
const seeded = Layer.effectDiscard(Effect.gen(function* () { yield* Entropy; yield* ObservationSink; }));
const failing = Layer.effectDiscard(Effect.fail(new AgentFailure({ operation: "fixture", cause: "typed" })));
`;
const positive = `${header}
const probe = defineBundle({ name: "probe", requires: [Alarm], layer: seeded });
const typed = defineBundle({ name: "typed", requires: [], layer: failing });
const bare = defineBundle({ name: "bare", requires: [] });
type Equal<A,B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const name: Equal<typeof probe.name, "probe"> = true;
const layer: Equal<typeof probe.layer, Layer.Layer<never, SessionError, BundleLayerServices> | undefined> = true;
const contract: Equal<typeof typed.contract, "bundle"> = true;
const requires: Equal<typeof bare.requires, readonly { readonly key: string }[]> = true;
const key: Equal<typeof Alarm.key, string> = true;
`;
const negatives = [
  ["external service", `defineBundle({ name: "x", requires: [], layer: Layer.effectDiscard(Effect.asVoid(External)) });`, 2322],
  ["foreign error", `defineBundle({ name: "x", requires: [], layer: Layer.effectDiscard(Effect.fail("boom" as const)) });`, 2322],
  ["capability-owned kinds", `defineBundle({ name: "x", requires: [], kinds: {} });`, 2322],
  ["capability-owned points", `defineBundle({ name: "x", requires: [], points: [] });`, 2322],
  ["forged seam", `defineBundle({ name: "x", requires: [{ name: "alarm" }] });`, 2353],
] as const;

test("bundle contract types the acquisition layer and refuses capability-owned declarations", () => {
  const fixtures = new Map<string, string>([[resolve(root, "script/bundle-positive.fixture.ts"), positive], ...negatives.map(([name, code]) => [resolve(root, `script/bundle-${name.replaceAll(" ", "-")}.fixture.ts`), `${header}${code}`] as const)]);
  const options: ts.CompilerOptions = { strict: true, noUncheckedIndexedAccess: true, noEmit: true, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, skipLibCheck: true, types: [] };
  const host = ts.createCompilerHost(options);
  const read = host.readFile.bind(host);
  const exists = host.fileExists.bind(host);
  host.readFile = (file) => fixtures.get(file) ?? read(file);
  host.fileExists = (file) => fixtures.has(file) || exists(file);
  const program = ts.createProgram([...fixtures.keys()], options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  const owned = diagnostics.filter((item) => item.file?.fileName === resolve(root, "packages/agent/src/core/capability.ts") || item.file?.fileName.endsWith("bundle-positive.fixture.ts"));
  expect(owned.map((item) => ts.flattenDiagnosticMessageText(item.messageText, "\n"))).toEqual([]);
  for (const [name, , code] of negatives) {
    const path = resolve(root, `script/bundle-${name.replaceAll(" ", "-")}.fixture.ts`);
    const failures = diagnostics.filter((item) => item.file?.fileName === path);
    expect(failures.map((item) => item.code), name).toEqual([code]);
    expect(failures.every((item) => item.start !== undefined && item.start >= header.length), name).toBe(true);
  }
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(resolve(root, "script/bundle-positive.fixture.ts"));
  if (!source) throw new Error("compiler fixture missing");
  const tops: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) || ts.isCallExpression(node)) {
      const type = checker.getTypeAtLocation(ts.isVariableDeclaration(node) ? node.name : node);
      if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) tops.push(node.getText(source));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  expect(tops).toEqual([]);
}, 15000);
