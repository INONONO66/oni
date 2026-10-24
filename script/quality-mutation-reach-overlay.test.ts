import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeOverlay, encodeOverlay, installOverlay, OVERLAY_ENVIRONMENT, reachPlugin, type ReachOverlay, stagePreload } from "./quality-mutation-reach-overlay";
import { instrument, sha256, stageMacroPreload } from "./run-quality-mutations";

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

test("an isolated Bun child expands a macro in an instrumented preset initializer", () => {
	const temporary = mkdtempSync(join(tmpdir(), "omo-reach-macro-init-"));
	try {
		const root = join(temporary, "fixture");
		const path = "src/roles.ts";
		const source = 'import { roleText } from "./embed" with { type: "macro" };\nexport const preset = roleText("resident") + " ready";\n';
		const macro = 'export function roleText(name: string): string { return name.toUpperCase(); }\n';
		const instrumented = join(temporary, "instrumented");
		mkdirSync(join(root, "src"), { recursive: true });
		mkdirSync(join(instrumented, "src"), { recursive: true });
		mkdirSync(join(temporary, "markers"));
		writeFileSync(join(root, path), source);
		writeFileSync(join(root, "src/embed.ts"), macro);
		writeFileSync(join(root, "src/roles.test.ts"),
			'import { expect, test } from "bun:test"; import { preset } from "./roles"; test("preset", () => expect(preset).toBe("RESIDENT ready"));\n');
		const ordinary = source.indexOf('" ready"');
		const macroArgument = source.indexOf('"resident"');
		const site = (id: string, start: number, end: number) => ({
			id, path, sourceSha256: sha256(source),
			site: { start, end, mode: "expression" as const }, tests: [],
		});
		writeFileSync(join(instrumented, path), instrument(source, [
			site("macro", macroArgument, macroArgument + '"resident"'.length),
			site("ordinary", ordinary, ordinary + '" ready"'.length),
		], join(temporary, "markers")));
		writeFileSync(join(instrumented, "src/embed.ts"), instrument(macro, [
			{ id: "implementation", path: "src/embed.ts", sourceSha256: sha256(macro),
				site: { start: macro.indexOf("name.toUpperCase()"), end: macro.indexOf("name.toUpperCase()") + "name.toUpperCase()".length, mode: "expression" }, tests: [] },
		], join(temporary, "markers")));
		const overlayPath = join(temporary, "overlay.txt");
		writeFileSync(overlayPath, encodeOverlay({ root, instrumented, paths: [path, "src/embed.ts"] }));
		const primer = stageMacroPreload([{ path: join(root, path), source }], join(temporary, "macros.ts"));
		expect(primer).not.toBeNull();
		const run = Bun.spawnSync([process.execPath, "test", "./src/roles.test.ts"], {
			cwd: root, timeout: 15_000,
			env: { ...process.env, [OVERLAY_ENVIRONMENT]: overlayPath,
				BUN_OPTIONS: `--preload=${primer} --preload=${stagePreload(temporary)}` },
			stdout: "pipe", stderr: "pipe",
		});
		expect(run.exitCode).toBe(0);
		expect(existsSync(join(temporary, "markers", "ordinary"))).toBe(true);
		expect(existsSync(join(temporary, "markers", "macro"))).toBe(false);
	} finally { rmSync(temporary, { recursive: true, force: true }); }
});
