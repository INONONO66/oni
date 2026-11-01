import { expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";
import { SELECTION_SUITE_TIMEOUT_MS, verifyMutantMemoryCap, type TestRuntime, boundedArgv, classifyCandidate, copyExecution, removeExecution, decode, describeRedBaseline, execute, executionTreeHash, instrument, main, mutationSource, probeText, pythonWorker, sha256, type TestSelectionReceipt } from "./run-quality-mutations";
import { mutationFixture, mutationEvidence, replaceArguments, reportResults } from "./quality-mutation-fixture";
import { buildInventory, readContract } from "./quality-inventory";
import { analyze, enumerate, programs, diagnostics, failedAssertions, assertionIdentities } from "./run-quality-mutations";
import { tmpdir } from "node:os";
import { MutationCompilerWorker } from "./quality-mutation-compiler";

if (process.env.D945_PYTHON === undefined) {
	test.skip("D945_PYTHON is unset; mutation runner tests require the pinned Python runtime", () => undefined);
} else {

function captureOutput(): { output: string[]; restore: () => void } {
	const output: string[] = [];
	const log: (value: string) => void = console.log;
	console.log = (value: string) => { output.push(value); };
	return { output, restore: () => { console.log = log; } };
}
function captureError(): { output: string[]; restore: () => void } {
	const output: string[] = [];
	const error: (value: string) => void = console.error;
	console.error = (value: string) => { output.push(value); };
	return { output, restore: () => { console.error = error; } };
}

test("switch case reach instrumentation inserts a probe after the label", () => {
	const source = "switch (value) { case 1: return true; default: return false; }";
	const directory = mkdtempSync(join(tmpdir(), "mutation-case-instrument-"));
	try {
		const start = source.indexOf("case");
		const end = source.indexOf("default");
		const transformed = instrument(source, [{
			id: "case", path: "a.ts", sourceSha256: sha256(source),
			site: { start, end, mode: "case" }, tests: [],
		}], directory);
		expect(transformed).toContain(`case 1:${probeText(join(directory, "case"))};`);
	} finally { rmSync(directory, { recursive: true, force: true }); }
});

test("nested reach instrumentation preserves lazy boolean evaluation", () => {
	const source = "const value = false && (b || c);";
	const directory = mkdtempSync(join(tmpdir(), "mutation-instrument-"));
	try {
		const outer = source.indexOf("false");
		const inner = source.indexOf("b");
		const transformed = instrument(source, [
			{ id: "outer", path: "a.ts", sourceSha256: sha256(source), site: { start: outer, end: source.length - 1, mode: "expression" }, tests: [] },
			{ id: "inner", path: "a.ts", sourceSha256: sha256(source), site: { start: inner, end: source.indexOf(")"), mode: "expression" }, tests: [] },
		], directory);
		expect(transformed).toContain("false &&");
		expect(transformed.match(/writeFileSync/g)?.length).toBe(2);
	} finally { rmSync(directory, { recursive: true, force: true }); }
});

test("statement-entry probes remain outside overlapping expression probes", async () => {
	const source = "let count = 0; count++; console.log(count);";
	const directory = mkdtempSync(join(tmpdir(), "mutation-entry-probe-"));
	try {
		const start = source.indexOf("count++");
		const transformed = instrument(source, [
			{ id: "entry", path: "a.ts", sourceSha256: sha256(source), site: { start, end: start, mode: "statement" }, tests: [] },
			{ id: "value", path: "a.ts", sourceSha256: sha256(source), site: { start, end: start + "count++".length, mode: "expression" }, tests: [] },
		], directory);
		const path = join(directory, "a.ts");
		writeFileSync(path, transformed);
		const result = await execute([process.execPath, path], directory, 5000);
		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe("1");
		expect(readFileSync(join(directory, "entry"), "utf8")).toBe("1");
		expect(readFileSync(join(directory, "value"), "utf8")).toBe("1");
	} finally { rmSync(directory, { recursive: true, force: true }); }
});

/** Instruments `source` into `directory`, runs it, and returns stdout after asserting a clean exit and a probe for `marker`. */
async function runProbed(directory: string, source: string, candidates: Parameters<typeof instrument>[1], marker: string): Promise<string> {
	const transformed = instrument(source, candidates, directory);
	expect(transformed).toContain(probeText(marker));
	const path = join(directory, "a.ts");
	writeFileSync(path, transformed);
	const result = await execute([process.execPath, path], directory, 5000);
	expect(result.stderr).toBe("");
	expect(result.exitCode).toBe(0);
	return result.stdout.trim();
}

test("reach probes write each marker once per process", async () => {
	const directory = mkdtempSync(join(tmpdir(), "mutation-probe-once-"));
	try {
		const marker = join(directory, "site");
		const source = `let total = 0;\nfor (let i = 0; i < 3; i++) { total += i; if (i === 0) require("node:fs").rmSync(${JSON.stringify(marker)}); }\nconsole.log(total);`;
		const start = source.indexOf("i;"), end = start + 1;
		const stdout = await runProbed(directory, source, [
			{ id: "site", path: "a.ts", sourceSha256: sha256(source), site: { start, end, mode: "expression" }, tests: [] },
			{ id: "total", path: "a.ts", sourceSha256: sha256(source), site: { start: source.indexOf("console.log(total)"), end: source.indexOf("console.log(total)"), mode: "statement" }, tests: [] },
			{ id: "loop", path: "a.ts", sourceSha256: sha256(source), site: { start: source.indexOf("for"), end: source.indexOf("\nconsole"), mode: "statement" }, tests: [] },
		], marker);
		expect(stdout).toBe("3");
		expect(existsSync(marker)).toBe(false);
		expect(readFileSync(join(directory, "total"), "utf8")).toBe("1");
		expect(readFileSync(join(directory, "loop"), "utf8")).toBe("1");
	} finally { rmSync(directory, { recursive: true, force: true }); }
});

// A probe inside a scope shadowing `process` called
// ChildProcess.getBuiltinModule and threw under reach instrumentation.
test("reach probes resolve their globals through globalThis inside shadowing scopes", async () => {
	const directory = mkdtempSync(join(tmpdir(), "mutation-probe-shadow-"));
	try {
		const marker = join(directory, "site");
		const source = `function start(process: { pid: number }, Reflect: string): number {\n  return process.pid + Reflect.length;\n}\nconsole.log(start({ pid: 40 }, "ab"));`;
		const start = source.indexOf("process.pid"), end = source.indexOf(";\n}");
		const stdout = await runProbed(directory, source, [
			{ id: "site", path: "a.ts", sourceSha256: sha256(source), site: { start, end, mode: "expression" }, tests: [] },
		], marker);
		expect(stdout).toBe("42");
		expect(readFileSync(marker, "utf8")).toBe("1");
	} finally { rmSync(directory, { recursive: true, force: true }); }
});

// packages/agent/test/store/helpers/disposition-967-archive-fault.ts wraps
// `fs.writeFileSync` on the builtin module object; a probe inside that wrapper
// wrote its marker through the wrapper before claiming the guard and recursed
// until the stack overflowed (run 35468117173).
test("reach probes inside an fs.writeFileSync wrapper do not recurse through their own write", async () => {
	const directory = mkdtempSync(join(tmpdir(), "mutation-probe-fswrap-"));
	try {
		const marker = join(directory, "site");
		const output = join(directory, "out");
		const source = `import fs from "node:fs";
const writeFile = fs.writeFileSync;
Object.defineProperty(fs, "writeFileSync", { value: (...args: Parameters<typeof fs.writeFileSync>) => { writeFile(...args); } });
fs.writeFileSync(${JSON.stringify(output)}, "ok");
console.log("done");`;
		const start = source.indexOf("writeFile(...args)"), end = start + "writeFile(...args)".length;
		const stdout = await runProbed(directory, source, [
			{ id: "site", path: "a.ts", sourceSha256: sha256(source), site: { start, end, mode: "expression" }, tests: [] },
		], marker);
		expect(stdout).toBe("done");
		expect(readFileSync(marker, "utf8")).toBe("1");
		expect(readFileSync(output, "utf8")).toBe("ok");
	} finally { rmSync(directory, { recursive: true, force: true }); }
});

function strictProgram(directory: string, path: string): ts.Program {
	const base = JSON.parse(readFileSync(resolve(import.meta.dir, "../tsconfig.base.json"), "utf8")) as { compilerOptions: Record<string, string | boolean | string[]> };
	// ts.sys memoizes process.cwd() on first use, so a sibling test that chdirs
	// into a fixture would otherwise pin type-root discovery there; anchor the
	// repository's own @types explicitly.
	const typeRoots = [resolve(import.meta.dir, "../node_modules/@types")];
	const parsed = ts.parseJsonConfigFileContent({ compilerOptions: { ...base.compilerOptions, typeRoots, noEmit: true }, files: [path] }, ts.sys, directory);
	return ts.createProgram(parsed.fileNames, parsed.options);
}
function strictDiagnostics(program: ts.Program): string[] {
	return ts.getPreEmitDiagnostics(program).map((entry) => ts.flattenDiagnosticMessageText(entry.messageText, "\n"));
}

test("reach probes type-check under the repository's strict compiler options", () => {
	const directory = mkdtempSync(join(tmpdir(), "mutation-probe-types-"));
	try {
		const source = `export function sum(values: number[]): number {\n\tlet total = 0;\n\tfor (const value of values) total += value;\n\treturn total;\n}\n`;
		const start = source.indexOf("total += value"), end = start + "total += value".length;
		const transformed = instrument(source, [
			{ id: "site", path: "a.ts", sourceSha256: sha256(source), site: { start, end, mode: "expression" }, tests: [] },
			{ id: "entry", path: "a.ts", sourceSha256: sha256(source), site: { start: source.indexOf("let total"), end: source.indexOf("let total"), mode: "statement" }, tests: [] },
		], directory);
		const path = join(directory, "a.ts");
		writeFileSync(path, transformed);
		expect(strictDiagnostics(strictProgram(directory, path))).toEqual([]);
	} finally { rmSync(directory, { recursive: true, force: true }); }
});

// The literal-zero any/unknown DoD applies to compiled kernel source; a reach
// copy of that source must introduce no compiler-inferred any/unknown either.
test("reach probes introduce no compiler-inferred any or unknown", () => {
	const directory = mkdtempSync(join(tmpdir(), "mutation-probe-any-"));
	try {
		const source = "export const value: number = 1 + 1;\n";
		const start = source.indexOf("1 + 1");
		const path = join(directory, "a.ts");
		writeFileSync(path, instrument(source, [
			{ id: "site", path: "a.ts", sourceSha256: sha256(source), site: { start, end: start + "1 + 1".length, mode: "expression" }, tests: [] },
		], directory));
		const program = strictProgram(directory, path);
		const checker = program.getTypeChecker();
		const file = program.getSourceFile(path);
		if (!file) throw new Error("missing instrumented source");
		const loose: string[] = [];
		const visit = (node: ts.Node): void => {
			if (ts.isCallExpression(node) || ts.isVariableDeclaration(node)) {
				const type = checker.getTypeAtLocation(ts.isVariableDeclaration(node) ? node.name : node);
				if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) loose.push(node.getText());
			}
			ts.forEachChild(node, visit);
		};
		visit(file);
		expect(strictDiagnostics(program)).toEqual([]);
		expect(loose).toEqual([]);
	} finally { rmSync(directory, { recursive: true, force: true }); }
});

// `(marker, (a || b))` narrows nothing: the checker only narrows through a
// comma whose right side is itself a narrowing expression, and logical
// operators are split by the binder instead. Sites on logical conditions and
// comparison literals therefore relocate to a narrowing-transparent operand.
test("reach sites on logical conditions and comparison literals preserve narrowing", async () => {
	const source = [
		'export function run(d: { value?: unknown } | undefined, chunk: string | Uint8Array, e: unknown): number {',
		'  if (!d || !("value" in d)) return 0;',
		'  const text = typeof chunk === ("string") ? chunk : chunk.length;',
		'  if (!(e instanceof Error && "code" in e && e.code === "ENOENT")) return 1;',
		'  switch (true) { case typeof text === "number": return text; }',
		'  switch ((false)) { case typeof text === "string": return 4; }',
		'  const tail = d.value ?? "";',
		'  return text ? 2 : String(tail).length;',
		'}',
	].join("\n");
	const input = await fixture(source, 'expect(run({ value: 1 }, "x", Object.assign(new Error("e"), { code: "ENOENT" }))).toBe(2);');
	const contract = readContract(join(input.root, "contract.json"));
	const operators = ["logical", "equality", "string-literal", "boolean-literal"].map((id) => ({
		id,
		replacements: new Map([["||", ["&&"]], ["&&", ["||"]], ["??", ["||"]], ["===", ["!=="]], ["true", ["false"]], ["false", ["true"]]]),
	}));
	const all = analyze(input.root, contract, buildInventory(input.root, contract), operators)
		.enumerated.candidates.filter((candidate) => candidate.path === "src/a.ts");
	const candidates = all.filter((candidate) => candidate.site.mode === "expression");
	const siteText = (text: string, offset = source.indexOf(text)): string[] => candidates
		.filter((candidate) => candidate.startOffset === offset)
		.map((candidate) => source.slice(candidate.site.start, candidate.site.end));
	expect(siteText("||")).toEqual(["d"]);
	expect(siteText("&&")).toEqual(["e instanceof Error"]);
	expect(siteText("&&", source.lastIndexOf("&&"))).toEqual(["e instanceof Error"]);
	expect(siteText('"string"')).toEqual(['typeof chunk === ("string")']);
	expect(siteText('"ENOENT"')).toEqual(['e.code === "ENOENT"']);
	expect(siteText("??")).toEqual(["d.value"]);
	for (const literal of ["true", "false"]) {
		const literalSwitch = all.find((candidate) => candidate.startOffset === source.indexOf(literal));
		expect(literalSwitch?.site.mode).toBe("statement");
		expect(source.slice(literalSwitch?.site.start, literalSwitch?.site.end)).toBe("");
	}
	const directory = mkdtempSync(join(tmpdir(), "mutation-narrowing-probe-"));
	try {
		const path = join(directory, "a.ts");
		writeFileSync(path, instrument(source, candidates.map((candidate, index) => ({
			id: `site-${index}`, path: candidate.path, sourceSha256: candidate.sourceSha256, site: candidate.site, tests: [],
		})), directory));
		expect(strictDiagnostics(strictProgram(directory, path))).toEqual([]);
	} finally { rmSync(directory, { recursive: true, force: true }); }
}, 90000);

test("Python probe worker instruments a site with a marker", async () => {
	const directory = mkdtempSync(join(tmpdir(), "mutation-python-probe-"));
	try {
		const python = process.env.D945_PYTHON;
		if (!python) throw new Error("D945_PYTHON is required for the Python probe fixture");
		const marker = join(directory, "hit");
		const receipt = await pythonWorker({
			python,
			decision: join(import.meta.dir, "conformance/quality-mutation-contract.json"),
			timeout: 15000,
		}, "value = 1", directory, "probe", { start: 0, end: 9, mode: "python-expression" }, marker);
		expect(receipt.stage).toBe("python-probe");
		expect(receipt.exitCode).toBe(0);
		const output = decode(receipt.stdout);
		expect(typeof output === "object" && output !== null && !Array.isArray(output) && typeof output.source === "string").toBe(true);
	} finally { rmSync(directory, { recursive: true, force: true }); }
});

test("assertion receipt parsing separates matcher failures from crashes and other testcases", () => {
	const stderr = [
		"src/a.test.ts:", "error: expect(received).toBe(expected)", "(fail) matcher [1ms]",
		"error: expect(received).not.toEqual(expected)", "(pass) passing [1ms]",
		"Error: crash", "(fail) crash [1ms]",
		"error: expect(received).toBe(expected)", "Error: another crash", "(fail) mixed [1ms]",
		"error:", "Expected promise that rejects", "Received promise that resolved:", "(fail) settlement [1ms]",
		"::group::src/b.test.ts:", "(fail) without diagnostic [1ms]",
		"error: expect(received).resolves.toBe(expected)", "(fail) second-file [1ms]",
	].join("\n");
	expect(failedAssertions(stderr)).toEqual([
		"src/a.test.ts\0matcher", "src/a.test.ts\0settlement", "src/b.test.ts\0second-file",
	]);
	expect(failedAssertions("")).toEqual([]);
});

test("nested bun test stderr credits the parent JUnit testcase", () => {
	const stderr = [
		"src/a.test.ts:",
		"src/assertion.fixture.ts:",
		"error: expect(received).toBe(expected)",
		"(fail) nested [1ms]",
		"error: expect(received).toBe(expected)",
		"(fail) behavior [1ms]",
	].join("\n");
	const xml = '<testsuites><testsuite><testcase file="src/a.test.ts" name="behavior" line="9" assertions="1"><failure type="AssertionError" message="expect(received).toBe(expected)" /></testcase></testsuite></testsuites>';
	expect(failedAssertions(stderr)).toEqual(["src/assertion.fixture.ts\0nested", "src/assertion.fixture.ts\0behavior"]);
	expect(assertionIdentities(xml, stderr)).toEqual([
		JSON.stringify({ file: "src/a.test.ts", name: "behavior", line: "9" }),
	]);
});

test("fixture-file assertion credit rejects ambiguous names and non-assertion failures", () => {
  const stderr = "src/assertion.fixture.ts:\nerror: expect(received).toBe(expected)\n(fail) behavior [1ms]";
  const testcase = '<testcase file="src/a.test.ts" name="behavior" line="9" assertions="1"><failure type="AssertionError" /></testcase>';
  const another = testcase.replace('file="src/a.test.ts"', 'file="src/b.test.ts"');
  expect(assertionIdentities(`<testsuites><testsuite>${testcase}${another}</testsuite></testsuites>`, stderr)).toEqual([]);
  expect(assertionIdentities(`<testsuites><testsuite>${testcase}</testsuite></testsuites>`,
    "src/assertion.fixture.ts:\nTypeError: broken\n(fail) behavior [1ms]",
  )).toEqual([]);
  expect(assertionIdentities(`<testsuites><testsuite>${testcase.replace("AssertionError", "ZodError")}</testsuite></testsuites>`, stderr)).toEqual([]);
});

test("mutation helpers cover execution tree recursion and source traversal", () => {
  const root = mkdtempSync(join(tmpdir(), "mutation-tree-"));
  try {
    mkdirSync(join(root, "nested"));
    writeFileSync(join(root, "nested", "source.ts"), "export const value = 1;");
    symlinkSync("nested/source.ts", join(root, "source-link.ts"));
    expect(executionTreeHash(root)).toHaveLength(64);
    symlinkSync("/tmp", join(root, "external-link.ts"));
    expect(() => executionTreeHash(root)).toThrow();
    const source = mutationSource(resolve(import.meta.dir, ".."), "script/run-quality-mutations.ts");
    expect(source.source).toContain("export async function main");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Python mutation sources use file bytes directly", () => {
	const root = mkdtempSync(join(tmpdir(), "mutation-python-source-"));
	const path = join(root, "driver.py");
	try {
		const raw = 'print("\\n")\n';
		writeFileSync(path, raw);
		const source = mutationSource(root, "driver.py");
		expect(source.source).toBe(raw);
		expect(source.host).toBe(raw);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("process receipts preserve executed failure context, including signals", async () => {
  const failed = await execute([process.execPath, "-e", "process.stderr.write('candidate failed'); process.exit(7)"], process.cwd(), 5000, {}, "candidate-test");
  expect(failed.stage).toBe("candidate-test");
  expect(failed.argv).toEqual([process.execPath, "-e", "process.stderr.write('candidate failed'); process.exit(7)"]);
  expect(failed.exitCode).toBe(7);
  expect(failed.signal).toBeNull();
  expect(failed.stderr).toBe("candidate failed");
  expect(failed.stderrSha256).toBe(sha256("candidate failed"));
  const redacted = await execute([process.execPath, "-e", "process.exit(3)", "--token=inline-secret", "--name", "public"], process.cwd(), 5000, {}, "redaction-test");
  expect(redacted.argv).toEqual([process.execPath, "-e", "process.exit(3)", "--token=[redacted]", "--name", "public"]);
  expect(JSON.stringify(redacted)).not.toContain("inline-secret");
  const signaled = await execute([process.execPath, "-e", "process.kill(process.pid, 'SIGTERM')"], process.cwd(), 5000, {}, "signal-test");
  expect(signaled.stage).toBe("signal-test");
  expect(signaled.exitCode).toBeNull();
  expect(signaled.signal).toBe("SIGTERM");
  expect(signaled.stderrSha256).toBe(sha256(signaled.stderr));
});

test("Python worker receipt stages execute through the runner path", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mutation-python-worker-"));
  try {
    const python = process.env.D945_PYTHON;
    if (!python) throw new Error("D945_PYTHON is required for the Python worker fixture");
    const receipt = await pythonWorker({
      python,
      decision: join(import.meta.dir, "conformance/quality-mutation-contract.json"),
      timeout: 15000,
    }, "print(True)", directory, "compile");
    expect(receipt.stage).toBe("python-compile");
    expect(receipt.exitCode).toBe(0);
    expect(receipt.signal).toBeNull();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("mutation main rejects an invalid invocation in process", async () => {
  expect(await main(["--not-a-real-option"])).toBe(2);
});
const { fixture, invoke, select, assertBehavioralKill, record, rows, evidence, tool, decision, runner, dependencies, FixtureError } = mutationFixture("campaign");
type RecordValue = ReturnType<typeof record>;

function selection(overrides: Partial<TestSelectionReceipt> & { timedOut?: boolean }): TestSelectionReceipt {
  const { timedOut = false, ...rest } = overrides;
  const process = { stage: "tests", argv: [], pid: 1, exitCode: timedOut ? null : 1, signal: null, timedOut, overflow: false, spawnError: false, stdout: "", stderr: "", stdoutSha256: "", stderrSha256: "", cleanupExit: null };
  return { batches: [{ process, junit: '<testsuites tests="1" failures="1"></testsuites>', tests: 1, failures: 1, assertions: ["t"], valid: true }], files: ["src/a.test.ts"], tests: 1, failures: 1, assertions: ["t"], valid: true, exitCode: 1, ...rest };
}

test("classifyCandidate: a bounded suite that never finishes is a kill by non-termination, not infrastructure", () => {
  const timed = { outcome: "survived" as const, reason: "", assertionIdentities: [] as string[] };
  classifyCandidate(timed, selection({ timedOut: true, failures: 0, assertions: [], valid: false, exitCode: 1 }));
  expect([timed.outcome, timed.reason]).toEqual(["killed", "suite-timeout"]);

  const survivor = { outcome: "invalid" as const, reason: "", assertionIdentities: [] as string[] };
  classifyCandidate(survivor, selection({ failures: 0, assertions: [], exitCode: 0 }));
  expect([survivor.outcome, survivor.reason]).toEqual(["survived", "green-mutated-test-selection"]);

  const behavioral = { outcome: "invalid" as const, reason: "", assertionIdentities: [] as string[] };
  classifyCandidate(behavioral, selection({}));
  expect([behavioral.outcome, behavioral.reason, behavioral.assertionIdentities]).toEqual(["killed", "behavioral-assertion", ["t"]]);

  const broken = { outcome: "invalid" as const, reason: "", assertionIdentities: [] as string[] };
  classifyCandidate(broken, selection({ assertions: [], exitCode: 1 }));
  expect([broken.outcome, broken.reason]).toEqual(["infrastructure", "failure-without-complete-behavioral-assertions"]);
});

for (const junit of ["", '<testsuites tests="1" failures="0"><testsuite>']) {
  for (const mode of ["nonzero", "signal"] as const) {
    test(`classifyCandidate: ${mode} with ${junit ? "truncated" : "missing"} JUnit is resource-exhaustion after green selection`, () => {
      const tested = selection({ failures: 0, assertions: [], valid: false });
      const batch = tested.batches[0];
      if (!batch) throw new Error("missing fixture batch");
      batch.junit = junit;
      batch.valid = false;
      batch.process.exitCode = mode === "nonzero" ? 134 : null;
      batch.process.signal = mode === "signal" ? "SIGABRT" : null;
      const result = { outcome: "invalid" as const, reason: "", assertionIdentities: [] as string[] };
      classifyCandidate(result, tested);
      expect([result.outcome, result.reason, result.assertionIdentities]).toEqual(["killed", "resource-exhaustion", []]);
    });
  }
}

function processFixture(overrides: Partial<Awaited<ReturnType<typeof execute>>> = {}): Awaited<ReturnType<typeof execute>> {
  return { stage: "tests", argv: [], pid: 1, exitCode: 0, signal: null, timedOut: false, overflow: false, spawnError: false, stdout: "cap-ok", stderr: "", stdoutSha256: "", stderrSha256: "", cleanupExit: 0, ...overrides };
}

for (const hasPrlimit of [true, false]) {
  test(`memory cap self-check accepts Bun acknowledgement through ${hasPrlimit ? "prlimit" : "ulimit"}`, async () => {
    const calls: string[][] = [];
    await verifyMutantMemoryCap(6144 * 1024 * 1024, "linux", hasPrlimit, async (argv, _cwd, timeout, _environment, stage) => {
      calls.push(argv);
      expect(timeout).toBe(15_000);
      expect(stage).toBe("mutant-memory-cap-self-check");
      return processFixture();
    });
    const prefix = hasPrlimit ? ["prlimit", "--as=6442450944", "--"] : ["sh", "-c", 'ulimit -v 6291456 && exec "$@"', "sh"];
    expect(calls).toEqual([[...prefix, process.execPath, "--smol", "-e", "process.stdout.write('cap-ok')"]]);
  });

  test(`memory cap self-check rejects ${hasPrlimit ? "prlimit" : "ulimit"} setup failure as infrastructure`, async () => {
    const stderr = hasPrlimit ? "prlimit: failed to set the AS resource limit: Operation not permitted" : "ulimit: error setting limit (Operation not permitted)";
    await expect(verifyMutantMemoryCap(6144 * 1024 * 1024, "linux", hasPrlimit, async () => processFixture({
      exitCode: hasPrlimit ? 1 : 2, stdout: "", stderr,
    }))).rejects.toMatchObject({ code: "infrastructure", message: `mutant memory cap unavailable: ${stderr}` });
  });
}

test("memory cap self-check rejects missing acknowledgement and broken process receipts", async () => {
  for (const failure of [{ stdout: "" }, { stdout: "cap-ok-extra" }, { signal: "SIGABRT" }, { spawnError: true }, { timedOut: true }, { overflow: true }]) {
    await expect(verifyMutantMemoryCap(6144 * 1024 * 1024, "linux", true, async () => processFixture(failure))).rejects.toMatchObject({ code: "infrastructure" });
  }
});

test("boundedArgv uses prlimit on Linux with an address-space limit in bytes", () => {
  const argv = ["bun", "--smol", "test", "./space and $literal.test.ts"];
  expect(boundedArgv(argv, 6144 * 1024 * 1024, "linux", true)).toEqual([
    "prlimit", "--as=6442450944", "--", ...argv,
  ]);
  expect(argv).toEqual(["bun", "--smol", "test", "./space and $literal.test.ts"]);
});

test("boundedArgv falls back to a quoted exec with a KiB ulimit on Linux", () => {
  const argv = ["bun", "--smol", "test", "./space and $literal.test.ts"];
  expect(boundedArgv(argv, 6144 * 1024 * 1024, "linux", false)).toEqual([
    "sh", "-c", 'ulimit -v 6291456 && exec "$@"', "sh", ...argv,
  ]);
});

test("boundedArgv leaves Darwin and uncapped selection commands unwrapped", () => {
  const argv = ["bun", "--smol", "test", "./a.test.ts"];
  for (const hasPrlimit of [true, false]) {
    expect(boundedArgv(argv, 6144 * 1024 * 1024, "darwin", hasPrlimit)).toBe(argv);
    expect(boundedArgv(argv, 0, "linux", hasPrlimit)).toBe(argv);
  }
});

test("classifyCandidate keeps spawn failures, output overflow and unexplained missing exits as infrastructure", () => {
  for (const failure of [{ spawnError: true }, { overflow: true }, { exitCode: null }]) {
    const tested = selection({ valid: false, assertions: [] });
    const batch = tested.batches[0];
    if (!batch) throw new Error("missing fixture batch");
    batch.junit = "";
    Object.assign(batch.process, failure);
    const result = { outcome: "invalid" as const, reason: "", assertionIdentities: [] as string[] };
    classifyCandidate(result, tested);
    expect([result.outcome, result.reason]).toEqual(["infrastructure", "failure-without-complete-behavioral-assertions"]);
  }
});

test("rendered process receipts redact split and inline secrets without hiding ordinary arguments", async () => {
  const command = [process.execPath, "-e", "process.exit(7)", "--"];
  const ordinary = ["--name", "public", "--monkey=banana", "--key-file=public.pem", "--tokenizer", "native"];
  const secrets = ["inline-key-secret", "split-key-secret", "inline-token-secret", "split-token-secret", "api-key-secret"];
  const receipt = await execute([...command,
    `--key=${secrets[0]}`, "--key", secrets[1] ?? "", ...ordinary,
    `--token=${secrets[2]}`, "--token", secrets[3] ?? "", ...ordinary,
    `--api-key=${secrets[4]}`, ...ordinary,
  ], process.cwd(), 5000, {}, "redaction-test");
  expect(receipt.exitCode).toBe(7);
  const rendered = JSON.stringify(receipt);
  expect(record(decode(rendered)).argv).toEqual([...command,
    "--key=[redacted]", "--key", "[redacted]", ...ordinary,
    "--token=[redacted]", "--token", "[redacted]", ...ordinary,
    "--api-key=[redacted]", ...ordinary,
  ]);
  for (const secret of secrets) expect(rendered).not.toContain(secret);
});

for (const mode of ["nonzero", "signal"] as const) {
  test(`top-level setup failure propagates ${mode} process context and redacts rendered diagnostics`, async () => {
    const input = await fixture("export const run = () => true;", "expect(run()).toBe(true);");
    const worker = join(input.root, "canonical-worker.ts");
    const stdout = "worker-started\n";
    const stderr = "setup worker failed: --key=inline-key-secret --token split-token-secret --name public\n";
    const safeStderr = "setup worker failed: --key=[redacted] --token [redacted] --name public\n";
    writeFileSync(worker, `import {writeFileSync} from "node:fs";
      writeFileSync(1, ${JSON.stringify(stdout)});
      writeFileSync(2, ${JSON.stringify(stderr)});
      ${mode === "nonzero" ? "process.exit(7);" : 'process.kill(process.pid, "SIGTERM");'}`);
    const result = await invoke(input, `setup-${mode}`, select("boolean-literal"), [
      "--inventory-tool", worker, "--inventory-tool-sha256", sha256(readFileSync(worker)),
    ]);
    expect(result.code).toBe(2);
    expect(result.report.complete).toBe(false);
    expect(result.report.results).toBeUndefined();
    expect(result.selected).toHaveLength(0);
    const error = record(result.report.error);
    expect(error.code).toBe("incompleteInventory");
    const receipt = record(error.process);
    expect(receipt.stage).toBe("setup-canonical-inventory");
    expect(receipt.argv).toEqual([
      process.execPath, worker, "--root", realpathSync(input.root), "--contract", join(input.root, "contract.json"), "--inventory", input.inventory,
    ]);
    expect(receipt.exitCode).toBe(mode === "nonzero" ? 7 : null);
    expect(receipt.signal).toBe(mode === "signal" ? "SIGTERM" : null);
    expect(receipt.timedOut).toBe(false);
    expect(receipt.spawnError).toBe(false);
    expect(receipt.overflow).toBe(false);
    expect(receipt.stdout).toBe(stdout);
    expect(receipt.stdoutSha256).toBe(sha256(stdout));
    expect(receipt.stderr).toBe(safeStderr);
    expect(receipt.stderrSha256).toBe(sha256(stderr));
    // The CLI JSON is decoded by invoke; inspect its complete machine-consumed
    // envelope, not only the execute() helper or the process subobject.
    const rendered = JSON.stringify(result.report);
    expect(rendered).not.toContain("inline-key-secret");
    expect(rendered).not.toContain("split-token-secret");
  }, 90000);
}


function expectRestoredResults(result: RecordValue, count: number): void {
	const selected = rows(result.selected).map(record);
	expect(selected).toHaveLength(count);
	expect(new Set(selected.map((row) => String(row.id))).size).toBe(count);
	expect(selected.every((row) => row.restored === true)).toBe(true);
}

test("fixture argument replacement is pure and rejects incomplete pairs", () => {
  const argv = ["runner", "--root", "before", "--limit", "1"];
  expect(replaceArguments(argv, ["--root", "after", "--limit", "2"])).toEqual(["runner", "--root", "after", "--limit", "2"]);
  expect(argv[2]).toBe("before");
  expect(replaceArguments(argv, [])).toEqual(argv);
  for (const alter of [["--root"], ["", "value"], ["--root", ""]]) expect(() => replaceArguments(argv, alter)).toThrow();
});

test("fixture report processing validates candidate counts hashes and reached outcomes in process", () => {
  const replacement = "false", replacementSha256 = sha256(replacement);
  const results = ["killed", "survived", "noCoverage", "invalid"].map((outcome, startOffset) => ({
    path: "src/a.ts", startOffset, endOffset: startOffset + 1, replacement, replacementSha256,
    id: sha256(`src/a.ts\0${startOffset}\0${startOffset + 1}\0${replacementSha256}`),
    selected: true, outcome, coverage: { reached: outcome !== "noCoverage" },
  }));
  const report = { results, census: [{ path: "src/a.ts", operators: [{ candidates: 4 }] }], counts: { killed: 1, survived: 1, noCoverage: 1, invalid: 1 } };
  expect(reportResults(report)).toEqual(results);
  expect(reportResults({})).toEqual([]);
  expect(reportResults({ ...report, results: results.map((row) => ({ ...row, selected: false })) })).toEqual([]);
  for (const patch of [
    { counts: { killed: 2 } }, { census: [{ path: "src/a.ts", operators: [{ candidates: 3 }] }] },
    { results: results.map((row) => ({ ...row, replacementSha256: "wrong" })) },
    { results: results.map((row) => ({ ...row, id: "wrong" })) },
    { results: results.map((row) => ({ ...row, coverage: { reached: false } })) },
    { results: results.map((row) => ({ ...row, coverage: { reached: true } })) },
  ]) expect(() => reportResults({ ...report, ...patch })).toThrow();
});

test("fixture evidence preserves present fields and materializes missing fields as null", () => {
  const report = { full: false, complete: true, counts: {}, selectedCounts: {}, error: "failure", errors: [], cleanupVerified: true };
  const selected = { id: "id", operator: "equality", outcome: "killed", reason: "assertion", assertionIdentities: ["test"], restored: false };
  expect(mutationEvidence(report, [selected])).toEqual({ ...report, report, selected: [selected] });
  const empty = mutationEvidence({}, [{}]);
  expect(empty.full).toBeNull();
  expect(rows(empty.selected).map(record)[0]).toEqual({ id: null, operator: null, outcome: null, reason: null, assertionIdentities: null, restored: null });
  for (const value of [undefined, null, false, [], "invalid"]) expect(() => record(value)).toThrow();
  for (const value of [undefined, null, {}, "invalid"]) expect(() => rows(value)).toThrow();
});

test("campaign runs baseline, mutant, restoration and JSON receipt in process", async () => {
	const input = await fixture("export const run = () => true;", "expect(run()).toBe(true);", {
		"src/other/package.json": '{"name":"other","type":"module"}',
		"src/other/extra.test.ts": 'import {test,expect} from "bun:test";test("isolated package",()=>expect(process.cwd().endsWith("other")).toBe(true));',
	});
	fixtureGit(input.root, "init", "-q");
	fixtureGit(input.root, "add", ".");
	fixtureGit(input.root, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "fixture");
	const external = await invoke(input, "in-process-reference", select("boolean-literal"));
	assertBehavioralKill(external);
	const argv = rows(evidence.at(-1)?.argv).map(String).slice(2);
	const { output, restore } = captureOutput();
	try {
		expect(await main(argv)).toBe(0);
		const report = record(decode(output.join("")));
		expect(report.complete).toBe(true);
		expect(report.cleanupVerified).toBe(true);
		expect(report.originalHashesVerified).toBe(true);
		expect(report.selectedCounts).toEqual(external.report.selectedCounts);
		const batches = rows(record(report.baseline).batches).map(record);
		expect(batches).toHaveLength(2);
		expect(batches.every((batch) => record(batch.process).timedOut === false)).toBe(true);
		expect(reportResults(report)[0]?.outcome).toBe("killed");
	} finally { restore(); }
}, 90000);

test("reach discovery follows baseline execution across package ignore rules", async () => {
	const input = await fixture("export const run = () => true;", "expect(run()).toBe(true);", {
		"bunfig.toml": '[test]\npathIgnorePatterns = ["**/ignored/**"]\n',
		"src/ignored/blocked.spec.ts": 'throw new Error("not a Bun test");',
		"src/other/package.json": '{"name":"other","type":"module"}',
		"src/other/bunfig.toml": '[test]\npathIgnorePatterns = ["**/external/**"]\n',
		"src/other/extra.test.ts": 'import {test,expect} from "bun:test";test("other",()=>expect(true).toBe(true));',
		"src/other/external/blocked.spec.ts": 'throw new Error("not a Bun test");',
	});
	const result = await invoke(input, "native-test-discovery", select("boolean-literal"));
	assertBehavioralKill(result);
	const report = await runMain(input, process.env.D945_PYTHON ?? "python3", select("boolean-literal"), 0);
	expect(report.selectedCounts).toEqual(result.report.selectedCounts);
	expect(report.cleanupVerified).toBe(true);
	expect(report.originalHashesVerified).toBe(true);
	expect(rows(record(report.baseline).batches).map(record).map((batch) => batch.tests)).toEqual([1, 1]);
	expect(rows(record(report.reachMap).runs).map(record).map((run) => run.test)).toEqual([
		"src/a.test.ts", "src/other/extra.test.ts",
	]);
	const inventoried = rows(record(decode(readFileSync(input.inventory, "utf8"))).files).map(record);
	expect(inventoried.some((file) => file.path === "src/ignored/blocked.spec.ts")).toBe(true);
	expect(readFileSync(join(input.root, "src/a.ts"), "utf8") === input.files["src/a.ts"]).toBe(true);
}, 90000);

test("reach probes are served at module load so tests reading their own source as text stay green", async () => {
	const source = "export const run = () => true;";
	const input = await fixture(
		source,
		`expect(run()).toBe(true); expect(await Bun.file(new URL("./a.ts", import.meta.url)).text()).toBe(${JSON.stringify(source)});`,
	);
	const result = await invoke(input, "reach-text-read", select("boolean-literal"));
	assertBehavioralKill(result);
	const report = await runMain(input, process.env.D945_PYTHON ?? "python3", select("boolean-literal"), 0);
	expect(reportResults(report)[0]?.outcome).toBe("killed");
	expect(rows(record(report.reachMap).runs).map(record).map((run) => run.test)).toEqual(["src/a.test.ts"]);
	expect(rows(record(report.reachMap).sites).map(record).every((site) => rows(site.tests).length === 1)).toBe(true);
	expect(readFileSync(join(input.root, "src/a.ts"), "utf8") === source).toBe(true);
}, 90000);

test("failed reach probes retain their test process and JUnit instead of object stringification", async () => {
	const input = await fixture(
		'globalThis.Reflect.has = () => { throw new Error("probe-receiver-failure"); }; export const run = () => true;',
		"expect(run()).toBe(true);",
	);
	fixtureGit(input.root, "init", "-q");
	fixtureGit(input.root, "add", ".");
	fixtureGit(input.root, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "fixture");
	const worktrees = fixtureGit(input.root, "worktree", "list", "--porcelain");
	const result = await invoke(input, "reach-diagnostics", select("boolean-literal"));
	expect(result.code).toBe(2);
	expect(result.report.complete).toBe(false);
	const report = await runMain(input, process.env.D945_PYTHON ?? "python3", select("boolean-literal"), 2);
	const error = record(report.error);
	expect(error.code).toBe("reachMap");
	expect(error.code).toBe(record(result.report.error).code);
	const reach = record(error.reach);
	expect(reach.test).toBe("src/a.test.ts");
	const batch = record(rows(record(reach.receipt).batches)[0]);
	const child = record(batch.process);
	expect(child.exitCode).not.toBe(0);
	expect(child.stderr).toContain("probe-receiver-failure");
	expect(child.stderrSha256).toBe(sha256(String(child.stderr)));
	expect(batch.junit).toContain("<testsuites");
	expect(readFileSync(join(input.root, "src/a.ts"), "utf8") === input.files["src/a.ts"]).toBe(true);
	expect(fixtureGit(input.root, "worktree", "list", "--porcelain")).toBe(worktrees);
}, 90000);

test("sequential compiler analysis preserves first-owner candidates and complete census", async () => {
	const input = await fixture("export const run = () => true;", "expect(run()).toBe(true);", {
		"src/driver.py": "print(True)",
	});
	const contract = readContract(join(input.root, "contract.json"));
	contract.projects.push(...contract.projects);
	const inventory = buildInventory(input.root, contract);
	const operators = [{ id: "boolean-literal", replacements: new Map<string, string[]>() }];
	const eager = [...programs(input.root, contract, inventory)];
	const expected = enumerate(input.root, inventory, operators, eager);
	const actual = analyze(input.root, contract, inventory, operators);
	expect(actual.enumerated).toEqual(expected);
	expect(actual.sourceDiagnostics).toEqual(diagnostics(eager, realpathSync(input.root)));
	expect(actual.enumerated.candidates.length).toBeGreaterThan(0);
}, 90000);

test("reach probes on assignment targets wrap the consuming assignment", async () => {
	const source = 'export function run() { let a = 0; let rest: number[] = []; const pair = { a: 1, b: [2, 3] }; ({ a, b: [...rest] } = pair); a.valueOf(); [a] = [a + 1]; return { a, rest, sum: [a, ...rest].length }; }';
	const input = await fixture(source, "expect(run().sum).toBe(3);");
	const contract = readContract(join(input.root, "contract.json"));
	const operators = ["object-literal", "array-literal", "arithmetic"]
		.map((id) => ({ id, replacements: new Map([["+", ["-"]]]) }));
	const candidates = analyze(input.root, contract, buildInventory(input.root, contract), operators)
		.enumerated.candidates.filter((candidate) => candidate.path === "src/a.ts" && candidate.site.mode === "expression");
	const targets = ['{ a, b: [...rest] }', '[...rest]', '[a]'].map((text) => source.indexOf(text));
	for (const offset of targets) expect(candidates.some((candidate) => candidate.startOffset === offset)).toBe(true);
	for (const candidate of candidates.filter((candidate) => targets.includes(candidate.startOffset)))
		expect(source.slice(candidate.site.start, candidate.site.end)).toMatch(/^[[{(].* = .*[\])]$/);
	const directory = mkdtempSync(join(tmpdir(), "mutation-assignment-probe-"));
	try {
		const transformed = instrument(source, candidates.map((candidate, index) => ({
			id: `site-${index}`, path: candidate.path, sourceSha256: candidate.sourceSha256, site: candidate.site, tests: [],
		})), directory);
		expect(new Bun.Transpiler({ loader: "ts" }).transformSync(transformed)).toContain("writeFileSync");
	} finally { rmSync(directory, { recursive: true, force: true }); }
}, 90000);

// #1097/#1175 defect 3: a destructuring pattern in a `for (... of/in ...)` head
// has no consuming assignment expression; probing it as a value yields an
// invalid assignment target, so the probe is an entry marker on the loop
// statement, hoisted above any label so `continue label` keeps its target.
// (TypeScript refuses a destructuring `for...in` head, so only `for...of`
// patterns can appear in a strict fixture.)
test("reach probes on iteration-head patterns become entry markers on the loop statement", async () => {
	const source = 'export function run() { let a = 0; let x = 0; let y = 0; const items = [{ a: 1 }, { a: 2 }]; const pairs: [number, number][] = [[1, 2], [3, 4]]; for ({ a } of items) x += a; outer: for ([x, y] of pairs) { if (x > 1) continue outer; y += 1; } return { a, x, y, sum: [x, y].length }; }';
	const input = await fixture(source, "expect(run().sum).toBe(2);");
	const contract = readContract(join(input.root, "contract.json"));
	const operators = ["object-literal", "array-literal", "arithmetic"]
		.map((id) => ({ id, replacements: new Map([["+", ["-"]]]) }));
	const candidates = analyze(input.root, contract, buildInventory(input.root, contract), operators)
		.enumerated.candidates.filter((candidate) => candidate.path === "src/a.ts");
	const heads = [
		["{ a } of items", "for ({ a } of items)"],
		["[x, y] of pairs", "outer: for ([x, y] of pairs)"],
	] as const;
	for (const [pattern, statement] of heads) {
		const offset = source.indexOf(pattern);
		const probed = candidates.filter((candidate) => candidate.startOffset === offset);
		expect(probed.length).toBeGreaterThan(0);
		for (const candidate of probed) {
			expect(candidate.site.mode).toBe("statement");
			expect(candidate.site.start).toBe(source.indexOf(statement));
		}
	}
	const directory = mkdtempSync(join(tmpdir(), "mutation-iteration-probe-"));
	try {
		const transformed = instrument(source, candidates.map((candidate, index) => ({
			id: `site-${index}`, path: candidate.path, sourceSha256: candidate.sourceSha256, site: candidate.site, tests: [],
		})), directory);
		const path = join(directory, "a.ts");
		writeFileSync(path, transformed);
		expect(strictDiagnostics(strictProgram(directory, path))).toEqual([]);
		expect(new Bun.Transpiler({ loader: "ts" }).transformSync(transformed)).toContain("writeFileSync");
	} finally { rmSync(directory, { recursive: true, force: true }); }
}, 90000);

test("enumeration preserves directive prologues and mutates regex quantifiers and anchors", async () => {
	const source = '"use strict"; "custom directive"; export function run() { "use strict"; const pattern = /^a+b*c?$/; "ordinary"; if (true) "branch string"; return pattern.test("ab"); }';
	const input = await fixture(source, "expect(run()).toBe(true);");
	const contract = readContract(join(input.root, "contract.json"));
	const operators = ["string-literal", "statement-delete", "regex"]
		.map((id) => ({ id, replacements: new Map<string, string[]>() }));
	const result = analyze(input.root, contract, buildInventory(input.root, contract), operators).enumerated;
	const candidates = result.candidates.filter((candidate) => candidate.path === "src/a.ts");
	for (const offset of [0, source.indexOf('"custom directive"'), source.lastIndexOf('"use strict"')])
		expect(candidates.some((candidate) => candidate.startOffset === offset)).toBe(false);
	for (const value of ['"ordinary"', '"branch string"'])
		expect(candidates.some((candidate) => candidate.startOffset === source.indexOf(value))).toBe(true);
	expect(candidates.filter((candidate) => candidate.operator === "regex").map((candidate) => candidate.replacement).sort())
		.toEqual(["/a+b*c?$/", "/^a*b*c?$/", "/^a+b+c?$/", "/^a+b*c$/", "/^a+b*c?/", "/^a+b*c?$/i", "/^a+b*c?$/g"].sort());
}, 90000);

function fixtureGit(root: string, ...args: string[]): string {
	const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
	expect(result.status).toBe(0);
	return result.stdout.trim();
}

test("execution worktrees retain Git history, dirty inputs, dependencies and isolated indexes", () => {
	const root = mkdtempSync(join(tmpdir(), "mutation-git-"));
	const copy = join(root, "copy"), nested = join(root, "nested"), source = join(root, "source");
	mkdirSync(source);
	try {
		fixtureGit(source, "init", "-q");
		writeFileSync(join(source, "tracked.ts"), "export const value = true;");
		fixtureGit(source, "add", ".");
		fixtureGit(source, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "fixture");
		writeFileSync(join(source, "tracked.ts"), "export const value = false;");
		writeFileSync(join(source, "deleted.ts"), "export const deleted = true;");
		fixtureGit(source, "add", "deleted.ts");
		fixtureGit(source, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "tracked deletion fixture");
		const head = fixtureGit(source, "rev-parse", "HEAD");
		rmSync(join(source, "deleted.ts"));
		mkdirSync(join(source, "node_modules/dep/dist"), { recursive: true });
		writeFileSync(join(source, "node_modules/dep/dist/index.js"), "export const value = 1;");
		copyExecution(source, copy);
		copyExecution(copy, nested);
		expect(fixtureGit(nested, "rev-parse", "HEAD")).toBe(head);
		expect(fixtureGit(nested, "log", "-1", "--format=%s")).toBe("tracked deletion fixture");
		expect(fixtureGit(nested, "ls-files")).toBe("deleted.ts\ntracked.ts");
		expect(readFileSync(join(nested, "tracked.ts"), "utf8")).toBe("export const value = false;");
		expect(existsSync(join(copy, "deleted.ts"))).toBe(false);
		expect(existsSync(join(nested, "deleted.ts"))).toBe(false);
		expect(readFileSync(join(nested, "node_modules/dep/dist/index.js"), "utf8")).toBe("export const value = 1;");
		const hash = executionTreeHash(copy);
		writeFileSync(join(nested, "tracked.ts"), "mutant");
		fixtureGit(nested, "add", "tracked.ts");
		expect(fixtureGit(source, "diff", "--cached")).toBe("");
		expect(executionTreeHash(copy)).toBe(hash);
		removeExecution(nested);
		removeExecution(copy);
		expect(fixtureGit(source, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
		expect(existsSync(copy)).toBe(false);
		expect(existsSync(nested)).toBe(false);
	} finally {
		removeExecution(nested);
		removeExecution(copy);
		rmSync(root, { recursive: true, force: true });
	}
});

test("execution snapshots retain isolated workspace dependencies and built exports", async () => {
	const input = await fixture('import { value } from "workspace-dep"; export const run = () => value === 7;', "expect(run()).toBe(true);");
	mkdirSync(join(input.root, "vendor/dep/dist"), { recursive: true });
	mkdirSync(join(input.root, "src/node_modules"), { recursive: true });
	writeFileSync(join(input.root, "vendor/dep/package.json"), JSON.stringify({ name: "workspace-dep", type: "module", exports: "./dist/index.js" }));
	writeFileSync(join(input.root, "vendor/dep/dist/index.js"), "export const value = 7;");
	writeFileSync(join(input.root, "vendor/dep/dist/index.d.ts"), "export declare const value: number;");
	symlinkSync("../../vendor/dep", join(input.root, "src/node_modules/workspace-dep"));
	// A real workspace back-edge must remain internal, without recursive copying.
	mkdirSync(join(input.root, "vendor/dep/node_modules"));
	symlinkSync("../../../src", join(input.root, "vendor/dep/node_modules/app"));
	const result = await invoke(input, "workspace-layout", select("equality"));
	assertBehavioralKill(result);
	expect(result.report.sourceDiagnostics).toEqual([]);
	expect(result.report.cleanupVerified).toBe(true);
	expect(readFileSync(join(input.root, "vendor/dep/dist/index.js"), "utf8")).toBe("export const value = 7;");
}, 90000);

test("nested bun test fixture assertion credits its parent testcase", async () => {
	const input = await fixture(
		"export const run = () => true;",
		'const child = Bun.spawn([process.execPath, "test", "./src/assertion.fixture.ts"], { cwd: new URL("..", import.meta.url).pathname, stdout: "ignore", stderr: "inherit" }); expect(await child.exited).toBe(0);',
		{
			"src/assertion.fixture.ts":
				'import { expect, test } from "bun:test"; import { run } from "./a"; test("nested", () => { expect(run()).toBe(true); });',
		},
	);
	const result = await invoke(input, "fixture-assertion-credit", select("boolean-literal"));
	assertBehavioralKill(result);
}, 90000);

test("review R2: negated assertion is a behavioral kill", async () => {
	const input = await fixture("export const run = () => true;", "expect(run()).not.toBe(false);");
	const result = await invoke(input, "review-negated", select("boolean-literal"));
	assertBehavioralKill(result);
}, 90000);

test("review R3: optional method preserves its receiver", async () => {
	const input = await fixture(
		"const value = { n: 3, method() { return this.n; } }; export const run = () => value?.method();",
		"expect(run()).toBe(3);",
	);
	const result = await invoke(input, "review-receiver", select("optional-chain"));
	expect(result.code).toBe(1);
	expect(result.selected[0]?.outcome).toBe("survived");
}, 90000);

test("weak assertion survives; original location is really covered", async () => {
	const input = await fixture(
		"export const run = () => true;",
		'expect(typeof run()).toBe("boolean");',
	);
	const result = await invoke(input, "survivor", select("boolean-literal"));
	expect(result.code).toBe(1);
	expect(result.selected[0]?.outcome).toBe("survived");
}, 90000);

async function runMain(input: Awaited<ReturnType<typeof fixture>>, python: string, selection: string[], expectedExit = 1, runtime?: TestRuntime): Promise<RecordValue> {
	const paths = { contract: join(input.root, "contract.json"), inventory: input.inventory, decision, "inventory-tool": tool };
	const argv = ["--root", input.root, "--dependencies", dependencies, "--python", python];
	for (const [key, path] of Object.entries(paths)) argv.push(`--${key}`, path, `--${key}-sha256`, sha256(readFileSync(path)));
	argv.push(...selection);
	const output: string[] = [];
	const originalLog = console.log;
	console.log = (...values: string[]) => output.push(values.join(" "));
	try { expect(await main(argv, runtime)).toBe(expectedExit); } finally { console.log = originalLog; }
	return record(decode(output.at(-1) ?? "{}"));
}

test("main runs a campaign in process and reports killed and noCoverage candidates", async () => {
	const input = await fixture("export const run = () => true; export const unused = () => false;", "expect(run()).toBe(true);");
	const results = reportResults(await runMain(input, process.env.QUALITY_MUTATION_PYTHON ?? process.env.D945_PYTHON ?? "python3", ["--target", "src/a.ts", "--operator", "boolean-literal", "--limit", "2"]));
	const outcomes = results.map((row) => row.outcome);
	expect(outcomes).toContain("killed");
	expect(outcomes).toContain("noCoverage");
	expect(results.filter((row) => ["killed", "noCoverage"].includes(String(row.outcome))).every((row) => row.restored === true)).toBe(true);
	expect(results.some((row) => rows(row.receipts).length > 0)).toBe(true);
}, 120000);

test("in-process campaign records survived and infrastructure outcomes", async () => {
	const survivor = await fixture("export const run = () => true;", 'expect(typeof run()).toBe("boolean");');
	const survivorReport = reportResults(await runMain(
		survivor,
		process.env.QUALITY_MUTATION_PYTHON ?? process.env.D945_PYTHON ?? "python3",
		select("boolean-literal"),
		1,
	));
	expect(survivorReport[0]?.outcome).toBe("survived");
	expect(survivorReport[0]?.restored).toBe(true);

	const crash = await fixture("export const run = () => true;", 'if (!run()) throw new Error("mutant");');
	const crashReport = reportResults(await runMain(
		crash,
		process.env.QUALITY_MUTATION_PYTHON ?? process.env.D945_PYTHON ?? "python3",
		select("boolean-literal"),
		2,
	));
	expect(crashReport[0]?.outcome).toBe("infrastructure");
	expect(crashReport[0]?.reason).toBe("failure-without-complete-behavioral-assertions");
	expect(crashReport[0]?.restored).toBe(true);
}, 120000);

test("campaign preserves compiler shutdown as infrastructure and restores source", async () => {
	const input = await fixture("export const run = () => true;", "expect(run()).toBe(true);");
	const check = MutationCompilerWorker.prototype.checkBatch;
	const disposed = spyOn(MutationCompilerWorker.prototype, "checkBatch").mockImplementation(async function (this: MutationCompilerWorker, requests) {
		await this.close();
		return check.call(this, requests);
	});
	try {
		const report = await runMain(input, process.env.D945_PYTHON ?? "python3", select("boolean-literal"), 2);
		const result = reportResults(report)[0];
		expect(result?.outcome).toBe("infrastructure");
		expect(result?.reason).toBe("typecheck-engine");
		expect(result?.compilerFailure).toBe("Compiler worker unavailable");
		expect(result?.compilerProof).toBeUndefined();
		expect(result?.receipts).toEqual([]);
		expect(result?.restored).toBe(true);
		expect(report.complete).toBe(false);
		expect(report.cleanupVerified).toBe(true);
		expect(readFileSync(join(input.root, "src/a.ts"), "utf8")).toBe("export const run = () => true;");
	} finally { disposed.mockRestore(); }
}, 120000);

test("campaign rejects frozen source changes made by a baseline descendant", async () => {
	const source = "export const run=()=>1;";
	const input = await fixture(source,
		'expect(typeof run()).toBe("number"); if(process.cwd().endsWith("/baseline")){const {writeFileSync}=await import("node:fs");const {join}=await import("node:path");writeFileSync(join(process.cwd(),"../frozen/src/a.ts"),"export const run=()=>2;");}',
	);
	const report = await runMain(input, process.env.D945_PYTHON ?? "python3", select("numeric-literal"), 2);
	expect(report.complete).toBe(false);
	expect(record(report.error).code).toBe("tamper");
	expect(report.results).toBeUndefined();
	expect(readFileSync(join(input.root, "src/a.ts"), "utf8")).toBe(source);
}, 120000);

test("main runs Python candidates through probe and restores the source", async () => {
	const python = process.env.D945_PYTHON ?? process.env.QUALITY_MUTATION_PYTHON;
	if (!python) throw new Error("D945_PYTHON is required for the Python campaign fixture");
	const input = await fixture(
		"export const run = () => true;",
		`const result = Bun.spawnSync([${JSON.stringify(python)}, "-c", "import sys;sys.path.insert(0, 'src');import calc;print(calc.f(2))"]); expect(result.stdout.toString().trim()).toBe("3"); expect(result.exitCode).toBe(0);`,
		{
			"src/calc.py": "def f(value):\n    return value + 1\n\ndef unused(value):\n    return value * 2\n",
			"src/calc.test.ts": `import { expect, test } from "bun:test"; test("calc", () => { const result = Bun.spawnSync([process.env.D945_PYTHON!, "-c", "import sys;sys.path.insert(0, 'src');import calc;print(calc.f(2))"]); expect(result.stdout.toString().trim()).toBe("3"); expect(result.exitCode).toBe(0); });`,
		},
	);
	const results = reportResults(await runMain(input, python, ["--target", "src/calc.py", "--operator", "py-number", "--limit", "2"])).filter((row) => row.path === "src/calc.py");
	expect(results.map((row) => row.outcome)).toEqual(expect.arrayContaining(["killed", "noCoverage"]));
	expect(results.every((row) => row.restored === true)).toBe(true);
	expect(results.flatMap((row) => rows(row.receipts).map(record)).some((receipt) => receipt.stage === "python-probe")).toBe(true);
	expect(readFileSync(join(input.root, "src/calc.py"), "utf8")).toBe(input.files["src/calc.py"] ?? "");
}, 120000);

test("same-site replacements use the campaign reach map and preserve candidate receipts", async () => {
	const input = await fixture(
		"export const run = (n:number) => n < 2;",
		"expect(run(1)).toBe(true);",
	);
	const result = await invoke(input, "same-site-reuse", ["--target", "src/a.ts", "--operator", "relational", "--limit", "2"]);
	expect(result.code).toBe(1);
	expectRestoredResults(result, 2);
	expect(result.selected.every((row) => ["killed", "survived"].includes(String(row.outcome)))).toBe(true);
	// Persistent compiler proof is not an independent process receipt.
	expect(result.selected.map((row) => rows(row.receipts).length)).toEqual([1, 1]);
	const subsequent = record(result.selected[1]?.compilerProof);
	expect(rows(subsequent.projects).map(record).some((project) => project.mode === "incremental")).toBe(true);
	for (const row of result.selected) {
		const proof = record(row.compilerProof);
		expect(proof.kind).toBe("persistent-compiler");
		expect(proof.candidateId).toBe(row.id);
		expect(proof.executionTreeSha256).toBe(result.report.executionTreeSha256);
		expect(proof.valid).toBe(true);
		expect(proof.diagnostics).toEqual([]);
		expect(proof.exitCode).toBeUndefined();
		expect(proof.argv).toBeUndefined();
	}
}, 90000);

test("same-site candidates record each covering test exactly once in order", async () => {
	const source = "export const run = (n:number) => n < 2;";
	const input = await fixture(source, "expect(run(1)).toBe(true);", {
		"src/b.test.ts": 'import {test,expect} from "bun:test"; import {run} from "./a"; test("above boundary", () => expect(run(3)).toBe(false));',
		"src/c.test.ts": 'import {test,expect} from "bun:test"; import {run} from "./a"; test("not covering", () => expect(typeof run).toBe("function"));',
	});
	const result = await invoke(input, "same-site-unique-tests", ["--target", "src/a.ts", "--operator", "relational", "--limit", "2"]);
	expect(result.code).toBe(1);
	expectRestoredResults(result, 2);
	const tests = ["src/a.test.ts", "src/b.test.ts"];
	expect(result.selected.map((row) => record(row.coverage).tests)).toEqual([tests, tests]);
	const sites = rows(record(result.report.reachMap).sites).map(record);
	expect(sites.map((row) => row.id)).toEqual(result.selected.map((row) => row.id));
	expect(sites.map((row) => row.tests)).toEqual([tests, tests]);
	expect(sites[0]?.site).toEqual(sites[1]?.site);
	expect(result.selected.map((row) => row.testSelection)).toEqual([sha256(JSON.stringify(tests)), sha256(JSON.stringify(tests))]);
	expect(result.selected.map((row) => row.outcome)).toEqual(["survived", "killed"]);
	// Test files are censused, never mutated: only src/a.ts contributes candidates.
	expect(rows(result.report.results)).toHaveLength(3);
	expect(rows(result.report.results).map(record).filter((row) => row.path === "src/a.ts")).toHaveLength(3);
	expect(result.report.counts).toEqual({ killed: 1, survived: 1, noCoverage: 0, invalid: 0, infrastructure: 0, uncompleted: 1 });
	expect(result.report.selectedCounts).toEqual({ killed: 1, survived: 1, noCoverage: 0, invalid: 0, infrastructure: 0, uncompleted: 0 });
	expect(rows(record(result.report.reachMap).runs).map(record).map((run) => run.test)).toEqual([...tests, "src/c.test.ts"]);
	expect(result.report.complete).toBe(true);
	expect(result.report.originalHashesVerified).toBe(true);
	expect(result.report.cleanupVerified).toBe(true);
	expect(readFileSync(join(input.root, "src/a.ts"), "utf8")).toBe(source);
}, 90000);

test("same-line distinct Sites retain independent reach evidence", async () => {
	const input = await fixture(
		"export const run = () => true && false;",
		"expect(run()).toBe(false);",
	);
	const result = await invoke(input, "same-line-distinct-sites", ["--target", "src/a.ts", "--operator", "boolean-literal", "--limit", "2"]);
	expect(result.code).toBe(1);
	expectRestoredResults(result, 2);
	// Reach is campaign-scoped; each mutant has one test process and compiler proof.
	expect(result.selected.map((row) => rows(row.receipts).length)).toEqual([1, 1]);
	expect(result.selected.map((row) => record(row.compilerProof).valid)).toEqual([true, true]);
}, 90000);

test("uninvoked function is noCoverage, not survived", async () => {
	const source = "export const run = () => true;";
	const input = await fixture(
		source,
		'expect(typeof run).toBe("function");',
	);
	const result = await invoke(input, "noCoverage", select("boolean-literal"));
	expect(result.code).toBe(1);
	expect(result.selected[0]?.outcome).toBe("noCoverage");
	expect(result.selected[0]?.receipts).toEqual([]);
	expect(result.selected[0]?.junitReports).toEqual([]);
	expect(result.selected[0]?.restored).toBe(true);
	expect(readFileSync(join(input.root, "src/a.ts"), "utf8")).toBe(source);
}, 90000);

test("red baseline report names nested failures, explains unexplained exits and bounds its summary", () => {
	const exited = { exitCode: 0, signal: null, timedOut: false, overflow: false, stderr: "" };
	const testcase = (name: string, body = "", classname = "") =>
		`<testcase name="${name}" classname="${classname}" time="0.1" file="./src/a.test.ts" line="1" assertions="1"${body ? `>${body}</testcase>` : " />"}`;
	const junit = (cases: string) => `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="bun test" tests="1" failures="1">\n<testsuite name="src/a.test.ts" file="src/a.test.ts">${cases}</testsuite>\n</testsuites>`;
	const explained = describeRedBaseline([{
		junit: junit([
			testcase("first passing"),
			testcase("pending", "<skipped />"),
			testcase("behavior", '<failure type="AssertionError" message="expect(received).toBe(expected)&#10;&#10;Expected: &quot;yes&quot;&#10;Received: &quot;no&quot;">detail</failure>', "outer &gt; inner"),
			testcase("crashes", `<error type="Error" message="${"x".repeat(400)}" />`),
		].join("")),
		failures: 2,
		valid: true,
		process: { ...exited, exitCode: 1 },
	}]);
	expect(explained.lines).toEqual([
		'src/a.test.ts > outer > inner > behavior: expect(received).toBe(expected)  Expected: "yes" Received: "no"',
		`src/a.test.ts > crashes: ${"x".repeat(300)}`,
	]);
	expect(explained.summary).toBe(`baseline test selection is not green: ${explained.lines.join("; ")}`);
	const unexplained = describeRedBaseline([
		{ junit: "", failures: 0, valid: false, process: { ...exited, exitCode: 1, stderr: "src/a.test.ts:\n\n# Unhandled error between tests\nerror: boom at load\n\n 0 pass\n 1 fail\n" } },
		{ junit: junit(testcase("first passing")), failures: 0, valid: true, process: { ...exited, exitCode: 1 } },
		{ junit: "", failures: 0, valid: false, process: { ...exited, exitCode: null, signal: "SIGKILL", timedOut: true, stderr: "hang" } },
	]);
	expect(unexplained.lines).toEqual([
		"process exit=1 signal=null timedOut=false overflow=false junit=invalid: src/a.test.ts: |  | # Unhandled error between tests | error: boom at load |  |  0 pass |  1 fail",
		"process exit=1 signal=null timedOut=false overflow=false junit=valid: ",
		"process exit=null signal=SIGKILL timedOut=true overflow=false junit=invalid: hang",
	]);
	const many = describeRedBaseline([{
		junit: junit([1, 2, 3, 4, 5, 6, 7].map((index) => testcase(`case ${index}`, '<failure type="Error" message="boom" />')).join("")),
		failures: 7,
		valid: true,
		process: { ...exited, exitCode: 1 },
	}]);
	expect(many.lines).toHaveLength(7);
	expect(many.summary).toBe(`baseline test selection is not green: ${many.lines.slice(0, 5).join("; ")} (+2 more)`);
	expect(describeRedBaseline([])).toEqual({ lines: [], summary: "baseline test selection is not green" });
});

test("red baseline names its failing testcases and unexplained process exits", async () => {
	const failing = await fixture("export const run = () => true;", "expect(run()).toBe(false);");
	const assertion = await invoke(failing, "red-baseline-assertion", select("boolean-literal"));
	expect(assertion.code).toBe(2);
	expect(assertion.report.complete).toBe(false);
	expect(assertion.selected.every((row) => row.outcome === "uncompleted")).toBe(true);
	const identity = /^baseline test selection is not green: src\/a\.test\.ts > behavior: expect\(received\)\.toBe\(expected\) /;
	expect(rows(assertion.report.errors)).toEqual([expect.stringMatching(identity)]);
	// The same campaign in process: the red branch of campaign() logs every identity natively.
	const argv = rows(evidence.at(-1)?.argv).map(String).slice(2);
	const { output, restore } = captureOutput();
	const written = spyOn(process.stderr, "write");
	let red: string[] = [];
	try {
		expect(await main(argv)).toBe(2);
		red = written.mock.calls.map((call) => String(call[0])).filter((chunk) => chunk.startsWith("[mutation] baseline red: "));
	} finally {
		restore();
		written.mockRestore();
	}
	const report = record(decode(output.join("")));
	expect(report.complete).toBe(false);
	expect(rows(report.errors)).toEqual([expect.stringMatching(identity)]);
	expect(red).toEqual([
		`[mutation] baseline red: ${String(rows(report.errors)[0]).slice("baseline test selection is not green: ".length)}\n`,
	]);
	const loading = await fixture("export const run = () => true;", "", {
		"src/a.test.ts": 'import {test,expect} from "bun:test"; import {run} from "./a"; if (run()) throw new Error("boom at load"); test("behavior", () => { expect(run()).toBe(true); });',
	});
	const crash = await invoke(loading, "red-baseline-load", select("boolean-literal"));
	expect(crash.code).toBe(2);
	expect(rows(crash.report.errors)).toEqual([
		expect.stringMatching(/^baseline test selection is not green: process exit=1 signal=null timedOut=false overflow=false junit=invalid: .*error: boom at load/),
	]);
}, 90000);

test("compiler rejection stays invalid and cannot make an all-invalid run green", async () => {
	const input = await fixture("export const run = ():true => true;", "expect(run()).toBe(true);");
	const result = await invoke(input, "invalid", select("boolean-literal"));
	expect(result.code).toBe(2);
	expect(result.selected[0]?.outcome).toBe("invalid");
	expect(record(result.report.counts).killed).toBe(0);
	expect(rows(result.selected[0]?.receipts)).toHaveLength(0);
	const proof = record(result.selected[0]?.compilerProof);
	expect(proof.valid).toBe(false);
	expect(rows(proof.diagnostics).length).toBeGreaterThan(0);
	expect(proof.diagnosticsSha256).toBe(sha256(JSON.stringify(proof.diagnostics)));
}, 90000);

test("crash after a successful assertion is infrastructure despite Bun JUnit label", async () => {
	const input = await fixture(
		"export const run = () => true;",
		'expect(1).toBe(1);if(!run())throw new Error("crash-not-assertion");',
	);
	const result = await invoke(input, "crash-after-assertion", select("boolean-literal"));
	expect(result.code).toBe(2);
	expect(result.selected[0]?.outcome).toBe("infrastructure");
	expect(rows(result.selected[0]?.assertionIdentities)).toHaveLength(0);
	expect(result.report.error).toBeUndefined();
	expect(result.selected[0]?.reason).toBe("failure-without-complete-behavioral-assertions");
	const receipt = rows(result.selected[0]?.receipts).map(record).at(-1);
	expect(receipt?.exitCode).toBe(1);
	expect(receipt?.signal).toBeNull();
	expect(receipt?.stderr).toContain("crash-not-assertion");
	expect(receipt?.stderrSha256).toBe(sha256(String(receipt?.stderr)));
}, 90000);

test("GitHub grouped diagnostics preserve kills without promoting crashes", async () => {
	const previous = process.env.GITHUB_ACTIONS;
	process.env.GITHUB_ACTIONS = "true";
	try {
		for (const [assertion, outcome, code] of [
			["expect(run()).toBe(true);", "killed", 0],
			['expect(1).toBe(1);if(!run())throw new Error("crash-not-assertion");', "infrastructure", 2],
		] as const) {
			const input = await fixture("export const run = () => true;", assertion);
			const result = await invoke(input, `github-${outcome}`, select("boolean-literal"));
			expect(result.code).toBe(code);
			expect(result.selected[0]?.outcome).toBe(outcome);
			expect(rows(result.selected[0]?.assertionIdentities)).toHaveLength(code === 0 ? 1 : 0);
		}
	} finally {
		if (previous === undefined) delete process.env.GITHUB_ACTIONS;
		else process.env.GITHUB_ACTIONS = previous;
	}
}, 90000);

for (const hasPrlimit of [true, false]) {
	test(`campaign checks ${hasPrlimit ? "prlimit" : "ulimit"} once and wraps only mutant test commands`, async () => {
		const input = await fixture("export const run = () => true && true;", "expect(run()).toBe(true);");
		type Call = { argv: string[]; cwd: string; timeout: number; stage: string | undefined };
		const calls: Call[] = [];
		const prefix = hasPrlimit ? ["prlimit", "--as=6442450944", "--"] : ["sh", "-c", 'ulimit -v 6291456 && exec "$@"', "sh"];
		const runtime: TestRuntime = {
			platform: "linux", hasPrlimit,
			execute: async (argv: string[], cwd: string, timeout: number, environment?: Record<string, string>, stage?: string) => {
				calls.push({ argv, cwd, timeout, stage });
				// Capture the real Linux argv, but run its Bun payload on this host.
				const payload = argv[0] === process.execPath ? argv : argv.slice(prefix.length);
				return execute(payload, cwd, timeout, environment, stage);
			},
		};
		// The campaign baseline runs this suite from an execution copy whose path
		// ends in /baseline; the startup self-check inherits that cwd, so a cwd
		// suffix alone must not be mistaken for a second baseline selection.
		const parent = join(input.root, "baseline");
		mkdirSync(parent, { recursive: true });
		const originalCwd = process.cwd();
		let report: RecordValue;
		try {
			process.chdir(parent);
			report = await runMain(input, process.env.D945_PYTHON ?? "python3", ["--target", "src/a.ts", "--operator", "boolean-literal", "--limit", "2"], 0, runtime);
		} finally {
			process.chdir(originalCwd);
		}
		expect(report.complete).toBe(true);
		const checks = calls.filter((call: Call) => call.stage === "mutant-memory-cap-self-check");
		expect(checks).toHaveLength(1);
		expect(calls[0]).toBe(checks[0]);
		expect(checks[0]?.cwd).toBe(realpathSync(parent));
		expect(checks[0]?.argv).toEqual([...prefix, process.execPath, "--smol", "-e", "process.stdout.write('cap-ok')"]);
		const testCalls = calls.filter((call: Call) => call.stage !== "mutant-memory-cap-self-check");
		expect(testCalls).toHaveLength(4);
		for (const phase of ["baseline", "reach"]) {
			const selection = testCalls.filter((call: Call) => call.cwd.endsWith(`/${phase}`));
			expect(selection).toHaveLength(1);
			expect(selection[0]?.argv.slice(0, 3)).toEqual([process.execPath, "--smol", "test"]);
			expect(selection[0]?.timeout).toBe(SELECTION_SUITE_TIMEOUT_MS);
		}
		const mutants = testCalls.filter((call: Call) => call.cwd.endsWith("/candidate/source"));
		expect(mutants).toHaveLength(2);
		for (const mutant of mutants) {
			expect(mutant.argv.slice(0, prefix.length + 3)).toEqual([...prefix, process.execPath, "--smol", "test"]);
			expect(mutant.timeout).toBe(15_000);
		}
	}, 120000);
}

test("campaign fails closed with wrapper stderr before any mutant can be scored", async () => {
	const input = await fixture("export const run = () => true;", "expect(run()).toBe(true);");
	const stages: (string | undefined)[] = [];
	const stderr = "prlimit: failed to set the AS resource limit: Operation not permitted";
	const runtime: TestRuntime = {
		platform: "linux", hasPrlimit: true,
		execute: async (argv, _cwd, _timeout, _environment, stage) => {
			stages.push(stage);
			return processFixture({ argv, stage: stage ?? "process", exitCode: 1, stdout: "", stderr });
		},
	};
	const report = await runMain(input, process.env.D945_PYTHON ?? "python3", select("boolean-literal"), 2, runtime);
	expect(stages).toEqual(["mutant-memory-cap-self-check"]);
	expect(report.complete).toBe(false);
	expect(report.results).toBeUndefined();
	expect(record(report.error).code).toBe("infrastructure");
	expect(record(report.error).message).toContain(stderr);
	expect(record(record(report.error).process).stderr).toBe(stderr);
}, 120000);

for (const mode of ["timeout", "crash"] as const) {
	test(`original Python probe ${mode} remains infrastructure without executing the mutant`, async () => {
		const input = await fixture("export const run = () => true;", "expect(run()).toBe(true);", {
			"src/calc.py": "def f(value):\n    return value + 1\n",
			"src/calc.test.ts": 'import { expect, test } from "bun:test"; test("calc", () => { const result = Bun.spawnSync([process.env.D945_PYTHON!, "-c", "import sys;sys.path.insert(0, \'src\');import calc;print(calc.f(2))"]); expect(result.stdout.toString().trim()).toBe("3"); expect(result.exitCode).toBe(0); });',
		});
		let probes = 0;
		const runtime: TestRuntime = {
			platform: "darwin", hasPrlimit: false,
			execute: async (argv, cwd, timeout, environment, stage) => {
				if (!cwd.endsWith("/candidate/source")) return execute(argv, cwd, timeout, environment, stage);
				probes++;
				expect(readFileSync(join(cwd, "src/calc.py"), "utf8")).not.toBe(input.files["src/calc.py"]);
				return processFixture({ argv, stdout: "", exitCode: null, signal: "SIGKILL", timedOut: mode === "timeout" });
			},
		};
		const report = await runMain(input, process.env.D945_PYTHON ?? "python3", ["--target", "src/calc.py", "--operator", "py-number", "--limit", "1"], 2, runtime);
		const result = reportResults(report)[0];
		expect(probes).toBe(1);
		expect([result?.outcome, result?.reason]).toEqual(["infrastructure", "baseline-probe-not-green"]);
		expect(result?.coverage).toBeNull();
		expect(result?.restored).toBe(true);
		expect(rows(result?.receipts).map(record).some((receipt) => receipt.stage === "python-probe")).toBe(true);
		expect(report.complete).toBe(false);
		expect(report.cleanupVerified).toBe(true);
	}, 120000);
}

test("crashed mutant child without JUnit is killed and campaign cleanup completes", async () => {
	const input = await fixture(
		"export const run = () => true;",
		'if(!run())process.kill(process.pid,"SIGABRT");expect(run()).toBe(true);',
	);
	const result = await invoke(input, "resource-exhaustion", select("boolean-literal"));
	expect(result.code).toBe(0);
	expect(result.report.complete).toBe(true);
	expect(result.report.originalHashesVerified).toBe(true);
	expect(result.report.cleanupVerified).toBe(true);
	expect(result.selected[0]?.outcome).toBe("killed");
	expect(result.selected[0]?.reason).toBe("resource-exhaustion");
	expect(result.selected[0]?.restored).toBe(true);
	const receipt = rows(result.selected[0]?.receipts).map(record).at(-1);
	expect(receipt?.signal).toBe("SIGABRT");
	expect(receipt?.timedOut).toBe(false);
}, 90000);

test("bounded mutant hang is killed by suite timeout, not infrastructure", async () => {
	const input = await fixture(
		"export const run = () => true;",
		"if(!run()){while(true){}}expect(run()).toBe(true);",
	);
	const result = await invoke(input, "timeout", select("boolean-literal"));
	expect(result.code).toBe(0);
	expect(result.report.complete).toBe(true);
	expect(result.selected[0]?.outcome).toBe("killed");
	expect(result.selected[0]?.typecheck).toBe("valid");
	expect(result.selected[0]?.reason).toBe("suite-timeout");
	expect(rows(result.selected[0]?.receipts).map(record).at(-1)?.timedOut).toBe(true);
}, 90000);

test("test, fixture and benchmark files are censused but never mutated", async () => {
	const input = await fixture("export const run = () => true;", "expect(run()).toBe(true);", {
		"src/fixtures/data.ts": "export const value = 1 + 2;",
		"src/a.bench.ts": "export const bench = () => 1 + 2;",
	});
	const result = await invoke(input, "universe");
	const census = new Map(rows(result.report.census).map(record).map((row) => [row.path, row]));
	for (const path of ["src/a.test.ts", "src/fixtures/data.ts", "src/a.bench.ts"]) {
		expect(census.get(path)?.category).not.toBe("production");
		expect(census.get(path)?.syntax).toBe("outside-executable-TS-JS-contract");
		expect(result.selected.some((row) => row.path === path)).toBe(false);
	}
	expect(census.get("src/a.ts")?.syntax).toBe("parsed");
	expect(result.selected.some((row) => row.path === "src/a.ts")).toBe(true);
}, 90000);

test("exhausted budget accounts every candidate as uncompleted", async () => {
	const input = await fixture("export const run = () => true;", "expect(run()).toBe(true);");
	const result = await invoke(input, "budget", ["--budget", "1"]);
	expect(result.code).toBe(2);
	expect(result.report.complete).toBe(false);
	expect(result.selected.every((row) => row.outcome === "uncompleted")).toBe(true);
	expect(result.selected.length).toBeGreaterThan(0);
}, 90000);

test("a candidate whose worst-case run cannot finish inside the budget is not dispatched", async () => {
	// Setup takes seconds, so a ten-minute budget is far from exhausted when the
	// first candidate is considered; its reserve (one compiler batch plus one
	// test run capped by the sixty-minute suite timeout) is what cannot fit.
	const input = await fixture("export const run = () => true;", "expect(run()).toBe(true);");
	const result = await invoke(input, "budget-reserve", ["--budget", "600000", "--suite-timeout", "3600000"]);
	expect(result.code).toBe(2);
	expect(result.report.complete).toBe(false);
	expect(result.selected.length).toBeGreaterThan(0);
	expect(result.selected.every((row) => row.outcome === "uncompleted")).toBe(true);
}, 90000);

test("in-process shard executes candidates when their reserve fits the budget", async () => {
	const input = await fixture("export const run = () => true;", "expect(run()).toBe(true);");
	const progress = join(input.root, "shard-progress.jsonl");
	const report = await runMain(input, process.env.D945_PYTHON ?? "python3", [
		"--shard", "0", "--shard-count", "1", "--progress", progress,
	], 0);
	const shard = record(report.shard);
	expect(shard.budgetExhausted).toBe(false);
	expect(shard.executed).toBe(1);
	expect(shard.recorded).toBe(1);
	expect(report.cleanupVerified).toBe(true);
}, 120000);

test("in-process shard budget defers multiple candidates with one diagnostic", async () => {
	const input = await fixture("export const run = () => true && false;", "expect(run()).toBe(false);");
	const progress = join(input.root, "shard-progress.jsonl");
	const stderr = captureError();
	try {
		const report = await runMain(input, process.env.D945_PYTHON ?? "python3", [
			"--shard", "0", "--shard-count", "1", "--progress", progress,
			"--budget", "600000", "--suite-timeout", "3600000",
		]);
		const shard = record(report.shard);
		expect(shard.budgetExhausted).toBe(true);
		expect(Number(shard.sliceSize)).toBeGreaterThanOrEqual(2);
		expect(shard.recorded).toBe(0);
		expect(shard.executed).toBe(0);
		expect(shard.sliceComplete).toBe(false);
		expect(stderr.output.filter((line) => line.includes("[mutation] shard 0/1 deferring "))).toHaveLength(1);
		expect(stderr.output).toContain(`[mutation] shard 0/1 deferred ${shard.sliceSize} of ${shard.sliceSize} pending candidates to the next run`);
		const progressRows = readFileSync(progress, "utf8").trim().split("\n").map((line) => record(decode(line)));
		expect(progressRows[0]?.type).toBe("shard-progress");
		expect(progressRows.at(-1)?.type).toBe("proof");
		expect(progressRows.filter((row) => row.type === "result")).toHaveLength(0);
	} finally {
		stderr.restore();
	}
}, 120000);

test("work budget cannot silently turn an unfinished full run into a selected pass", async () => {
	// Two production candidates (both boolean literals) so a budget of one leaves work behind.
	const input = await fixture("export const run = () => true && false;", "expect(run()).toBe(false);");
	const result = await invoke(input, "max-candidates", ["--max-candidates", "1"]);
	expect(result.code).toBe(2);
	expect(result.selected.length).toBeGreaterThan(1);
	expect(result.selected.filter((row) => row.outcome !== "uncompleted")).toHaveLength(1);
	expect(result.report.full).toBe(false);
}, 90000);

test("a same-name replacement contract cannot weaken the frozen operators", async () => {
	const input = await fixture("export const run = () => true;", "expect(run()).toBe(true);");
	const changed = record(decode(readFileSync(decision, "utf8")));
	const contract = record(changed.contract);
	const mutation = record(contract.mutation);
	const operators = rows(mutation.operators).map((value, index) =>
		index === 0 ? { ...record(value), replacements: { true: ["true"], false: ["false"] } } : value,
	);
	const path = join(input.root, "changed-decision.json");
	writeFileSync(
		path,
		JSON.stringify({ ...changed, contract: { ...contract, mutation: { ...mutation, operators } } }),
	);
	const result = await invoke(input, "weakened-operators", select("boolean-literal"), [
		"--decision",
		path,
		"--decision-sha256",
		sha256(readFileSync(path)),
	]);
	expect(result.code).toBe(2);
	expect(record(result.report.error).code).toBe("operatorContract");
}, 90000);

test("JSON schema errors do not reach test execution", async () => {
	const input = await fixture("export const run = () => true;", "expect(run()).toBe(true);");
	writeFileSync(input.inventory, '{"version":2}');
	const result = await invoke(input, "invalid-schema", select("boolean-literal"));
	expect(result.code).toBe(2);
	expect(record(result.report.error).code).toBe("schema");
}, 90000);

test("candidate identity and AST census are deterministic across isolated copies", async () => {
	const input = await fixture("export const run = () => true;", "expect(run()).toBe(true);");
	const first = await invoke(input, "determinism-first", select("boolean-literal"));
	const second = await invoke(input, "determinism-second", select("boolean-literal"));
	expect(first.code).toBe(0);
	expect(second.code).toBe(0);
	const identity = (row: RecordValue) => ({
		id: row.id,
		path: row.path,
		start: row.startOffset,
		end: row.endOffset,
		operator: row.operator,
		replacement: row.replacement,
		outcome: row.outcome,
	});
	expect(first.selected.map(identity)).toEqual(second.selected.map(identity));
	expect(first.report.census).toEqual(second.report.census);
	expect(first.report.executionTreeSha256).toBe(second.report.executionTreeSha256);
}, 90000);

test("probe side effects cannot contaminate the fresh mutation copy", async () => {
	const input = await fixture(
		"export const run = (n:number) => n+1;",
		'const fs=await import("node:fs");if(fs.existsSync("state"))throw new Error("leaked-state");fs.writeFileSync("state","created");expect(run(1)).toBe(2);',
	);
	const result = await invoke(input, "isolated-snapshots", select("arithmetic"));
	expect(result.code).toBe(0);
	expect(result.selected[0]?.outcome).toBe("killed");
	expect(existsSync(join(input.root, "state"))).toBe(false);
}, 90000);

test("frozen inventory omission is an analysis error from canonical verifier", async () => {
	const input = await fixture("export const run = () => true;", "expect(run()).toBe(true);");
	writeFileSync(join(input.root, "src/unlisted.ts"), "export const omitted = 3;");
	const result = await invoke(input, "incomplete-inventory", select("boolean-literal"));
	expect(result.code).toBe(2);
	expect(record(result.report.error).code).toBe("incompleteInventory");
}, 90000);

test("tampered frozen input cannot pass with stale hash", async () => {
	const input = await fixture("export const run = () => true;", "expect(run()).toBe(true);");
	const result = await invoke(input, "tamper", select("boolean-literal"), [
		"--inventory-sha256",
		"0".repeat(64),
	]);
	expect(result.code).toBe(2);
	expect(record(result.report.error).code).toBe("tamper");
}, 90000);

test("malformed Python input remains enumerated and blocks execution", async () => {
	const input = await fixture("export const run = () => true;", "expect(run()).toBe(true);", {
		"src/driver.py": "def run(:\n    return True\n",
	});
	const result = await invoke(input, "malformed-python", select("boolean-literal"));
	expect(result.code).toBe(2);
	expect(
		rows(result.report.census)
			.map(record)
			.find((row) => row.path === "src/driver.py")?.syntax,
	).toBe("python-analysis-error");
	expect(result.report.full).toBe(false);
}, 90000);

test("invalid TS syntax does not become a behavioral kill", async () => {
	const input = await fixture("export const run = ( => true;", "expect(run()).toBe(true);");
	const result = await invoke(input, "unsupported-ts-syntax", select("boolean-literal"));
	expect(result.code).toBe(2);
	expect(
		rows(result.report.census)
			.map(record)
			.find((row) => row.path === "src/a.ts")?.syntax,
	).toBe("unsupportedSyntax");
}, 90000);

test("missing CLI input and baseline growth flags are analysis errors", async () => {
	for (const args of [[], ["--update", "true"]]) {
		const result = await execute([process.execPath, runner, ...args], import.meta.dir, 15000);
		const report = record(decode(result.stdout));
		expect(result.exitCode).toBe(2);
		expect(report.complete).toBe(false);
		evidence.push({
			name: args.length ? "reject-update" : "missing-input",
			exitCode: result.exitCode,
			error: report.error ?? null,
		});
	}
});

test("typed JSON boundary rejects executable syntax and duplicate keys", () => {
	for (const value of ['{"a":true,"a":false}', '{"a":undefined}', '{"a":()=>1}'])
		expect(() => decode(value)).toThrow();
	expect(decode('{"a":[true,null,-2,"unknown any"]}')).toEqual({
		a: [true, null, -2, "unknown any"],
	});
});

for (const assertion of [
	'await expect(run()?Promise.reject(new Error("expected")):Promise.resolve(3)).rejects.toBeInstanceOf(Error);',
	'await expect(run()?Promise.resolve(3):Promise.reject(new Error("mutated"))).resolves.toBe(3);',
])
	test("wrong promise settlement is a genuine assertion failure", async () => {
		const input = await fixture("export const run=()=>true;", assertion);
		const result = await invoke(input, "promise-settlement", select("boolean-literal"));
		assertBehavioralKill(result);
	}, 90000);

test("passing self-closing JUnit cases cannot steal a grouped failure identity", async () => {
	const input = await fixture("export const run=()=>true;", "", {
		"src/a.test.ts":
			'import {describe,test,expect} from "bun:test";import {run} from "./a";test("first passing",()=>{expect(1).toBe(1);});describe("group",()=>{test("behavior",()=>{expect(run()).not.toBe(false);});});',
	});
	const result = await invoke(input, "grouped-negated", select("boolean-literal"));
	expect(result.code).toBe(0);
	const identities = rows(result.selected[0]?.assertionIdentities);
	expect(identities).toHaveLength(1);
	expect(record(decode(String(identities[0]))).name).toBe("behavior");
}, 90000);

test("canonical TS and JS outside native includes get inventory fallback ownership", async () => {
	const input = await fixture("export const run=()=>true;", "expect(run()).toBe(true);", {
		"src/excluded/loose.ts": "export const loose=()=>true;",
		"src/excluded/loose.js": "export const loose=()=>true;",
	});
	const config = join(input.root, "src/tsconfig.json");
	writeFileSync(
		config,
		JSON.stringify({ ...record(decode(readFileSync(config, "utf8"))), exclude: ["excluded"] }),
	);
	const generated = await execute(
		[process.execPath, tool, "--root", input.root, "--contract", join(input.root, "contract.json")],
		input.root,
		15000,
	);
	expect(generated.exitCode).toBe(0);
	writeFileSync(input.inventory, generated.stdout);
	const result = await invoke(input, "inventory-fallback", select("boolean-literal"));
	expect(result.code).toBe(0);
	for (const path of ["src/excluded/loose.ts", "src/excluded/loose.js"]) {
		const row = rows(result.report.census)
			.map(record)
			.find((item) => item.path === path);
		expect(row?.syntax).toBe("parsed");
		expect(
			rows(row?.operators)
				.map(record)
				.find((op) => op.operator === "boolean-literal")?.candidates,
		).toBe(1);
	}
}, 90000);

test("assertion identity cannot credit another testcase's crash", async () => {
	const input = await fixture("export const run=()=>true;", "expect(run()).not.toBe(false);", {
		"src/crash.test.ts":
			'import {test,expect} from "bun:test";import {run} from "./a";test("separate crash",()=>{expect(1).toBe(1);if(!run())throw new Error("crash");});',
	});
	const result = await invoke(input, "mixed-assertion-crash", select("boolean-literal"));
	expect(result.code).toBe(2);
	expect(result.selected[0]?.outcome).toBe("infrastructure");
}, 90000);

test("missing executable reports infrastructure without leaking resources", async () => {
	const result = await execute(["/not/a/real/executable"], import.meta.dir, 1000);
	expect(result.spawnError).toBe(true);
	expect(result.exitCode).not.toBe(0);
	expect(result.timedOut).toBe(false);
	expect(existsSync("/not/a/real/executable")).toBe(false);
});

const pythonEntry =
	'export async function run(){const child=Bun.spawn(["python3","src/driver.py"],{stdout:"pipe",stderr:"pipe"}); const output=await new Response(child.stdout).text(); const error=await new Response(child.stderr).text(); const exit=await child.exited; if(exit!==0)throw new Error(error); return output.trim();}';
const pythonFamilies = [
	{ id: "py-boolean", code: "print(True)", output: "True" },
	{ id: "py-equality", code: "print(1 == 1)", output: "True" },
	{ id: "py-relational", code: "print(1 < 1)", output: "False" },
	{ id: "py-arithmetic", code: "print(2 + 1)", output: "3" },
	{ id: "py-logical", code: "print(True and False)", output: "False" },
	{ id: "py-unary", code: "print(not True)", output: "False" },
	{ id: "py-number", code: "print(42)", output: "42" },
	{ id: "py-string", code: "print('hello')", output: "hello" },
	{ id: "py-condition", code: "print(1 if 1 else 2)", output: "1" },
	{ id: "py-expression-delete", code: "print('hello')", output: "hello" },
	{ id: "py-return", code: "def run():\n    return 42\nprint(run())", output: "42" },
	{
		id: "py-raise",
		code: "try:\n    raise ValueError('boom')\nexcept ValueError:\n    print('raised')",
		output: "raised",
	},
	{ id: "py-container", code: "print([1, 2])", output: "[1, 2]" },
	{
		id: "py-assert",
		code: "try:\n    assert False\nexcept AssertionError:\n    print('asserted')",
		output: "asserted",
	},
	{
		id: "py-await",
		code: "import asyncio\nasync def inner():\n    return 3\nasync def run():\n    result = await inner()\n    return type(result).__name__\nprint(asyncio.run(run()))",
		output: "int",
	},
];
for (const family of pythonFamilies)
	test(`real Python operator seam: ${family.id}`, async () => {
		const input = await fixture(
			pythonEntry,
			`expect(await run()).toBe(${JSON.stringify(family.output)});`,
			{ "src/driver.py": `${family.code}\n` },
		);
		const result = await invoke(input, family.id, [
			"--target",
			"src/driver.py",
			"--operator",
			family.id,
			"--limit",
			"1",
		]);
		expect(result.code).toBe(0);
		expect(result.selected).toHaveLength(1);
		expect(result.selected[0]?.outcome).toBe("killed");
		expect(result.selected[0]?.restored).toBe(true);
		expect(rows(result.selected[0]?.assertionIdentities)).toHaveLength(1);
		const census = rows(result.report.census)
			.map(record)
			.find((row) => row.path === "src/driver.py");
		expect(census?.syntax).toBe("parsed");
		expect(rows(census?.operators)).toHaveLength(15);
		const candidates = rows(result.report.results)
			.map(record)
			.filter((row) => row.path === "src/driver.py");
		const count = rows(census?.operators)
			.map(record)
			.reduce((total, row) => total + Number(row.candidates), 0);
		expect(candidates).toHaveLength(count);
		expect(record(result.report.pythonCapability).implemented).toBe(true);
		expect(result.report.originalHashesVerified).toBe(true);
		expect(result.report.cleanupVerified).toBe(true);
	}, 90000);

for (const fixtureCase of [
	{
		name: "python-survivor",
		source: "print(True)\n",
		assertion: 'expect(typeof await run()).toBe("string");',
		code: 1,
		outcome: "survived",
	},
	{
		name: "python-noCoverage",
		source: "def dormant():\n    return True\nprint('ready')\n",
		assertion: 'expect(await run()).toBe("ready");',
		code: 1,
		outcome: "noCoverage",
	},
	{
		name: "python-crash",
		source: "if not True:\n    raise RuntimeError('mutated')\nprint('ready')\n",
		assertion: 'expect(await run()).toBe("ready");',
		code: 2,
		outcome: "infrastructure",
	},
])
	test(`real Python outcome: ${fixtureCase.name}`, async () => {
		const input = await fixture(pythonEntry, fixtureCase.assertion, {
			"src/driver.py": fixtureCase.source,
		});
		const result = await invoke(input, fixtureCase.name, [
			"--target",
			"src/driver.py",
			"--operator",
			"py-boolean",
			"--limit",
			"1",
		]);
		expect(result.code).toBe(fixtureCase.code);
		expect(result.selected[0]?.outcome).toBe(fixtureCase.outcome);
	}, 90000);

test("missing Python runtime never becomes a zero-candidate pass", async () => {
	const input = await fixture(pythonEntry, 'expect(await run()).toBe("True");', {
		"src/driver.py": "print(True)\n",
	});
	const result = await invoke(input, "missing-python-runtime", select("boolean-literal"), [
		"--python",
		"/not/a/python",
	]);
	expect(result.code).toBe(2);
	expect(result.report.complete).toBe(false);
}, 90000);

for (const example of [
	{
		name: "R2-1 precedence",
		source: "print(~(1 + 2) * 0)\n",
		mutant: "print((1 + 2) * 0)\n",
		operator: "py-unary",
		output: "0",
		mutatedOutput: "0",
		outcome: "survived",
		exit: 1,
	},
	{
		name: "R2-2 literal pattern",
		source: "value = int('1')\nmatch value:\n    case 1:\n        print('one')\n",
		mutant: "value = int('1')\nmatch value:\n    case 0:\n        print('one')\n",
		operator: "py-number",
		output: "one",
		mutatedOutput: "",
		outcome: "killed",
		exit: 0,
	},
	{
		name: "pattern singleton",
		source: "value = bool('yes')\nmatch value:\n    case True:\n        print('one')\n",
		mutant: "value = bool('yes')\nmatch value:\n    case False:\n        print('one')\n",
		operator: "py-boolean",
		output: "one",
		mutatedOutput: "",
		outcome: "killed",
		exit: 0,
	},
	{
		name: "pattern mapping key",
		source: "value = {int('1'): 'value'}\nmatch value:\n    case {1: x}:\n        print(x)\n",
		mutant: "value = {int('1'): 'value'}\nmatch value:\n    case {0: x}:\n        print(x)\n",
		operator: "py-number",
		output: "value",
		mutatedOutput: "",
		outcome: "killed",
		exit: 0,
	},
	{
		name: "pattern sequence",
		source: "value = [int('1')]\nmatch value:\n    case [1]:\n        print('one')\n",
		mutant: "value = [int('1')]\nmatch value:\n    case [0]:\n        print('one')\n",
		operator: "py-number",
		output: "one",
		mutatedOutput: "",
		outcome: "killed",
		exit: 0,
	},
	{
		name: "pattern signed literal",
		source: "value = int('-1')\nmatch value:\n    case -1:\n        print('one')\n",
		mutant: "value = int('-1')\nmatch value:\n    case -0:\n        print('one')\n",
		operator: "py-number",
		output: "one",
		mutatedOutput: "",
		outcome: "killed",
		exit: 0,
	},
	{
		name: "pattern unreached later case",
		source:
			"value = 'first'\nmatch value:\n    case 'first':\n        print('first')\n    case 1:\n        print('one')\n",
		mutant:
			"value = 'first'\nmatch value:\n    case 'first':\n        print('first')\n    case 0:\n        print('one')\n",
		operator: "py-number",
		output: "first",
		mutatedOutput: "first",
		outcome: "noCoverage",
		exit: 1,
	},
])
	test(`review R2 counterexample: ${example.name}`, async () => {
		const input = await fixture(
			pythonEntry,
			`expect(await run()).toBe(${JSON.stringify(example.output)});`,
			{
				"src/driver.py": example.source,
			},
		);
		for (const [program, output] of [
			[example.source, example.output],
			[example.mutant, example.mutatedOutput],
		]) {
			if (program === undefined || output === undefined)
				throw new FixtureError("Missing native control");
			const native = await execute(
				[process.env.QUALITY_MUTATION_PYTHON ?? process.env.D945_PYTHON ?? "python3", "-c", program],
				input.root,
				15000,
			);
			expect(native.exitCode).toBe(0);
			expect(native.stdout.trim()).toBe(output);
			evidence.push({ name: `${example.name}: independent native control`, program, ...native });
		}
		const result = await invoke(input, example.name, [
			"--target",
			"src/driver.py",
			"--operator",
			example.operator,
		]);
		expect(result.code).toBe(example.exit);
		expect(result.selected).toHaveLength(1);
		expect(result.selected[0]?.outcome).toBe(example.outcome);
		expect(rows(result.selected[0]?.assertionIdentities)).toHaveLength(
			example.outcome === "killed" ? 1 : 0,
		);
		expect(result.report.originalHashesVerified).toBe(true);
		expect(result.report.cleanupVerified).toBe(true);
	}, 90000);
}
