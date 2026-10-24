import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { decodeOverlay, encodeOverlay, installOverlay, OVERLAY_ENVIRONMENT, reachPlugin, type ReachOverlay, stagePreload } from "./quality-mutation-reach-overlay";
import { instrument, sha256, stageMacroPreload } from "./run-quality-mutations";
import { parseNativeLcov } from "./quality-native-lcov";

const OVERLAY_MODULE = join(import.meta.dir, "quality-mutation-reach-overlay.ts");

function coverageSources(root: string, preload: string): string[] {
	const run = Bun.spawnSync([process.execPath, "test", "./script/s.test.ts", "--coverage", "--coverage-reporter=lcov", "--coverage-dir=native"], {
		cwd: root, timeout: 30_000, env: { ...process.env, BUN_OPTIONS: `--preload=${preload}` }, stdout: "pipe", stderr: "pipe",
	});
	if (run.exitCode !== 0) throw new Error(run.stderr.toString());
	return readFileSync(join(root, "native/lcov.info"), "utf8").split("\n").filter((line) => line.startsWith("SF:")).map((line) => line.slice(3)).sort();
}

test("a fixture child measuring its own coverage never records the staged reach preload", () => {
	const temporary = mkdtempSync(join(tmpdir(), "omo-reach-preload-"));
	const root = join(temporary, "fixture");
	mkdirSync(join(root, "script"), { recursive: true });
	writeFileSync(join(root, "script/s.ts"), "export const f = () => 1;\n");
	writeFileSync(join(root, "script/s.test.ts"), 'import { expect, test } from "bun:test"; import { f } from "./s"; test("f", () => expect(f()).toBe(1));\n');
	const staged = stagePreload(temporary);
	expect(staged).toBe(join(temporary, "node_modules", ".quality-mutation-reach", "overlay.ts"));
	expect(readFileSync(staged, "utf8")).toBe(readFileSync(OVERLAY_MODULE, "utf8"));
	const unstaged = coverageSources(root, OVERLAY_MODULE);
	expect(unstaged).toContain("script/s.ts");
	expect(unstaged.some((path) => path.startsWith("../"))).toBe(true);
	expect(coverageSources(root, staged)).toEqual(["script/s.ts"]);
});

type Load = (args: { path: string }) => { contents: string; loader: string };

test("reach overlay serves instrumented twins by resolved path and leaves the copy bytes alone", async () => {
	const root = mkdtempSync(join(tmpdir(), "omo-reach-overlay-"));
	const overlay: ReachOverlay = { root, instrumented: join(root, ".inst"), paths: ["src/a.ts", "src/b.mjs"] };
	mkdirSync(join(root, "src"), { recursive: true });
	mkdirSync(join(overlay.instrumented, "src"), { recursive: true });
	for (const path of overlay.paths) {
		writeFileSync(join(root, path), `export const original = ${JSON.stringify(path)};`);
		writeFileSync(join(overlay.instrumented, path), `export const probed = ${JSON.stringify(path)};`);
	}
	expect(decodeOverlay(encodeOverlay(overlay))).toEqual(overlay);
	expect(decodeOverlay(`${root}\n${overlay.instrumented}\n`).paths).toEqual([]);
	const loads: { filter: RegExp; load: Load }[] = [];
	reachPlugin(overlay).setup({ onLoad: (options: { filter: RegExp }, load: Load) => loads.push({ filter: options.filter, load }) } as never);
	const [registered] = loads;
	if (!registered) throw new Error("onLoad not registered");
	const resolved = realpathSync(root);
	expect(registered.filter.test(join(resolved, "src/a.ts"))).toBe(true);
	expect(registered.filter.test(join(resolved, "src/a.test.ts"))).toBe(false);
	expect(registered.filter.test(join(resolved, "src/c.ts"))).toBe(false);
	expect(registered.load({ path: join(resolved, "src/a.ts") })).toEqual({ contents: 'export const probed = "src/a.ts";', loader: "ts" });
	expect(registered.load({ path: join(resolved, "src/b.mjs") })).toEqual({ contents: 'export const probed = "src/b.mjs";', loader: "js" });
	expect(await Bun.file(join(root, "src/a.ts")).text()).toBe('export const original = "src/a.ts";');

	const installed: string[] = [];
	const register = (plugin: { name: string }) => installed.push(plugin.name);
	expect(installOverlay({}, register)).toEqual([]);
	const emptyPath = join(root, "empty.overlay");
	writeFileSync(emptyPath, encodeOverlay({ ...overlay, paths: [] }));
	expect(installOverlay({ [OVERLAY_ENVIRONMENT]: emptyPath }, register)).toEqual([]);
	expect(installed).toEqual([]);
	const overlayPath = join(root, "reach.overlay");
	writeFileSync(overlayPath, encodeOverlay(overlay));
	expect(installOverlay({ [OVERLAY_ENVIRONMENT]: overlayPath }, register)).toEqual(overlay.paths);
	expect(installed).toEqual(["quality-mutation-reach"]);
});

test.each([
	{
		name: "named import",
		source: 'import { inline } from "./macro" with { type: "macro" };\nexport const run = inline("fixture") + 42;\n',
		argument: '"fixture"', dependency: "", shadow: "",
	},
	{
		name: "default import",
		source: 'import inline from "./macro" with { type: "macro" };\nexport const run = inline("fixture") + 42;\n',
		argument: '"fixture"', dependency: "", shadow: "",
	},
	{
		name: "namespace import",
		source: 'import * as macros from "./macro" with { type: "macro" };\nexport const run = macros.inline("fixture") + 42;\n',
		argument: '"fixture"', dependency: "", shadow: "",
	},
	{
		name: "parenthesized callee",
		source: 'import { inline } from "./macro" with { type: "macro" };\nexport const run = (inline)("fixture") + 42;\n',
		argument: '"fixture"', dependency: "", shadow: "",
	},
	{
		name: "non-null callee",
		source: 'import { inline } from "./macro" with { type: "macro" };\nexport const run = inline!("fixture") + 42;\n',
		argument: '"fixture"', dependency: "", shadow: "",
	},
	{
		name: "compile-time argument dependency",
		source: 'import { inline } from "./macro" with { type: "macro" };\nconst value = "fixture";\nexport const run = inline(value) + 42;\n',
		argument: "value", dependency: '"fixture"', shadow: "",
	},
	{
		name: "shadowed ordinary callee",
		source: 'import { inline } from "./macro" with { type: "macro" };\nexport const run = inline("fixture") + 42;\nexport const shadow = (inline: (value: string) => string) => inline("runtime");\n',
		argument: '"fixture"', dependency: "", shadow: '"runtime"',
	},
])("macro imports load under the instrumented reach overlay: $name", ({ source, argument, dependency, shadow }) => {
	const temporary = mkdtempSync(join(tmpdir(), "omo-reach-macro-"));
	try {
		const root = join(temporary, "fixture");
		const path = "src/a.ts";
		const marker = join(temporary, "ordinary");
		const overlay: ReachOverlay = { root, instrumented: join(temporary, "instrumented"), paths: [path] };
		mkdirSync(join(root, "src"), { recursive: true });
		mkdirSync(join(overlay.instrumented, "src"), { recursive: true });
		writeFileSync(join(root, path), source);
		writeFileSync(join(root, "src/macro.ts"), 'export function inline(value: string): string { return value; }\nexport default inline;\n');
		writeFileSync(join(root, "src/a.test.ts"), `import { expect, test } from "bun:test"; import { run${shadow ? ", shadow" : ""} } from "./a"; test("macro", () => { expect(run).toBe("fixture42"); ${shadow ? 'expect(shadow((value) => value)).toBe("runtime");' : ""} });\n`);
		const start = source.indexOf(argument, source.indexOf("export const run"));
		const site = (id: string, offset: number, length: number) => ({
			id, path, sourceSha256: sha256(source),
			site: { start: offset, end: offset + length, mode: "expression" as const }, tests: [],
		});
		writeFileSync(join(overlay.instrumented, path), instrument(source, [
			site("macro", start, argument.length),
			site("ordinary", source.indexOf("42"), 2),
			...(dependency ? [site("dependency", source.indexOf(dependency), dependency.length)] : []),
			...(shadow ? [site("shadow", source.indexOf(shadow), shadow.length)] : []),
		], temporary));
		const overlayPath = join(temporary, "overlay.txt");
		writeFileSync(overlayPath, encodeOverlay(overlay));
		const run = Bun.spawnSync([process.execPath, "test", "./src/a.test.ts"], {
			cwd: root, timeout: 15_000,
			env: { ...process.env, [OVERLAY_ENVIRONMENT]: overlayPath, BUN_OPTIONS: `--preload=${stagePreload(temporary)}` },
			stdout: "pipe", stderr: "pipe",
		});
		expect(run.exitCode).toBe(0);
		expect(existsSync(marker)).toBe(true);
		expect(existsSync(join(temporary, "macro"))).toBe(false);
		if (dependency) expect(existsSync(join(temporary, "dependency"))).toBe(false);
		if (shadow) expect(existsSync(join(temporary, "shadow"))).toBe(true);
	} finally { rmSync(temporary, { recursive: true, force: true }); }
});

function reachSite(id: string, path: string, source: string, needle: string): Parameters<typeof instrument>[1][number] {
	const start = source.indexOf(needle);
	expect(start).toBeGreaterThanOrEqual(0);
	return { id, path, sourceSha256: sha256(source), site: { start, end: start + needle.length, mode: "expression" }, tests: [] };
}

async function runReachTest(cwd: string, test: string, overlay: string, preload: string, output: string) {
	const run = Bun.spawn([process.execPath, "--smol", "test", "--timeout", "15000",
		"--reporter=junit", `--reporter-outfile=${join(output, "tests.xml")}`, test,
		"--coverage", "--coverage-reporter=lcov", `--coverage-dir=${output}`], {
		cwd, signal: AbortSignal.timeout(15_000),
		env: { ...process.env, [OVERLAY_ENVIRONMENT]: overlay, BUN_OPTIONS: `--preload=${preload}` },
		stdout: "pipe", stderr: "pipe",
	});
	const [exit, stdout, stderr] = await Promise.all([run.exited, new Response(run.stdout).text(), new Response(run.stderr).text()]);
	expect({ exit, stdout: exit ? stdout : "", stderr: exit ? stderr : "" }).toEqual({ exit: 0, stdout: "", stderr: "" });
	return readFileSync(join(output, "lcov.info"), "utf8");
}

test.each(["consumer", "unrelated", "inherited", "external"])("macro priming attributes only consumer reach: %s", async (selection) => {
	const temporary = mkdtempSync(join(tmpdir(), "omo-reach-macro-init-"));
	try {
		const root = join(temporary, "fixture");
		const source = 'import { roleText } from "./embed" with { type: "macro" };\nexport const shadow = (roleText: (s: string) => string) => roleText("invalid");\nexport const preset = roleText("resident") + " ready";\n';
		const macro = 'export function roleText(name: string): string { if (name !== "resident") throw new Error("unexpected macro input"); return name.toUpperCase(); }\n';
		const instrumented = join(temporary, "instrumented");
		const markers = join(temporary, "markers");
		mkdirSync(markers);
		const sources: { path: string; source: string }[] = [];
		const paths: string[] = [];
		for (const directory of ["src", "other"]) {
			const path = `${directory}/roles.ts`, implementation = `${directory}/embed.ts`;
			mkdirSync(join(root, directory), { recursive: true });
			mkdirSync(join(instrumented, directory), { recursive: true });
			writeFileSync(join(root, path), source);
			writeFileSync(join(root, implementation), macro);
			writeFileSync(join(instrumented, path), instrument(source, [
				reachSite(`${directory}-macro`, path, source, '"resident"'),
				reachSite(`${directory}-ordinary`, path, source, '" ready"'),
			], markers));
			writeFileSync(join(instrumented, implementation), instrument(macro, [
				reachSite(`${directory}-implementation`, implementation, macro, "name.toUpperCase()"),
			], markers));
			sources.push({ path: join(root, path), source });
			paths.push(path, implementation);
		}
		writeFileSync(join(root, "src/roles.test.ts"),
			'import { expect, test } from "bun:test"; import { preset } from "./roles"; import { preset as other } from "../other/roles"; test("preset", () => { expect(preset).toBe("RESIDENT ready"); expect(other).toBe(preset); });\n');
		const unrelated = 'import { expect, test } from "bun:test"; import { value } from "./value"; test("unrelated", () => expect(value).toBe(1));\n';
		writeFileSync(join(root, "src/value.ts"), "export const value = 1;\n");
		writeFileSync(join(root, "src/unrelated.test.ts"), unrelated);
		writeFileSync(join(root, "src/inherited.test.ts"), `
import { expect, test } from "bun:test";
test("inherited preload", async () => {
	const child = Bun.spawn([process.execPath, "test", "./src/unrelated.test.ts"], {
		env: process.env, stdout: "pipe", stderr: "pipe", signal: AbortSignal.timeout(10000),
	});
	const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
	expect({ exit, stdout: exit ? stdout : "", stderr: exit ? stderr : "" }).toEqual({ exit: 0, stdout: "", stderr: "" });
});
`);
		const external = join(temporary, "fixture-sibling");
		mkdirSync(external);
		writeFileSync(join(external, "value.ts"), "export const value = 1;\n");
		writeFileSync(join(external, "unrelated.test.ts"), unrelated);
		const overlayPath = join(temporary, "overlay.txt");
		writeFileSync(overlayPath, encodeOverlay({ root, instrumented, paths }));
		const primer = stageMacroPreload(sources, join(temporary, "macros.ts"));
		if (!primer) throw new Error("macro primer missing");
		const testPath = selection === "consumer" ? "./src/roles.test.ts" : `./src/${selection}.test.ts`;
		const lcov = await runReachTest(selection === "external" ? external : root,
			selection === "external" ? "./unrelated.test.ts" : testPath, overlayPath, primer, temporary);
		const records = parseNativeLcov(lcov, ".");
		expect(records.length).toBeGreaterThan(0);
		if (selection === "external") expect(records.map((record) => record.path)).toEqual(["value.ts"]);
		expect(readdirSync(markers).sort()).toEqual(selection === "consumer"
			? ["other-implementation", "other-ordinary", "src-implementation", "src-ordinary"] : []);
	} finally { rmSync(temporary, { recursive: true, force: true }); }
});

test.each(["boot", "unrelated"])("real isolated boot graph retains implementation attribution: %s", async (selection) => {
	const temporary = mkdtempSync(join(tmpdir(), "oni-reach-boot-"));
	try {
		const root = resolve(import.meta.dir, ".."), path = "apps/oni/src/bundles/prompt/embed.ts";
		const source = readFileSync(join(root, path), "utf8");
		const consumer = join(root, "apps/oni/src/bundles/prompt/roles.ts");
		const instrumented = join(temporary, "instrumented"), markers = join(temporary, "markers");
		mkdirSync(markers);
		mkdirSync(dirname(join(instrumented, path)), { recursive: true });
		writeFileSync(join(instrumented, path), instrument(source, [
			reachSite("implementation", path, source, `readFileSync(join(import.meta.dir, "..", "..", "..", "prompts", "roles", \`\${name}.md\`), "utf-8")`),
		], markers));
		const overlay = join(temporary, "overlay.txt");
		writeFileSync(overlay, encodeOverlay({ root, instrumented, paths: [path] }));
		const primer = stageMacroPreload([
			{ path: join(root, path), source }, { path: consumer, source: readFileSync(consumer, "utf8") },
		], join(temporary, "macros.ts"));
		if (!primer) throw new Error("macro primer missing");
		const unrelated = join(temporary, "unrelated.test.ts");
		writeFileSync(unrelated, 'import { expect, test } from "bun:test"; test("unrelated", () => expect(1).toBe(1));\n');
		const lcov = await runReachTest(join(root, "apps/oni"),
			selection === "boot" ? "./test/boot-cleanup-failures.test.ts" : unrelated, overlay, primer, temporary);
		expect(parseNativeLcov(lcov, "apps/oni").length).toBeGreaterThan(0);
		expect(readdirSync(markers)).toEqual(selection === "boot" ? ["implementation"] : []);
	} finally { rmSync(temporary, { recursive: true, force: true }); }
});
