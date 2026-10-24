import { diagnostics, executionTreeHash, fail, formatDiagnostic, mutationFailure, MutationError, ownsDiagnostic, pathIn, programs, projectRootPaths, sha256, type Entry, type Contract, type Inventory } from "./quality-mutation-input";
export { diagnostics, executionTreeHash, programs, sha256 } from "./quality-mutation-input";
import { decodeJson as sharedJson } from "./quality-inventory";
import { spawnSync } from "node:child_process";
import {
	appendFileSync,
	constants,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { COMPILER_BATCH_SIZE, compilerProofMatches, MutationCompilerWorker, type CompilerProof } from "./quality-mutation-compiler";
import { encodeOverlay, OVERLAY_ENVIRONMENT, type ReachOverlay, stagePreload } from "./quality-mutation-reach-overlay";

// The inventory producer is a supplied, hash-pinned CLI, not an imported copy of
// another lane. Only that producer decides membership, categories and topology.
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type ObjectValue = { [key: string]: Json };
type Outcome = "killed" | "survived" | "noCoverage" | "invalid" | "infrastructure" | "uncompleted";
type Operator = { id: string; replacements: Map<string, string[]> };
type Site = {
	start: number;
	end: number;
	mode: "expression" | "statement" | "case" | "jsx" | "python-expression" | "python-statement";
};
type Candidate = {
	id: string;
	path: string;
	sourceSha256: string;
	startOffset: number;
	endOffset: number;
	operator: string;
	replacement: string;
	replacementSha256: string;
	site: Site;
};
type ProcessReceipt = {
	stage: string;
	argv: string[];
	pid: number;
	exitCode: number | null;
	signal: string | null;
	timedOut: boolean;
	overflow: boolean;
	spawnError: boolean;
	stdout: string;
	stderr: string;
	stdoutSha256: string;
	stderrSha256: string;
	cleanupExit: number | null;
};
type Result = Candidate & {
	selected: boolean;
	outcome: Outcome;
	typecheck: string;
	testSelection: string;
	assertionIdentities: string[];
	coverage: { reached: boolean; markerSha256: string; tests?: string[] } | null;
	junitReports: string[];
	receipts: ProcessReceipt[];
	compilerProof?: CompilerProof;
	compilerFailure?: string;
	reason: string;
	restored: boolean;
};
type Census = {
	path: string;
	sha256: string;
	language: string;
	category: string;
	syntax: string;
	astNodes: number;
	operators: { operator: string; candidates: number; reason: string }[];
};
type ReachSite = { id: string; path: string; sourceSha256: string; site: Site; tests: string[] };
type ProbeEvidence = { reached: boolean; markerSha256: string; tests?: string[] };
type ReachMap = {
	version: 1;
	executionTreeSha256: string;
	candidatesSha256: string;
	testsSha256: string;
	sites: ReachSite[];
	runs: { test: string; receipt: TestSelectionReceipt }[];
	instrumentation: ProcessReceipt[];
	complete: boolean;
	sha256: string;
};
type Options = {
	root: string;
	contract: string;
	inventory: string;
	decision: string;
	inventoryTool: string;
	contractHash: string;
	inventoryHash: string;
	decisionHash: string;
	inventoryToolHash: string;
	dependencies: string;
	python: string;
	tests: string[];
	targets: string[];
	families: string[];
	limit: number;
	maxCandidates: number;
	timeout: number;
	suiteTimeout: number;
	mutantMemoryBytes: number;
	testRuntime: TestRuntime;
	budget: number;
	checkpointResults: number;
	pilot: boolean;
	failureOutput: string;
	shard: { index: number; count: number; progress: string } | null;
};

let setupProcessFailure: ProcessReceipt | null = null;
function object(value: Json | undefined): ObjectValue {
	if (!value || typeof value !== "object" || Array.isArray(value))
		return fail("schema", "Expected object");
	return value;
}
function text(value: Json | undefined): string {
	if (typeof value !== "string") return fail("schema", "Expected string");
	return value;
}
function array(value: Json | undefined): Json[] {
	if (!Array.isArray(value)) return fail("schema", "Expected array");
	return value;
}
function number(value: Json | undefined): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
		return fail("schema", "Expected nonnegative integer");
	return value;
}
function hash(value: string): string {
	if (!/^[a-f0-9]{64}$/.test(value)) return fail("schema", "Expected SHA256");
	return value;
}

// Decode JSON through the pinned public compiler AST. No JSON.parse top-typed
// application payload, casts, declaration patches, or boundary exemptions.
export function decode(input: string): Json {
	try { return sharedJson(input); }
	catch { return fail("json", "invalid JSON"); }
}

function readJson(path: string): Json {
	return decode(readFileSync(path, "utf8"));
}
function pinned(path: string, expected: string): string {
	const content = readFileSync(path, "utf8");
	if (sha256(content) !== hash(expected)) return fail("tamper", `Hash mismatch: ${path}`);
	return content;
}
function contractAt(path: string): Contract {
	const data = object(readJson(path));
	if (data.version !== 1 || data.typescript !== "5.9.2" || typeof data.topology !== "boolean")
		return fail("schema", "Unsupported canonical contract");
	const projects = array(data.projects).map(text);
	const roots = array(data.roots).map(text);
	if (!projects.length || !roots.length) return fail("incompleteInventory", "Empty contract");
	return { projects, roots, topology: data.topology };
}
function entry(value: Json): Entry {
	const row = object(value);
	const result = {
		path: text(row.path),
		sha256: hash(text(row.sha256)),
		bytes: number(row.bytes),
		category: text(row.category),
		language: text(row.language),
	};
	if (
		!["production", "tooling", "test", "fixture", "benchmark", "migration", "historical"].includes(
			result.category,
		) ||
		!["typescript", "javascript", "python", "sql"].includes(result.language)
	)
		return fail("schema", "Invalid canonical entry");
	return result;
}
function inventoryAt(path: string): Inventory {
	const data = object(readJson(path));
	if (data.version !== 1) return fail("schema", "Unsupported inventory version");
	hash(text(data.contractHash));
	const result = {
		files: array(data.files).map(entry),
		historical: array(data.historical).map(entry),
		embedded: array(data.embedded).map(entry),
		configurations: array(data.configurations).map((value) => {
			const row = object(value);
			return { path: text(row.path), sha256: hash(text(row.sha256)) };
		}),
	};
	if (
		!result.files.length ||
		new Set(result.files.map((file) => file.path)).size !== result.files.length
	)
		return fail("incompleteInventory", "Empty or duplicate inventory");
	return result;
}
const familyIds = [
	"boolean-literal",
	"equality",
	"relational",
	"arithmetic",
	"logical",
	"bitwise",
	"unary",
	"update",
	"assignment",
	"numeric-literal",
	"bigint-literal",
	"string-literal",
	"condition",
	"conditional-arm",
	"statement-delete",
	"return-value",
	"throw-delete",
	"array-literal",
	"object-literal",
	"optional-chain",
	"await-delete",
	"switch-case",
	"regex",
	"method",
];
function operatorsAt(path: string): Operator[] {
	const contract = object(object(readJson(path)).contract);
	const bounds = object(contract.hardBounds);
	if (
		bounds.survivingMutants !== 0 ||
		array(bounds.allowlists).length ||
		array(bounds.grandfathered).length
	)
		return fail("operatorContract", "Mutation thresholds cannot be weakened");
	const mutation = object(contract.mutation);
	if (mutation.algorithm !== "d945-mutation@1" || array(mutation.equivalentMutantAllowlist).length)
		return fail("operatorContract", "Unsupported mutation algorithm");
	if (
		sha256(JSON.stringify(mutation.operators)) !==
		"3ce0e7eedec5b153986b12e1ca5b8a25ec2f373f8529f51e526ae67e1c2b8bfd"
	)
		return fail(
			"operatorContract",
			"Operator definitions differ from implemented frozen d945-mutation@1",
		);
	const operators = array(mutation.operators).map((value) => {
		const row = object(value);
		return {
			id: text(row.id),
			replacements: new Map(
				Object.entries(object(row.replacements)).map(([key, values]) => [
					key,
					array(values).map(text),
				]),
			),
		};
	});
	if (
		operators.length !== familyIds.length ||
		new Set(operators.map((op) => op.id)).size !== familyIds.length ||
		operators.some((op) => !familyIds.includes(op.id))
	)
		return fail("operatorContract", "Incomplete or unsupported operator census");
	return operators;
}

const sensitiveOptionName = "--(?:[a-z0-9]+[-_])*(?:token|secret|password|credential|key)";
function redactArgv(argv: string[]): string[] {
	const sensitiveOption = new RegExp(`^${sensitiveOptionName}$`, "i");
	let secretValue = false;
	return argv.map((value) => {
		if (secretValue) {
			secretValue = false;
			return "[redacted]";
		}
		const equals = value.indexOf("=");
		if (equals >= 0 && sensitiveOption.test(value.slice(0, equals)))
			return `${value.slice(0, equals + 1)}[redacted]`;
		secretValue = sensitiveOption.test(value);
		return value;
	});
}
// Scrub echoed command options only when rendering diagnostics. Raw child
// output remains available to the compiler/worker decoders and its byte hashes
// are unchanged, even when the report contains redacted stdout or stderr.
function diagnosticField(key: string, value: Json): Json {
	if (typeof value !== "string" || !["message", "stdout", "stderr"].includes(key)) return value;
	return value.replace(
		new RegExp(`(^|\\s)(${sensitiveOptionName})(=|\\s+)(?:"[^"]*"|'[^']*'|[^\\s]+)`, "gi"),
		"$1$2$3[redacted]",
	);
}

export async function execute(
	argv: string[],
	cwd: string,
	timeout: number,
	environment: Record<string, string> = {},
	stage = "process",
): Promise<ProcessReceipt> {
	const redactedArgv = redactArgv(argv);
	const output = { stdout: "", stderr: "" };
	const hashes = { stdout: new Bun.CryptoHasher("sha256"), stderr: new Bun.CryptoHasher("sha256") };
	let timedOut = false;
	let overflow = false;
	let pid = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	function terminate(): number | null {
		if (!pid) return null;
		// A nonexistent process group produces exit 1, retained in the receipt.
		return spawnSync("/bin/kill", ["-KILL", "--", `-${pid}`], { stdio: "ignore" }).status;
	}
	try {
		const child = Bun.spawn(argv, {
			cwd,
			detached: true,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, FORCE_COLOR: "0", ...environment },
			onExit: () => {
				terminate();
			},
		});
		pid = child.pid;
		timer = setTimeout(() => {
			timedOut = true;
			terminate();
		}, timeout);
		async function consume(
			channel: "stdout" | "stderr",
			stream: ReadableStream<Uint8Array>,
		): Promise<void> {
			const reader = stream.getReader();
			try {
				while (true) {
					const chunk = await reader.read();
					if (chunk.done) break;
					hashes[channel].update(chunk.value);
					if (output[channel].length + chunk.value.length > 1_048_576) {
						overflow = true;
						terminate();
					}
					output[channel] += Buffer.from(chunk.value)
						.toString("utf8")
						.slice(0, Math.max(0, 1_048_576 - output[channel].length));
				}
			} finally {
				reader.releaseLock();
			}
		}
		await Promise.all([
			consume("stdout", child.stdout),
			consume("stderr", child.stderr),
			child.exited,
		]);
		const receipt = {
			stage,
			argv: redactedArgv,
			pid,
			exitCode: child.exitCode,
			signal: child.signalCode,
			timedOut,
			overflow,
			spawnError: false,
			...output,
			stdoutSha256: hashes.stdout.digest("hex"),
			stderrSha256: hashes.stderr.digest("hex"),
			cleanupExit: terminate(),
		};
		return receipt;
	} catch {
		const receipt = {
			stage,
			argv: redactedArgv,
			pid,
			exitCode: null,
			signal: null,
			timedOut,
			overflow,
			spawnError: true,
			...output,
			stdoutSha256: hashes.stdout.digest("hex"),
			stderrSha256: hashes.stderr.digest("hex"),
			cleanupExit: terminate(),
		};
		return receipt;
	} finally {
		clearTimeout(timer);
	}
}
function broken(receipt: ProcessReceipt): boolean {
	return (
		receipt.timedOut ||
		receipt.overflow ||
		receipt.spawnError ||
		receipt.signal !== null ||
		receipt.exitCode === null ||
		(receipt.cleanupExit !== 0 && receipt.cleanupExit !== 1)
	);
}
function runtimeNode(node: ts.Node): boolean {
	if (
		ts.isTypeNode(node) ||
		ts.isInterfaceDeclaration(node) ||
		ts.isTypeAliasDeclaration(node) ||
		ts.isImportDeclaration(node) ||
		ts.isExportDeclaration(node)
	)
		return false;
	return !(
		ts.canHaveModifiers(node) &&
		ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword)
	);
}
function literalValue(node: ts.Node): boolean {
	const parent = node.parent;
	if (ts.isExpressionStatement(parent) && directive(parent)) return false;
	if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
	if (
		(ts.isPropertyAssignment(parent) ||
			ts.isMethodDeclaration(parent) ||
			ts.isPropertyDeclaration(parent) ||
			ts.isBindingElement(parent) ||
			ts.isEnumMember(parent)) &&
		parent.name === node
	)
		return false;
	if (ts.isImportTypeNode(parent) || ts.isLiteralTypeNode(parent)) return false;
	if (
		ts.isCallExpression(parent) &&
		(parent.expression.kind === ts.SyntaxKind.ImportKeyword ||
			(ts.isIdentifier(parent.expression) && parent.expression.text === "require")) &&
		parent.arguments[0] === node
	)
		return false;
	return true;
}
function isStringExpression(statement: ts.Statement): boolean {
	return ts.isExpressionStatement(statement) && ts.isStringLiteral(statement.expression);
}
function directiveStatements(parent: ts.Node): readonly ts.Statement[] {
	if (ts.isBlock(parent)) return parent.statements;
	if (ts.isSourceFile(parent)) return parent.statements;
	return [];
}
function directive(node: ts.ExpressionStatement): boolean {
	const parent = node.parent;
	const statements = directiveStatements(parent);
	const index = statements.indexOf(node);
	return ts.isStringLiteral(node.expression) && index >= 0 &&
		statements.slice(0, index).every(isStringExpression);
}
function regexTokenReplacement(char: string | undefined): string | null {
	return char === "+" ? "*" : char === "*" ? "+" : ["^", "$", "?"].includes(char ?? "") ? "" : null;
}
function regexChanges(raw: string): string[] {
	const slash = raw.lastIndexOf("/");
	const body = raw.slice(1, slash);
	const flags = raw.slice(slash + 1);
	const result: string[] = [];
	let inClass = false;
	for (let index = 0; index < body.length; index++) {
		const char = body[index];
		if (char === "\\") {
			index++;
			continue;
		}
		if (char === "[") {
			inClass = true;
			continue;
		}
		if (char === "]") {
			inClass = false;
			continue;
		}
		if (inClass || (char === "?" && body[index - 1] === "(")) continue;
		const replacement = regexTokenReplacement(char);
		if (replacement !== null)
			result.push(`/${body.slice(0, index)}${replacement}${body.slice(index + 1)}/${flags}`);
	}
	for (const flag of ["i", "g"])
		result.push(`/${body}/${flags.includes(flag) ? flags.replace(flag, "") : flags + flag}`);
	return result;
}

const EXEMPT_CATEGORIES: ReadonlySet<string> = new Set(["historical", "test", "fixture", "benchmark"]);

/** Mutation targets shipped or tooling behavior; test, fixture and benchmark
 * code is inventoried in the census but never mutated. */
function mutable(file: { category: string; language: string }): boolean {
	return !EXEMPT_CATEGORIES.has(file.category) && file.language !== "sql";
}

type AddMutation = (
	op: string, node: ts.Node, replacement: string, siteNode?: ts.Node, mode?: Site["mode"],
) => void;

function addCandidate(
	context: { file: Entry; source: ts.SourceFile; seen: Set<string>; candidates: Candidate[] },
	op: string,
	node: ts.Node,
	replacement: string,
	siteNode: ts.Node = node,
	mode: Site["mode"] = "expression",
): void {
	const { file, source, seen, candidates } = context;
	const startOffset = node.getStart(source);
	const endOffset = node.end;
	if (source.text.slice(startOffset, endOffset) === replacement) return;
	const replacementSha256 = sha256(replacement);
	const id = sha256(`${file.path}\0${startOffset}\0${endOffset}\0${replacementSha256}`);
	if (seen.has(id)) return;
	seen.add(id);
	const value = mode === "expression" ? valueBoundary(siteNode) : siteNode;
	// A literal switch discriminant or an iteration-head pattern becomes an
	// entry marker on the statement.
	const statement = statementBoundary(value);
	const boundary = statement ?? value;
	const siteMode = statement ? "statement" : mode;
	const start = boundary.getStart(source);
	// Keep block-owned statements at their lexical level, including super().
	const end = siteMode === "statement" && ts.isBlock(boundary.parent) ? start : boundary.end;
	candidates.push({
		id, path: file.path, sourceSha256: file.sha256, startOffset, endOffset,
		operator: op, replacement, replacementSha256, site: { start, end, mode: siteMode },
	});
}

function addScalarMutations(
	node: ts.Node, raw: string, source: ts.SourceFile, operators: Operator[], add: AddMutation,
): void {
	if (ts.isBinaryExpression(node))
		for (const op of operators)
			for (const replacement of op.replacements.get(node.operatorToken.getText(source)) ?? [])
				add(op.id, node.operatorToken, replacement, node);
	if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword)
		add("boolean-literal", node, raw === "true" ? "false" : "true");
	if (ts.isNumericLiteral(node) && literalValue(node) && Number.isFinite(Number(node.text)))
		add("numeric-literal", node, Number(node.text) === 0 ? "1" : "0");
	if (ts.isBigIntLiteral(node) && literalValue(node))
		add("bigint-literal", node, BigInt(node.text.slice(0, -1).replaceAll("_", "")) === 0n ? "1n" : "0n");
}

function addTemplateMutations(
	node: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral | ts.TemplateExpression,
	source: ts.SourceFile, embedded: boolean, add: AddMutation,
): void {
	if (embedded) return;
	// Quasis are template data, not ordinary expression literals.
	// Keep tag/receiver/substitutions and the raw/cooked pair intact.
	const parts = ts.isTemplateExpression(node)
		? [node.head, ...node.templateSpans.map((span) => span.literal)]
		: [node];
	for (const part of parts) {
		const opening = ts.isTemplateMiddle(part) || ts.isTemplateTail(part) ? "}" : "`";
		const closing = ts.isTemplateHead(part) || ts.isTemplateMiddle(part) ? "${" : "`";
		add("string-literal", part,
			`${opening}${part.getText(source).length > opening.length + closing.length ? "" : "__d945_mutant__"}${closing}`,
			node.parent);
	}
}

function addStringMutations(
	node: ts.Node, source: ts.SourceFile, embeddedPath: string, inventory: Inventory, add: AddMutation,
): void {
	if (
		(ts.isStringLiteral(node) ||
			ts.isNoSubstitutionTemplateLiteral(node) ||
			ts.isTemplateExpression(node)) &&
		literalValue(node)
	) {
		if (ts.isTaggedTemplateExpression(node.parent)) {
			const embedded = inventory.embedded.some(
				(entry) =>
					entry.path === embeddedPath &&
					ts.isVariableDeclaration(node.parent.parent) &&
					node.parent.parent.name.getText(source) === "PYTHON_DRIVER",
			);
			addTemplateMutations(node, source, embedded, add);
		} else
			add("string-literal", node,
				ts.isTemplateExpression(node) || node.text.length ? '""' : '"__d945_mutant__"',
				node, ts.isJsxAttribute(node.parent) ? "jsx" : "expression");
	}
}

function addUnaryMutations(node: ts.Node, source: ts.SourceFile, add: AddMutation): void {
	if (ts.isPrefixUnaryExpression(node)) {
		const operand = node.operand.getText(source);
		const unary = new Map([
			[ts.SyntaxKind.ExclamationToken, `(${operand})`],
			[ts.SyntaxKind.TildeToken, `(${operand})`],
			[ts.SyntaxKind.PlusToken, `-(${operand})`],
			[ts.SyntaxKind.MinusToken, `+(${operand})`],
		]);
		const replacement = unary.get(node.operator);
		if (replacement) add("unary", node, replacement);
	}
	if (
		(ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
		(node.operator === ts.SyntaxKind.PlusPlusToken ||
			node.operator === ts.SyntaxKind.MinusMinusToken)
	) {
		const token = node.operator === ts.SyntaxKind.PlusPlusToken ? "--" : "++";
		add("update", node, ts.isPrefixUnaryExpression(node)
			? `${token}${node.operand.getText(source)}`
			: `${node.operand.getText(source)}${token}`);
	}
}

function addConditionMutations(node: ts.Node, source: ts.SourceFile, add: AddMutation): void {
	if (
		ts.isIfStatement(node) ||
		ts.isWhileStatement(node) ||
		ts.isDoStatement(node) ||
		ts.isForStatement(node) ||
		ts.isConditionalExpression(node)
	) {
		const condition = ts.isForStatement(node)
			? node.condition
			: ts.isConditionalExpression(node)
				? node.condition
				: node.expression;
		if (condition)
			for (const replacement of ["true", "false"]) add("condition", condition, replacement);
	}
	if (ts.isConditionalExpression(node))
		add("conditional-arm", node,
			`(${node.condition.getText(source)}) ? (${node.whenFalse.getText(source)}) : (${node.whenTrue.getText(source)})`);
}

function addStatementAndCollectionMutations(node: ts.Node, add: AddMutation): void {
	if (ts.isExpressionStatement(node) && !directive(node))
		add("statement-delete", node, ";", node, "statement");
	if (ts.isReturnStatement(node) && node.expression)
		add("return-value", node.expression, "undefined");
	if (ts.isThrowStatement(node)) add("throw-delete", node, ";", node, "statement");
	if (ts.isArrayLiteralExpression(node) && node.elements.length)
		add("array-literal", node, "[]");
	if (ts.isObjectLiteralExpression(node) && node.properties.length)
		add("object-literal", node, "{}");
}

function addAccessAndControlMutations(
	node: ts.Node, raw: string, source: ts.SourceFile, add: AddMutation,
): void {
	if (
		(ts.isPropertyAccessExpression(node) ||
			ts.isElementAccessExpression(node) ||
			ts.isCallExpression(node)) &&
		node.questionDotToken
	)
		add("optional-chain", node.questionDotToken,
			ts.isPropertyAccessExpression(node) ? "." : "", node);
	if (ts.isAwaitExpression(node))
		add("await-delete", node, `(${node.expression.getText(source)})`);
	if (
		ts.isCaseClause(node) &&
		(ts.isLiteralExpression(node.expression) ||
			node.expression.kind === ts.SyntaxKind.TrueKeyword ||
			node.expression.kind === ts.SyntaxKind.FalseKeyword)
	)
		add("switch-case", node, "", node, "case");
	if (ts.isRegularExpressionLiteral(node))
		for (const replacement of regexChanges(raw)) add("regex", node, replacement);
}

function addMethodMutations(
	node: ts.Node, checker: ts.TypeChecker, add: AddMutation,
): void {
	if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
		const access = node.expression;
		const receiver = checker.getTypeAtLocation(access.expression);
		const name = access.name.text;
		const isArray = checker.isArrayType(receiver) || checker.isTupleType(receiver);
		const isString = (receiver.flags & ts.TypeFlags.StringLike) !== 0;
		if (isArray && name === "filter" && node.arguments[0])
			add("method", node.arguments[0], "() => true", node);
		if (isArray && (name === "every" || name === "some"))
			add("method", access.name, name === "every" ? "some" : "every", node);
		if (isString && (name === "startsWith" || name === "endsWith"))
			add("method", access.name, name === "startsWith" ? "endsWith" : "startsWith", node);
	}
}

export function enumerate(
	directory: string,
	inventory: Inventory,
	operators: Operator[],
	items: ts.Program[],
): { candidates: Candidate[]; census: Census[]; errors: string[] } {
	const root = realpathSync(directory);
	const candidates: Candidate[] = [];
	const census: Census[] = [];
	const errors: string[] = [];
	const seen = new Set<string>();
	for (const file of [...inventory.files, ...inventory.historical, ...inventory.embedded]) {
		const firstCandidate = candidates.length;
		const row: Census = {
			path: file.path,
			sha256: file.sha256,
			category: file.category,
			language: file.language,
			syntax: "parsed",
			astNodes: 0,
			operators: [],
		};
		census.push(row);
		if (!mutable(file)) row.syntax = "outside-executable-TS-JS-contract";
		else if (file.language === "python") {
			row.syntax = "pending-python-AST";
		} else {
			const absolute = pathIn(root, file.path);
			const owner = items.find((program) => program.getSourceFile(absolute));
			const selected = owner?.getSourceFile(absolute);
			if (!owner || !selected) {
				row.syntax = "incompleteInventory";
				errors.push(`${file.path}: no owning compiler project`);
			} else if (owner.getSyntacticDiagnostics(selected).length) {
				row.syntax = "unsupportedSyntax";
				errors.push(`${file.path}: parser rejected source`);
			} else if (!selected.isDeclarationFile) {
				const source = selected;
				const checker = owner.getTypeChecker();
				const context = { file, source, seen, candidates };
				const add: AddMutation = (op, node, replacement, siteNode, mode) =>
					addCandidate(context, op, node, replacement, siteNode, mode);
				function visit(node: ts.Node): void {
					row.astNodes++;
					if (!runtimeNode(node)) return;
					const raw = node.getText(source);
					addScalarMutations(node, raw, source, operators, add);
					addStringMutations(node, source, `${file.path}#PYTHON_DRIVER`, inventory, add);
					addUnaryMutations(node, source, add);
					addConditionMutations(node, source, add);
					addStatementAndCollectionMutations(node, add);
					addAccessAndControlMutations(node, raw, source, add);
					addMethodMutations(node, checker, add);
					ts.forEachChild(node, visit);
				}
				visit(source);
			}
		}
		const fileCandidates = candidates.slice(firstCandidate);
		row.operators = operators.map((op) => {
			const count = fileCandidates.filter((candidate) => candidate.operator === op.id).length;
			return {
				operator: op.id,
				candidates: count,
				reason: count
					? "enumerated"
					: row.syntax === "parsed"
						? "no-applicable-runtime-AST-site"
						: row.syntax,
			};
		});
	}
	candidates.sort(compareCandidates);
	return { candidates, census, errors };
}
// Preserve first-project ownership without retaining every project's checker.
export function analyze(directory: string, contract: Contract, inventory: Inventory, operators: Operator[]) {
	const root = realpathSync(directory);
	const pending = new Map(inventory.files.map((file) => [file.path, file]));
	const result: ReturnType<typeof enumerate> = { candidates: [], census: [], errors: [] };
	const sourceDiagnostics: string[] = [];
	for (const program of programs(root, contract, inventory)) {
		const projectRoots = projectRootPaths(program.getRootFileNames());
		const files = [...pending.values()].filter((file) =>
			["typescript", "javascript"].includes(file.language) &&
			projectRoots.has(realpathSync(pathIn(root, file.path))),
		);
		const part = enumerate(root, { files, historical: [], embedded: inventory.embedded, configurations: [] }, operators, [program]);
		result.candidates.push(...part.candidates);
		result.census.push(...part.census.filter((row) => row.language !== "python"));
		result.errors.push(...part.errors);
		sourceDiagnostics.push(...ts.getPreEmitDiagnostics(program)
			.filter((diagnostic) => ownsDiagnostic(projectRoots, diagnostic))
			.map((diagnostic) => formatDiagnostic(diagnostic, root)));
		for (const file of files) pending.delete(file.path);
	}
	const rest = enumerate(root, { ...inventory, files: [...pending.values()] }, operators, []);
	result.candidates.push(...rest.candidates);
	result.census.push(...rest.census);
	result.errors.push(...rest.errors);
	const rows = new Map(result.census.map((row) => [row.path, row]));
	result.census = [...inventory.files, ...inventory.historical, ...inventory.embedded].flatMap((file) => {
		const row = rows.get(file.path);
		return row ? [row] : [];
	});
	return { enumerated: result, sourceDiagnostics };
}

// An assignment target (`{ a } = x`, `[a] = x`, `a.b += 1`) is not a value:
// wrapping it in a probe yields an invalid assignment target, so the probe
// moves to the assignment expression that consumes it.
function assignmentConsumer(node: ts.Node): ts.Node | undefined {
	const parent = node.parent;
	if (ts.isBinaryExpression(parent) && parent.left === node)
		return parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
			parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
			? parent
			: undefined;
	// `for ([a] of xs)` / `for ({ a } in o)`: the head pattern is consumed by
	// the loop statement, so the probe becomes an entry marker on it. The
	// marker fires when the statement is entered even if the iterable is
	// empty, so a pattern that is never bound still counts as reached: its
	// mutant is executed and can only be reported survived, never hidden as
	// noCoverage.
	if ((ts.isForOfStatement(parent) || ts.isForInStatement(parent)) && parent.initializer === node) return parent;
	if (
		ts.isArrayLiteralExpression(parent) ||
		ts.isSpreadElement(parent) ||
		ts.isSpreadAssignment(parent) ||
		(ts.isPropertyAssignment(parent) && parent.initializer === node)
	)
		return assignmentConsumer(parent);
	if (ts.isObjectLiteralExpression(parent) && ts.isPropertyAssignment(node)) return assignmentConsumer(parent);
	return undefined;
}

// A probe is `(marker, (expression))`. The checker narrows through a comma
// only when its right side is itself a narrowing expression, and `&&`, `||`,
// `??` and `!(...)` are not: the binder splits them into branches instead.
// Wrapping such a condition removes every narrowing it provided, so the
// probe descends to the leftmost operand, whose reach equals the whole
// condition's. Literal operands of comparisons move to the comparison: a
// `typeof x === "string"` guard is recognized syntactically and a wrapped
// literal is no longer a literal. Reach is identical either way.
const logicalOperators = new Set<ts.SyntaxKind>([
	ts.SyntaxKind.AmpersandAmpersandToken,
	ts.SyntaxKind.BarBarToken,
	ts.SyntaxKind.QuestionQuestionToken,
]);
const comparisonOperators = new Set<ts.SyntaxKind>([
	ts.SyntaxKind.EqualsEqualsToken,
	ts.SyntaxKind.ExclamationEqualsToken,
	ts.SyntaxKind.EqualsEqualsEqualsToken,
	ts.SyntaxKind.ExclamationEqualsEqualsToken,
	ts.SyntaxKind.InKeyword,
]);
function isLiteralOperand(node: ts.Node): boolean {
	if (ts.isParenthesizedExpression(node)) return isLiteralOperand(node.expression);
	return (
		ts.isStringLiteralLike(node) ||
		ts.isNumericLiteral(node) ||
		ts.isBigIntLiteral(node) ||
		node.kind === ts.SyntaxKind.TrueKeyword ||
		node.kind === ts.SyntaxKind.FalseKeyword ||
		node.kind === ts.SyntaxKind.NullKeyword
	);
}
function literalDiscriminantSwitch(node: ts.Node): ts.SwitchStatement | undefined {
	let inner = node;
	while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
	if (inner.kind !== ts.SyntaxKind.TrueKeyword && inner.kind !== ts.SyntaxKind.FalseKeyword) return undefined;
	return ts.isSwitchStatement(node.parent) && node.parent.expression === node ? node.parent : undefined;
}
// Only for-of / for-in heads become statement probes (assignmentConsumer);
// `continue label` needs its label on the loop itself, so the wrapping block
// goes around the outermost label of that loop statement.
function statementBoundary(value: ts.Node): ts.Statement | undefined {
	if (!ts.isForOfStatement(value) && !ts.isForInStatement(value)) return literalDiscriminantSwitch(value);
	let statement: ts.Statement = value;
	while (ts.isLabeledStatement(statement.parent)) statement = statement.parent;
	return statement;
}
function narrowingBoundary(node: ts.Node): ts.Node {
	const parent = node.parent;
	if (
		isLiteralOperand(node) &&
		ts.isBinaryExpression(parent) &&
		comparisonOperators.has(parent.operatorToken.kind)
	)
		return parent;
	let leaf = node;
	for (;;) {
		let inner = leaf;
		while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
		if (ts.isPrefixUnaryExpression(inner) && inner.operator === ts.SyntaxKind.ExclamationToken)
			leaf = inner.operand;
		else if (ts.isBinaryExpression(inner) && logicalOperators.has(inner.operatorToken.kind)) leaf = inner.left;
		else return leaf;
	}
}

// Probe a value-producing boundary, never sever a Reference used as a callee,
// delete operand, or continuing optional chain. Arguments/keys stay lazy.
function valueBoundary(node: ts.Node): ts.Node {
	const consumer = assignmentConsumer(node);
	if (consumer) return valueBoundary(consumer);
	const parent = node.parent;
	if (
		((ts.isPropertyAccessExpression(parent) ||
			ts.isElementAccessExpression(parent) ||
			ts.isCallExpression(parent) ||
			ts.isParenthesizedExpression(parent) ||
			ts.isNonNullExpression(parent) ||
			ts.isAsExpression(parent) ||
			ts.isTypeAssertionExpression(parent) ||
			ts.isDeleteExpression(parent)) &&
			parent.expression === node) ||
		(ts.isTaggedTemplateExpression(parent) && parent.tag === node)
	)
		return valueBoundary(parent);
	return narrowingBoundary(node);
}
function compare(a: string, b: string): number {
	return Buffer.compare(Buffer.from(a), Buffer.from(b));
}
function compareCandidates(a: Candidate, b: Candidate): number {
	return (
		compare(a.path, b.path) ||
		a.startOffset - b.startOffset ||
		compare(a.operator, b.operator) ||
		compare(a.replacement, b.replacement)
	);
}
function replace(source: string, start: number, end: number, replacement: string): string {
	return source.slice(0, start) + replacement + source.slice(end);
}
function caseInsertion(source: string, site: Site): number {
	const original = source.slice(site.start, site.end);
	const clause = ts.createSourceFile("site.ts", `switch(0){${original}}`, ts.ScriptTarget.Latest, true);
	const statement = clause.statements[0];
	if (!statement || !ts.isSwitchStatement(statement)) return fail("instrumentation", "Missing switch site");
	const first = statement.caseBlock.clauses[0];
	if (!first || !ts.isCaseClause(first)) return fail("instrumentation", "Missing case site");
	return site.start + original.indexOf(":", first.expression.end - "switch(0){".length) + 1;
}
/**
 * Marker probe text. The write happens once per process per marker: a hot
 * path evaluated millions of times during one test must not pay a synchronous
 * file write on each evaluation, or the test trips its own time bounds. The
 * once-guard goes through `Reflect` because probed TypeScript is still
 * type-checked by tests that compile source under strict options, and
 * `typeof globalThis` has no index signature. The same tests reject compiler
 * `any`: `require` is untyped in an ES module, `process.getBuiltinModule` is
 * typed, and every subexpression here is a boolean.
 */
// The probe is spliced into arbitrary scopes, so its only free identifier is
// `globalThis`: bare `process`/`Reflect` are shadowed by locals in source such
// as codemode's `const process = spawn(...)`. The guard is set before the
// write: probed test fixtures wrap `fs.writeFileSync` on the builtin module
// object, so a probe inside such a wrapper re-enters it through the write and
// must find its marker already claimed instead of recursing.
export function probeText(marker: string): string {
	const path = JSON.stringify(marker);
	return `(globalThis.Reflect.has(globalThis,${path})||(globalThis.Reflect.set(globalThis,${path},1),globalThis.process.getBuiltinModule("node:fs").writeFileSync(${path},"1")))`;
}
function instrumentSingle(source: string, site: Site, marker: string): string {
	const probe = probeText(marker);
	const original = source.slice(site.start, site.end);
	if (site.mode === "statement") return replace(source, site.start, site.end, `{${probe};${original}}`);
	if (site.mode === "case") return replace(source, caseInsertion(source, site), caseInsertion(source, site), `${probe};`);
	const expression = `(${probe},(${original}))`;
	return replace(source, site.start, site.end, site.mode === "jsx" ? `{${expression}}` : expression);
}
type ReachInsertion = { offset: number; order: number; text: string };
function reachInsertions(source: string, row: ReachSite, directory: string, index: number): ReachInsertion[] {
	const { site } = row;
	const marker = join(directory, row.id);
	if (site.mode === "case") {
		const offset = caseInsertion(source, site);
		return [{ offset, order: index, text: `${probeText(marker)};` }];
	}
	// Use exactly the single-site wrapper, but retain original offsets when
	// nesting wrappers. Replacing an outer span would truncate inner probes.
	const single = instrumentSingle(source, site, marker);
	const added = single.length - source.length;
	if (site.mode === "statement" && site.start === site.end)
		return [{ offset: site.start, order: -index - 1, text: single.slice(site.start, site.start + added) }];
	const closeLength = site.mode === "statement" ? 1 : site.mode === "jsx" ? 3 : 2;
	return [
		{ offset: site.start, order: index, text: single.slice(site.start, site.start + added - closeLength) },
		{ offset: site.end, order: -index - 1, text: single.slice(site.end + added - closeLength, site.end + added) },
	];
}
export function instrument(source: string, sites: ReachSite[], directory: string): string {
	const parsed = ts.createSourceFile("reach.ts", source, ts.ScriptTarget.Latest, true);
	const options: ts.CompilerOptions = { noLib: true, noResolve: true };
	const compilerHost = ts.createCompilerHost(options);
	const getSourceFile = compilerHost.getSourceFile;
	const host: ts.CompilerHost = {
		...compilerHost,
		getSourceFile: (file, languageVersion, onError, shouldCreateNewSourceFile) =>
			file === parsed.fileName ? parsed : getSourceFile(file, languageVersion, onError, shouldCreateNewSourceFile),
	};
	const checker = ts.createProgram([parsed.fileName], options, host).getTypeChecker();
	const macroBindings = new Set<ts.Symbol>();
	const macroNamespaces = new Set<ts.Symbol>();
	for (const statement of parsed.statements) {
		if (!ts.isImportDeclaration(statement) ||
			!statement.attributes?.elements.some((attribute) =>
				attribute.name.text === "type" && ts.isStringLiteral(attribute.value) && attribute.value.text === "macro")) continue;
		const clause = statement.importClause;
		if (clause?.name) {
			const symbol = checker.getSymbolAtLocation(clause.name);
			if (symbol) macroBindings.add(symbol);
		}
		if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings))
			for (const binding of clause.namedBindings.elements) {
				const symbol = checker.getSymbolAtLocation(binding.name);
				if (symbol) macroBindings.add(symbol);
			}
		if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
			const symbol = checker.getSymbolAtLocation(clause.namedBindings.name);
			if (symbol) macroNamespaces.add(symbol);
		}
	}
	const protectedSpans: { start: number; end: number }[] = [];
	if (macroBindings.size || macroNamespaces.size) {
		const unwrap = (expression: ts.Expression): ts.Expression => {
			let current = expression;
			while (ts.isParenthesizedExpression(current) || ts.isNonNullExpression(current))
				current = current.expression;
			return current;
		};
		const dependencies = new Set<ts.Symbol>();
		const protectDependencies = (node: ts.Node): void => {
			if (ts.isIdentifier(node)) {
				const symbol = checker.getSymbolAtLocation(node);
				if (symbol && !dependencies.has(symbol)) {
					dependencies.add(symbol);
					for (const declaration of symbol.declarations ?? []) {
						if (!ts.isVariableDeclaration(declaration) || !declaration.initializer) continue;
						const statement = declaration.parent.parent;
						protectedSpans.push({ start: statement.getStart(parsed), end: statement.end });
						ts.forEachChild(declaration.initializer, protectDependencies);
					}
				}
			}
			ts.forEachChild(node, protectDependencies);
		};
		const visit = (node: ts.Node): void => {
			if (ts.isCallExpression(node)) {
				const callee = unwrap(node.expression);
				const owner = ts.isPropertyAccessExpression(callee) ? unwrap(callee.expression) : undefined;
				const binding = ts.isIdentifier(callee) ? checker.getSymbolAtLocation(callee) : undefined;
				const namespace = owner && ts.isIdentifier(owner) ? checker.getSymbolAtLocation(owner) : undefined;
				const direct = binding && macroBindings.has(binding);
				const member = namespace && macroNamespaces.has(namespace);
				if (direct || member) {
					protectedSpans.push({ start: node.getStart(parsed), end: node.end });
					for (const argument of node.arguments) protectDependencies(argument);
					return;
				}
			}
			ts.forEachChild(node, visit);
		};
		visit(parsed);
	}
	// Macro expansion evaluates arguments and their referenced local initializers at build time.
	const ordered = sites.filter(({ site }) =>
		!protectedSpans.some((span) => site.start <= span.end && site.end >= span.start))
		.sort((a, b) => a.site.start - b.site.start || b.site.end - a.site.end);
	const edits = ordered.flatMap((row, index) => reachInsertions(source, row, directory, index));
	edits.sort((a, b) => b.offset - a.offset || b.order - a.order);
	return edits.reduce((result, edit) => replace(result, edit.offset, edit.offset, edit.text), source);
}
function gitCopyCommand(root: string, args: string[]): string {
	const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
	if (result.status !== 0) return fail("executionCopy", result.stderr || String(result.error));
	return result.stdout;
}
export function copyExecution(sourceRoot: string, target: string): void {
	if (existsSync(join(sourceRoot, ".git"))) {
		// Own detached index; share Git objects/history.
		gitCopyCommand(sourceRoot, ["worktree", "add", "--detach", target, "HEAD"]);
		// The detached worktree starts from HEAD; mirror tracked deletions before
		// overlaying dirty files so removed sources cannot reappear in the snapshot.
		const deleted = gitCopyCommand(sourceRoot, ["diff", "--name-only", "--diff-filter=D", "-z", "HEAD"])
			.split("\0").filter(Boolean);
		for (const path of deleted) rmSync(join(target, path), { force: true });
	}
	const skipped = new Set([".git", ".omo", "coverage", ".turbo"]); // Copy dependencies; reject external links.
	cpSync(sourceRoot, target, {
		recursive: true,
		verbatimSymlinks: true,
		mode: constants.COPYFILE_FICLONE,
		filter: (source) =>
			!relative(sourceRoot, source)
				.split("/")
				.some((part) => skipped.has(part)),
	});
}
export function removeExecution(root: string): void {
	if (existsSync(join(root, ".git"))) {
		const owner = gitCopyCommand(root, ["rev-parse", "--git-common-dir"]).trim();
		gitCopyCommand(root, ["worktree", "remove", "--force", root]);
		const list = spawnSync("git", ["--git-dir", owner, "worktree", "list", "--porcelain"], { encoding: "utf8" });
		if (list.status !== 0 || list.stdout.split("\n").includes(`worktree ${root}`))
			fail("cleanup", `Execution worktree registration remains: ${root}`);
	}
	rmSync(root, { recursive: true, force: true });
}
function snapshot(options: Options, target: string): void {
	copyExecution(options.root, target);
	// Standalone fixtures may supply a separate, minimal dependency installation.
	if (options.dependencies !== join(options.root, "node_modules"))
		cpSync(options.dependencies, join(target, "node_modules"), {
			recursive: true,
			dereference: true,
			mode: constants.COPYFILE_FICLONE,
		});
}
function verifySources(root: string, inventory: Inventory): void {
	for (const file of [...inventory.files, ...inventory.historical, ...inventory.configurations]) {
		if (sha256(readFileSync(pathIn(root, file.path))) !== file.sha256)
			fail("tamper", `Source hash mismatch: ${file.path}`);
	}
}
type TestsReceipt = {
	process: ProcessReceipt;
	junit: string;
	tests: number;
	failures: number;
	assertions: string[];
	valid: boolean;
};
/** Ceiling for the green-selection phases (baseline, reach), which run whole packages or instrumented files; `--suite-timeout` only bounds mutant executions. */
export const SELECTION_SUITE_TIMEOUT_MS = 3_600_000;
export type TestSelectionReceipt = {
	batches: TestsReceipt[];
	files: string[];
	tests: number;
	failures: number;
	assertions: string[];
	valid: boolean;
	exitCode: number;
};
function testGroups(root: string, tests: string[]): Map<string, string[]> {
	const groups = new Map<string, string[]>();
	for (const test of tests) {
		let cwd = dirname(join(root, test));
		while (cwd !== root && !existsSync(join(cwd, "package.json"))) cwd = dirname(cwd);
		const selected = groups.get(cwd) ?? [];
		selected.push(relative(cwd, join(root, test)));
		groups.set(cwd, selected);
	}
	return groups;
}
export function boundedArgv(argv: string[], capBytes: number, platform: string, hasPrlimit: boolean): string[] {
	if (platform !== "linux" || capBytes === 0) return argv;
	if (hasPrlimit) return ["prlimit", `--as=${capBytes}`, "--", ...argv];
	return ["sh", "-c", `ulimit -v ${Math.floor(capBytes / 1024)} && exec "$@"`, "sh", ...argv];
}

type ExecuteProcess = typeof execute;
export type TestRuntime = { execute: ExecuteProcess; platform: NodeJS.Platform; hasPrlimit: boolean };
function nativeTestRuntime(): TestRuntime {
	return { execute, platform: process.platform, hasPrlimit: Bun.which("prlimit") !== null };
}

export async function verifyMutantMemoryCap(
	capBytes: number,
	platform: string,
	hasPrlimit: boolean,
	run: ExecuteProcess = execute,
): Promise<void> {
	const receipt = await run(
		boundedArgv([process.execPath, "--smol", "-e", "process.stdout.write('cap-ok')"], capBytes, platform, hasPrlimit),
		process.cwd(),
		15_000,
		{},
		"mutant-memory-cap-self-check",
	);
	if (broken(receipt) || receipt.exitCode !== 0 || receipt.stdout !== "cap-ok") {
		setupProcessFailure = receipt;
		fail("infrastructure", `mutant memory cap unavailable: ${receipt.stderr.trim() || "Bun startup acknowledgement missing"}`);
	}
}

async function runTests(root: string, tests: string[], timeout: number, directory: string, python: string, suiteTimeout: number, environment: Record<string, string> = {}, capBytes = 0, runtime: TestRuntime = nativeTestRuntime()): Promise<TestSelectionReceipt> {
	const batches: TestsReceipt[] = [];
	const files: string[] = [];
	for (const [cwd, selected] of testGroups(root, tests)) {
		console.error(`[mutation] test package ${relative(root, cwd) || "."} (${selected.length} files)`);
		const batch = await runTestBatch(cwd, selected, timeout, directory, python, suiteTimeout, environment, capBytes, runtime);
		batches.push(batch);
		for (const suite of batch.junit.matchAll(/<testsuite\b([^>]*)>/g)) {
			const file = attribute(suite[1] ?? "", "file").replace(/^\.\//, "");
			files.push(relative(root, pathIn(cwd, file)));
		}
	}
	return {
		batches,
		files: [...new Set(files)],
		tests: batches.reduce((sum, batch) => sum + batch.tests, 0),
		failures: batches.reduce((sum, batch) => sum + batch.failures, 0),
		assertions: batches.flatMap((batch) => batch.assertions),
		valid: batches.every((batch) => batch.valid),
		exitCode: batches.every((batch) => batch.process.exitCode === 0) ? 0 : 1,
	};
}
async function runTestBatch(
	root: string,
	tests: string[],
	timeout: number,
	directory: string,
	python: string,
	suiteTimeout: number,
	environment: Record<string, string>,
	capBytes: number,
	runtime: TestRuntime,
): Promise<TestsReceipt> {
	const report = join(directory, "tests.xml");
	rmSync(report, { force: true });
	const processReceipt = await runtime.execute(
		boundedArgv([
			process.execPath,
			"--smol",
			"test",
			"--timeout",
			String(timeout),
			"--reporter=junit",
			`--reporter-outfile=${report}`,
			...tests.map((test) => `./${test}`),
		], capBytes, runtime.platform, runtime.hasPrlimit),
		root,
		Math.max(suiteTimeout, timeout * tests.length),
		{
			...(python ? {
				PATH: `${dirname(python)}:${process.env.PATH ?? ""}`,
				D945_PYTHON: python,
				QUALITY_MUTATION_PYTHON: python,
			} : {}),
			...environment,
		},
	);
	const xml = existsSync(report) ? readFileSync(report, "utf8") : "";
	const header = xml.match(/<testsuites\b[^>]*\btests="(\d+)"[^>]*\bfailures="(\d+)"/);
	return {
		process: processReceipt,
		junit: xml,
		tests: Number(header?.[1] ?? 0),
		failures: Number(header?.[2] ?? 0),
		assertions: assertionIdentities(xml, processReceipt.stderr),
		valid: !!header && validTestReport(xml, processReceipt),
	};
}
function validTestReport(xml: string, receipt: ProcessReceipt): boolean {
	return xml.trimEnd().endsWith("</testsuites>") && !broken(receipt);
}
function assertionDiagnostic(segment: string[]): boolean {
	const errors = segment.filter((item) => /^(?:error|[A-Za-z]*Error):/.test(item));
	const expectation = errors.length > 0 && errors.every((item) =>
		/^error: expect\(received\)\.(?:(?:not|resolves|rejects)\.)*[A-Za-z]+\(/.test(item),
	);
	const settlement = errors.length === 1 && /^error:\s*$/.test(errors[0] ?? "") &&
		/^Expected promise that (?:rejects\nReceived promise that resolved|resolves\nReceived promise that rejected):/m.test(segment.join("\n"));
	return expectation || settlement;
}
function appendAssertionFailure(output: string[], file: string, segment: string[], status: RegExpMatchArray | null): void {
	if (status?.[1] === "fail" && assertionDiagnostic(segment)) output.push(`${file}\0${status[2]}`);
}
export function failedAssertions(stderr: string): string[] {
	const failedNames: string[] = [];
	let file = "";
	let segment: string[] = [];
	for (const line of stderr.split("\n")) {
		const found = line.match(/^(?:::group::)?([^\s].*\.[cm]?[jt]sx?):$/)?.[1];
		if (found) { file = found.replace(/^\.\//, ""); segment = []; }
		const status = line.match(/^\((pass|fail)\) (.*?)(?: \[[\d.]+ms\])?$/);
		if (status) { appendAssertionFailure(failedNames, file, segment, status); segment = []; }
		else segment.push(line);
	}
	return failedNames;
}
function claimAssertionFailure(failed: string[], file: string, name: string, uniqueCase: boolean): boolean {
	let index = failed.indexOf(`${file}\0${name}`);
	if (index < 0 && uniqueCase) {
		const suffix = `\0${name}`;
		const candidates = failed.flatMap((value, position) => value.endsWith(suffix) ? [position] : []);
		if (candidates.length === 1) index = candidates[0] ?? -1;
	}
	if (index < 0) return false;
	failed.splice(index, 1);
	return true;
}
export function assertionIdentities(xml: string, stderr: string): string[] {
	const failedNames = failedAssertions(stderr);
	const assertionCases = [
		...xml.matchAll(/<testcase\b([^>]+)(?<!\/)>([\s\S]*?)<\/testcase>/g),
	].filter(
		(match) =>
			/<failure\b[^>]*\btype="AssertionError"(?:\s[^>]*)?\s*\/?>(?:[\s\S]*?<\/failure>)?/.test(
				match[2] ?? "",
			) &&
			(/\bassertions="[1-9]\d*"/.test(match[1] ?? "") ||
				// Bun 1.4.1 reports zero assertions for .resolves on a rejection.
				// Require its structured matcher diagnostic as well as the associated
				// stderr failure; an ordinary exception still cannot count as a kill.
				(/\bmessage="expect\(received\)\.resolves\.[A-Za-z]+\(/.test(match[2] ?? "") &&
					/Expected promise that resolves&#10;Received promise that rejected:/.test(
						match[2] ?? "",
					))),
	);
	const assertions = assertionCases.flatMap((match) => {
		const attributes = match[1] ?? "";
		const file = attribute(attributes, "file").replace(/^\.\//, "");
		const name = attribute(attributes, "name");
		const group = attribute(attributes, "classname");
		const qualifiedName = group ? `${group} > ${name}` : name;
		const uniqueCase = assertionCases.filter((candidate) => {
			const fields = candidate[1] ?? "";
			const owner = attribute(fields, "classname");
			return (owner ? `${owner} > ${attribute(fields, "name")}` : attribute(fields, "name")) === qualifiedName;
		}).length === 1;
		if (!claimAssertionFailure(failedNames, file, qualifiedName, uniqueCase)) return [];
		return [JSON.stringify({ file, name, line: attribute(attributes, "line") })];
	});
	return assertions;
}
function attribute(attributes: string, name: string): string {
	const encoded = attributes.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? "";
	return encoded
		.replaceAll("&quot;", '"')
		.replaceAll("&apos;", "'")
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&amp;", "&");
}
function green(receipt: TestSelectionReceipt): boolean {
	return (
		receipt.valid && receipt.tests > 0 && receipt.failures === 0 && receipt.exitCode === 0
	);
}
type RedBatch = Pick<TestsReceipt, "junit" | "failures" | "valid"> & {
	process: Pick<ProcessReceipt, "exitCode" | "signal" | "timedOut" | "overflow" | "stderr">;
};
/** Red test selection report: one line per failing testcase and per process whose JUnit
 * does not explain its exit, plus the campaign error naming the first five of them. */
export function describeRedBaseline(batches: readonly RedBatch[]): { lines: string[]; summary: string } {
	const lines: string[] = [];
	for (const batch of batches) {
		for (const [, attributes = "", body = ""] of batch.junit.matchAll(/<testcase\b([^>]+)(?<!\/)>([\s\S]*?)<\/testcase>/g)) {
			const failure = body.match(/<(?:failure|error)\b([^>]*)/);
			if (!failure) continue;
			const group = attribute(attributes, "classname");
			const message = attribute(failure[1] ?? "", "message").replaceAll("&#10;", " ").trim().slice(0, 300);
			lines.push(`${attribute(attributes, "file").replace(/^\.\//, "")} > ${group ? `${group} > ` : ""}${attribute(attributes, "name")}: ${message}`);
		}
		const { exitCode, signal, timedOut, overflow, stderr } = batch.process;
		if (!batch.valid || (exitCode !== 0 && batch.failures === 0))
			lines.push(`process exit=${exitCode} signal=${signal} timedOut=${timedOut} overflow=${overflow} junit=${batch.valid ? "valid" : "invalid"}: ${stderr.trimEnd().split("\n").slice(-20).join(" | ").slice(-1000)}`);
	}
	const named = lines.slice(0, 5).join("; ") + (lines.length > 5 ? ` (+${lines.length - 5} more)` : "");
	return { lines, summary: `baseline test selection is not green${lines.length ? `: ${named}` : ""}` };
}
function siteOwners(candidates: Candidate[]): Map<string, string> {
	const owners = new Map<string, string>();
	for (const candidate of candidates) owners.set(`${candidate.path}\u0000${JSON.stringify(candidate.site)}`, candidate.id);
	return owners;
}
function recordReach(map: Map<string, ProbeEvidence>, candidates: Candidate[], owners: Map<string, string>, markers: string, test: string): void {
	for (const candidate of candidates) {
		const marker = join(markers, owners.get(`${candidate.path}\u0000${JSON.stringify(candidate.site)}`) ?? candidate.id);
		const evidence = map.get(candidate.id);
		if (!evidence || !existsSync(marker)) continue;
		evidence.reached = true;
		evidence.tests = [...(evidence.tests ?? []), test];
		evidence.markerSha256 = sha256(readFileSync(marker, "utf8"));
	}
}
async function buildReachMap(options: Options, frozen: string, temporary: string, candidates: Candidate[], tests: string[], executionTreeSha256: string): Promise<{ map: Map<string, ProbeEvidence>; receipt: ReachMap }> {
	const directory = join(temporary, "reach"), markers = join(directory, "markers");
	copyExecution(frozen, directory);
	mkdirSync(markers, { recursive: true });
	const byPath = new Map<string, Candidate[]>();
	for (const candidate of candidates)
		if (!candidate.operator.startsWith("py-")) byPath.set(candidate.path, [...(byPath.get(candidate.path) ?? []), candidate]);
	// Probes are served by a module-load overlay, so the reach copy keeps the
	// frozen bytes for tests that read their own sources as text.
	const overlay: ReachOverlay = { root: directory, instrumented: join(temporary, "reach-instrumented"), paths: [] };
	for (const [candidatePath, rows] of byPath) {
		const source = mutationSource(directory, candidatePath);
		const unique = [...new Map(rows.map((row) => [`${row.site.start}:${row.site.end}:${row.site.mode}`, row])).values()];
		const target = join(overlay.instrumented, relative(directory, source.path));
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, hostWith(source, instrument(source.source, unique.map((row) => ({ ...row, tests })), markers)));
		overlay.paths.push(relative(directory, source.path));
	}
	const overlayFile = join(temporary, "reach-overlay.txt");
	writeFileSync(overlayFile, encodeOverlay(overlay));
	const environment = {
		[OVERLAY_ENVIRONMENT]: overlayFile,
		BUN_OPTIONS: `${process.env.BUN_OPTIONS ?? ""} --preload=${stagePreload(temporary)}`.trim(),
	};
	const map = new Map<string, ProbeEvidence>();
	for (const candidate of candidates) map.set(candidate.id, { reached: false, markerSha256: sha256(""), tests: [] });
	const runs: { test: string; receipt: TestSelectionReceipt }[] = [];
	const owners = siteOwners(candidates);
	for (const test of tests) {
		if (readFileSync(join(directory, test), "utf8").trim() === "") continue;
		rmSync(markers, { recursive: true, force: true });
		mkdirSync(markers);
		const receipt = await runTests(directory, [test], options.timeout, temporary, options.python, SELECTION_SUITE_TIMEOUT_MS, environment, 0, options.testRuntime);
		if (!receipt.valid || receipt.failures !== 0 || receipt.exitCode !== 0) {
			const assertions = receipt.assertions.length ? receipt.assertions.join(", ") : "<none>";
			const stderr = receipt.batches.map((batch) => batch.process.stderr).join("\n").slice(-2048);
			console.error(`[mutation] reach test not green: ${test} assertions: ${assertions}\n${stderr}`);
			if (options.failureOutput)
				writeFileSync(options.failureOutput, JSON.stringify({ version: 1, test, receipt }), { flag: "w" });
			throw new MutationError("reachMap", `Reach test is not green: ${test}`, { test, receipt });
		}
		runs.push({ test, receipt });
		recordReach(map, candidates, owners, markers, test);
	}
	console.error(`[mutation] reach map: ${[...map.values()].filter((value) => value.reached).length}/${candidates.length} reached`);
	const body = { version: 1 as const, executionTreeSha256, candidatesSha256: sha256(JSON.stringify(candidates)), testsSha256: sha256(JSON.stringify(tests)), sites: candidates.map((candidate) => ({ id: candidate.id, path: candidate.path, sourceSha256: candidate.sourceSha256, site: candidate.site, tests: map.get(candidate.id)?.tests ?? [] })), runs, complete: true };
	return { map, receipt: { ...body, instrumentation: [], sha256: sha256(JSON.stringify(body)) } };
}

function defaultResult(candidate: Candidate, tests: string[], selected = true): Result {
	return {
		...candidate,
		selected,
		outcome: "uncompleted",
		typecheck: "not-run",
		testSelection: sha256(JSON.stringify(tests)),
		assertionIdentities: [],
		coverage: null,
		junitReports: [],
		receipts: [],
		reason: selected ? "execution-not-completed" : "outside-pilot-selection",
		restored: true,
	};
}
export function mutationSource(
	root: string,
	candidatePath: string,
): {
	path: string;
	source: string;
	host: string;
	start: number;
	end: number;
} {
	const [hostPath, binding] = candidatePath.split("#");
	const path = pathIn(root, hostPath ?? "");
	const host = readFileSync(path, "utf8");
	if (!binding) return { path, source: host, host, start: 0, end: host.length };
	if (binding !== "PYTHON_DRIVER") return fail("schema", "Unsupported virtual binding");
	const source = ts.createSourceFile(path, host, ts.ScriptTarget.Latest, true);
	const bindings: ts.TaggedTemplateExpression[] = [];
	function visit(node: ts.Node): void {
		if (
			ts.isVariableDeclaration(node) &&
			node.name.getText(source) === binding &&
			node.initializer &&
			ts.isTaggedTemplateExpression(node.initializer)
		)
			bindings.push(node.initializer);
		ts.forEachChild(node, visit);
	}
	visit(source);
	const init = bindings[0];
	if (
		bindings.length !== 1 ||
		!init ||
		init.tag.getText(source) !== "String.raw" ||
		!ts.isNoSubstitutionTemplateLiteral(init.template) ||
		init.template.rawText === undefined
	)
		return fail("schema", "Virtual source is not a unique raw template");
	return { path, source: init.template.rawText, host, start: init.getStart(source), end: init.end };
}
function hostWith(source: ReturnType<typeof mutationSource>, content: string): string {
	return source.start === 0 && source.end === source.host.length
		? content
		: replace(source.host, source.start, source.end, JSON.stringify(content));
}
function writeMutation(source: ReturnType<typeof mutationSource>, content: string): void {
	writeFileSync(source.path, hostWith(source, content));
}
export async function pythonWorker(
	options: Pick<Options, "python" | "decision" | "timeout">,
	source: string,
	directory: string,
	mode: string,
	site?: Site,
	marker?: string,
): Promise<ProcessReceipt> {
	const input = join(directory, "python-input.py");
	writeFileSync(input, source);
	return await execute(
		[
			options.python,
			join(import.meta.dir, "quality-mutation/python-engine.py"),
			"--source",
			input,
			"--decision",
			options.decision,
			"--mode",
			mode,
			...(site && marker
				? ["--start", String(site.start), "--end", String(site.end), "--marker", marker]
				: []),
		],
		directory,
		options.timeout,
		{},
		`python-${mode}`,
	);
}
function probeKey(
	candidate: Candidate,
	instrumentedSource: string,
	options: Options,
	tests: string[],
): string {
	return sha256(JSON.stringify({
		path: candidate.path,
		sourceSha256: candidate.sourceSha256,
		site: candidate.site,
		instrumentedSourceSha256: sha256(instrumentedSource),
		testsSha256: sha256(JSON.stringify(tests)),
		contractSha256: options.contractHash,
		inventorySha256: options.inventoryHash,
		decisionSha256: options.decisionHash,
		inventoryToolSha256: options.inventoryToolHash,
		runtime: {
			bun: Bun.version,
			node: process.execPath,
			typescript: ts.version,
			python: options.python
				? (() => {
					const executable = Bun.which(options.python) ?? options.python;
					return existsSync(executable) ? sha256(readFileSync(executable)) : executable;
				})()
				: "",
			mode: candidate.site.mode,
		},
	}));
}
type CompilerCheck = { proof: CompilerProof } | { failure: string };
type CandidateContext = {
	candidate: Candidate;
	options: Options;
	contract: Contract;
	tests: string[];
	run: string;
	root: string;
	result: Result;
	probeCache: Map<string, ProbeEvidence>;
	compiler: MutationCompilerWorker | null;
	checked: CompilerCheck | undefined;
};

async function checkMutation(context: CandidateContext, mutated: string, python: boolean): Promise<boolean> {
	const { options, run, root, result, candidate } = context;
	if (python) {
		const compiled = await pythonWorker(options, mutated, run, "compile");
		result.receipts.push(compiled);
		if (broken(compiled) || ![0, 1].includes(compiled.exitCode ?? -1)) {
			result.outcome = "infrastructure";
			result.reason = "python-compiler-process";
			return false;
		}
		if (object(decode(compiled.stdout)).valid !== true) {
			result.typecheck = "invalid";
			result.outcome = "invalid";
			result.reason = "python-compiler-diagnostics";
			return false;
		}
	}
	const hostPath = candidate.path.split("#")[0] ?? fail("schema", "Missing candidate host");
	const content = readFileSync(pathIn(root, hostPath), "utf8");
	if (!context.compiler) return fail("infrastructure", "Compiler engine unavailable");
	const request = {
			executionTreeSha256: context.compiler.identity,
			candidateId: candidate.id,
			path: hostPath,
			originalSha256: sha256(readFileSync(pathIn(join(dirname(run), "frozen"), hostPath))),
			sourceSha256: sha256(content),
			content,
	};
	const checked = context.checked;
	const validation = python ? context.compiler.check(request) : checked && "proof" in checked
		? Promise.resolve(checked.proof)
		: Promise.reject(new Error(checked && "failure" in checked ? checked.failure : "Missing compiler batch result"));
	return validation.then((proof) => {
		if (!compilerProofMatches(request, proof)) return fail("tamper", "Compiler proof differs from candidate source");
		result.compilerProof = proof;
		result.typecheck = proof.valid ? "valid" : "invalid";
		if (!proof.valid) { result.outcome = "invalid"; result.reason = "compiler-diagnostics"; return false; }
		return true;
	}, (error: Error) => {
		result.compilerFailure = error.message;
		result.outcome = "infrastructure";
		result.reason = "typecheck-engine";
		return false;
	});
}

async function probeCandidate(context: CandidateContext, source: ReturnType<typeof mutationSource>): Promise<boolean> {
	const { candidate, options, tests, run, root, result, probeCache } = context;
	const marker = join(run, "hit");
	const instrumented = await pythonWorker(options, source.source, run, "probe", candidate.site, marker);
	result.receipts.push(instrumented);
	if (broken(instrumented) || instrumented.exitCode !== 0) {
		result.outcome = "infrastructure";
		result.reason = "python-instrumentation-process";
		return false;
	}
	const probedSource = text(object(decode(instrumented.stdout)).source);
	const key = probeKey(candidate, probedSource, options, tests);
	const cached = probeCache.get(key);
	if (cached) {
		result.coverage = cached;
		if (!cached.reached) {
			result.outcome = "noCoverage";
			result.reason = "original-runtime-site-not-reached";
			return false;
		}
		return true;
	}
	writeMutation(source, probedSource);
	const probe = await runTests(root, tests, options.timeout, run, options.python, options.suiteTimeout, {}, options.mutantMemoryBytes, options.testRuntime);
	result.receipts.push(...probe.batches.map((batch) => batch.process));
	result.junitReports.push(...probe.batches.map((batch) => batch.junit));
	if (!green(probe)) {
		result.outcome = "infrastructure";
		result.reason = "baseline-probe-not-green";
		return false;
	}
	const hit = existsSync(marker) ? readFileSync(marker, "utf8") : "";
	result.coverage = { reached: hit === "1", markerSha256: sha256(hit), tests };
	if (existsSync(marker) && hit !== "1") {
		result.outcome = "infrastructure";
		result.reason = "malformed-coverage-marker";
		return false;
	}
	probeCache.set(key, result.coverage);
	if (!result.coverage.reached) {
		result.outcome = "noCoverage";
		result.reason = "original-runtime-site-not-reached";
		return false;
	}
	return true;
}

type CandidateExecution = {
	candidate: Candidate;
	compilerWorker: MutationCompilerWorker | null;
	checked: CompilerCheck | undefined;
	options: Options;
	contract: Contract;
	temporary: string;
	tests: string[];
	result: Result;
	frozenSourceSha256: string;
};

type CandidateWorkspace = {
	run: string;
	root: string;
	source: ReturnType<typeof mutationSource>;
};

function prepareCandidate(context: CandidateExecution): { workspace: CandidateWorkspace; mutated: string } {
	const { candidate, temporary } = context;
	const run = join(temporary, "candidate");
	const root = join(run, "source");
	mkdirSync(run, { recursive: true });
	let prepared = false;
	try {
		copyExecution(join(temporary, "frozen"), root);
		const source = mutationSource(root, candidate.path);
		if (sha256(source.source) !== candidate.sourceSha256)
			return fail("tamper", "Candidate snapshot drift");
		const mutated = replace(source.source, candidate.startOffset, candidate.endOffset, candidate.replacement);
		writeMutation(source, mutated);
		prepared = true;
		return { workspace: { run, root, source }, mutated };
	} finally {
		if (!prepared) {
			removeExecution(root);
			rmSync(run, { recursive: true, force: true });
		}
	}
}

function behavioralAssertion(tested: Awaited<ReturnType<typeof runTests>>): boolean {
	return tested.valid && tested.exitCode === 1 && tested.failures > 0 && tested.assertions.length === tested.failures;
}

function resourceExhausted(batch: TestsReceipt): boolean {
	const receipt = batch.process;
	if (receipt.spawnError || receipt.overflow) return false;
	const crashed = receipt.signal !== null || (receipt.exitCode !== null && receipt.exitCode !== 0);
	return crashed && !batch.junit.trimEnd().endsWith("</testsuites>");
}

function nonTerminationReason(tested: TestSelectionReceipt): string {
	if (tested.batches.some((batch) => batch.process.timedOut)) return "suite-timeout";
	if (tested.batches.some(resourceExhausted)) return "resource-exhaustion";
	return "";
}

export function classifyCandidate(result: Pick<Result, "outcome" | "reason" | "assertionIdentities">, tested: TestSelectionReceipt): void {
	const nonTermination = nonTerminationReason(tested);
	if (nonTermination) {
		// Selection was green before mutation: a timeout or a crashed test child
		// without a complete report is a mutant kill, not an environmental fault.
		result.outcome = "killed";
		result.reason = nonTermination;
		return;
	}
	if (green(tested)) {
		result.outcome = "survived";
		result.reason = "green-mutated-test-selection";
		return;
	}
	if (behavioralAssertion(tested)) {
		result.outcome = "killed";
		result.reason = "behavioral-assertion";
		result.assertionIdentities = tested.assertions;
		return;
	}
	result.outcome = "infrastructure";
	result.reason = "failure-without-complete-behavioral-assertions";
}

async function executeMutatedCandidate(context: CandidateExecution, workspace: CandidateWorkspace, mutated: string): Promise<void> {
	const { candidate, compilerWorker, checked, options, contract, tests, result } = context;
	const { run, root, source } = workspace;
	const python = candidate.operator.startsWith("py-");
	const candidateContext: CandidateContext = {
		candidate, options, contract, tests, run, root, result, probeCache: new Map(),
		compiler: compilerWorker, checked,
	};
	if (!(await checkMutation(candidateContext, mutated, python))) return;
	if (python && !(await probeCandidate(candidateContext, source))) return;
	removeExecution(root);
	copyExecution(join(context.temporary, "frozen"), root);
	writeMutation(source, mutated);
	const tested = await runTests(root, tests, options.timeout, run, options.python, options.suiteTimeout, {}, options.mutantMemoryBytes, options.testRuntime);
	result.receipts.push(...tested.batches.map((batch) => batch.process));
	result.junitReports.push(...tested.batches.map((batch) => batch.junit));
	classifyCandidate(result, tested);
}

function cleanupCandidate(workspace: CandidateWorkspace | undefined, result: Result, frozenSourceSha256: string): void {
	if (!workspace) return;
	const { path, host: original } = workspace.source;
	if (existsSync(dirname(path))) {
		writeFileSync(path, original);
		result.restored = sha256(readFileSync(path)) === frozenSourceSha256;
	}
	removeExecution(workspace.root);
	rmSync(workspace.run, { recursive: true, force: true });
}

async function executeCandidate(context: CandidateExecution): Promise<Result> {
	let workspace: CandidateWorkspace | undefined;
	try {
		const prepared = prepareCandidate(context);
		workspace = prepared.workspace;
		await executeMutatedCandidate(context, workspace, prepared.mutated);
	} catch {
		context.result.outcome = "infrastructure";
		context.result.reason = mutationFailure.current?.code ?? "candidate-filesystem-or-process-failure";
	} finally {
		cleanupCandidate(workspace, context.result, context.frozenSourceSha256);
	}
	return context.result;
}

async function runCandidate(
	candidate: Candidate,
	compilerWorker: MutationCompilerWorker | null,
	checked: CompilerCheck | undefined,
	options: Options,
	contract: Contract,
	temporary: string,
	tests: string[],
	reachMap: Map<string, ProbeEvidence>,
): Promise<Result> {
	const result = defaultResult(candidate, tests);
	const evidence = reachMap.get(candidate.id);
	const frozenSourceSha256 = sha256(mutationSource(join(temporary, "frozen"), candidate.path).host);
	result.coverage = evidence ?? null;
	if (!candidate.operator.startsWith("py-") && !evidence?.reached) {
		result.coverage = evidence ?? { reached: false, markerSha256: sha256(""), tests: [] };
		result.restored = sha256(mutationSource(join(temporary, "frozen"), candidate.path).host) === frozenSourceSha256;
		result.outcome = "noCoverage";
		result.reason = "original-runtime-site-not-reached";
		return result;
	}
	return executeCandidate({ candidate, compilerWorker, checked, options, contract, temporary, tests, result, frozenSourceSha256 });
}
function argumentsMap(argv: string[]): Map<string, string[]> {
	const values = new Map<string, string[]>();
	for (let index = 0; index < argv.length; index++) {
		const key = argv[index];
		if (!key?.startsWith("--")) return fail("arguments", "Expected named arguments");
		const value = key === "--pilot" ? "true" : argv[++index];
		if (!value || value.startsWith("--")) return fail("missingInput", `Missing ${key} value`);
		values.set(key, [...(values.get(key) ?? []), value]);
	}
	return values;
}
export function pythonExecutable(command: string): string {
	return Bun.which(command) ?? command;
}
function shardFrom(values: Map<string, string[]>, pilot: boolean): Options["shard"] {
	const shardIndex = values.get("--shard")?.[0];
	const shardCount = values.get("--shard-count")?.[0];
	const progress = values.get("--progress")?.[0];
	if (shardIndex === undefined && shardCount === undefined && progress === undefined) return null;
	const index = Number(shardIndex),
		count = Number(shardCount);
	if (
		!progress ||
		!Number.isSafeInteger(count) ||
		count < 1 ||
		count > 4096 ||
		!Number.isSafeInteger(index) ||
		index < 0 ||
		index >= count
	)
		return fail(
			"arguments",
			"Sharded execution requires --shard, --shard-count and --progress with 0 <= shard < shard-count",
		);
	if (pilot) return fail("arguments", "--shard is incompatible with pilot selection");
	return { index, count, progress: resolve(progress) };
}
function optionsFrom(values: Map<string, string[]>, testRuntime: TestRuntime): Options {
	const names = [
		"root",
		"contract",
		"inventory",
		"decision",
		"inventory-tool",
		"contract-sha256",
		"inventory-sha256",
		"decision-sha256",
		"inventory-tool-sha256",
		"dependencies",
		"python",
		"test",
		"target",
		"operator",
		"limit",
		"max-candidates",
		"timeout",
		"suite-timeout",
		"mutant-memory-mb",
		"budget",
		"pilot",
		"failure-output",
		"shard",
		"shard-count",
		"progress",
		"checkpoint-results",
	];
	for (const [key, entries] of values)
		if (
			!names.includes(key.slice(2)) ||
			(entries.length > 1 && !["--test", "--target", "--operator"].includes(key))
		)
			return fail("arguments", `Unsupported or duplicate argument ${key}`);
	function required(key: string): string {
		return values.get(`--${key}`)?.[0] ?? fail("missingInput", `Required --${key}`);
	}
	function bound(key: string, fallback: number, maximum: number): number {
		const value = Number(values.get(`--${key}`)?.[0] ?? fallback);
		if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
			return fail("arguments", `Invalid --${key}`);
		return value;
	}
	const configuredPython = values.get("--python")?.[0];
	const pilot = ["--pilot", "--limit", "--test", "--target", "--operator"].some((key) =>
		values.has(key),
	);
	const shard = shardFrom(values, pilot);
	return {
		root: realpathSync(required("root")),
		contract: resolve(required("contract")),
		inventory: resolve(required("inventory")),
		decision: resolve(required("decision")),
		inventoryTool: resolve(required("inventory-tool")),
		contractHash: required("contract-sha256"),
		inventoryHash: required("inventory-sha256"),
		decisionHash: required("decision-sha256"),
		inventoryToolHash: required("inventory-tool-sha256"),
		dependencies: realpathSync(required("dependencies")),
		python: configuredPython ? pythonExecutable(configuredPython) : Bun.which("python3") ?? "",
		tests: values.get("--test") ?? [],
		targets: values.get("--target") ?? [],
		families: values.get("--operator") ?? [],
		limit: bound("limit", 1000000, 1000000),
		maxCandidates: bound("max-candidates", 10000, 1000000),
		timeout: bound("timeout", 15000, 15000),
		suiteTimeout: bound("suite-timeout", 15000, 3600000),
		mutantMemoryBytes: bound("mutant-memory-mb", 6144, 1048576) * 1024 * 1024,
		testRuntime,
		budget: bound("budget", 3600000, 604800000),
		checkpointResults: bound("checkpoint-results", 8, 1000000),
		failureOutput: values.get("--failure-output")?.[0] ?? "",
		pilot,
		shard,
	};
}
async function canonicalVerification(options: Options): Promise<ProcessReceipt> {
	pinned(options.inventoryTool, options.inventoryToolHash);
	const receipt = await execute(
		[
			process.execPath,
			options.inventoryTool,
			"--root",
			options.root,
			"--contract",
			options.contract,
			"--inventory",
			options.inventory,
		],
		options.root,
		options.timeout,
		{},
		"setup-canonical-inventory",
	);
	if (broken(receipt) || receipt.exitCode !== 0) {
		setupProcessFailure = receipt;
		return fail(
			"incompleteInventory",
			`Canonical inventory verification failed: ${receipt.stderr.slice(0, 2000)}`,
		);
	}
	if (JSON.stringify(decode(receipt.stdout)) !== JSON.stringify(readJson(options.inventory)))
		return fail("incompleteInventory", "Canonical verification returned a different inventory");
	return receipt;
}
async function enumeratePython(
	options: Options,
	temporary: string,
	frozen: string,
	enumerated: ReturnType<typeof enumerate>,
) {
	const python = object(object(object(readJson(options.decision)).contract).embeddedPython);
	const pythonFamilies = array(object(python.mutation).operators).map((value) =>
		text(object(value).id),
	);
	if (
		sha256(JSON.stringify(python.mutation)) !==
		"072579aa17fe6dd80df6fd0085a9c6bdffec66a3510edc035e30f067d4968331"
	)
		return fail(
			"operatorContract",
			"Python operator definitions differ from frozen d945-python-mutation@1",
		);
	const pythonRows = enumerated.census.filter(
		(row) => row.language === "python" && mutable(row),
	);
	const pythonReceipts: ProcessReceipt[] = [];
	const pythonCapability = pythonRows.length
		? {
			implemented: true,
			algorithm: "d945-python-mutation@1",
			requiredVersion: text(object(python.runtime).version),
			executable: options.python,
			executableSha256: options.python ? sha256(readFileSync(options.python)) : "",
			engineSha256: sha256(
				readFileSync(join(import.meta.dir, "quality-mutation/python-engine.py")),
			),
			probe: await execute([options.python, "--version"], temporary, options.timeout),
			receipts: pythonReceipts,
		}
		: null;
	for (const row of pythonRows) {
		const source = mutationSource(frozen, row.path);
		if (sha256(source.source) !== row.sha256)
			return fail("tamper", `Python source drift: ${row.path}`);
		const parsed = await pythonWorker(options, source.source, temporary, "enumerate");
		pythonReceipts.push(parsed);
		const data =
			!broken(parsed) && [0, 1].includes(parsed.exitCode ?? -1)
				? object(decode(parsed.stdout))
				: null;
		row.syntax = data?.valid === true ? "parsed" : "python-analysis-error";
		if (row.syntax !== "parsed")
			enumerated.errors.push(`${row.path}: Python parser/runtime failure`);
		row.astNodes = data?.astNodes === undefined ? 0 : number(data.astNodes);
		const candidates =
			data?.valid === true
				? array(data.candidates).map((value): Candidate => {
					const item = object(value);
					const site = object(item.site);
					const mode = text(site.mode);
					if (mode !== "python-expression" && mode !== "python-statement")
						return fail("schema", "Invalid Python probe mode");
					const replacement = text(item.replacement);
					const startOffset = number(item.startOffset);
					const endOffset = number(item.endOffset);
					const replacementSha256 = sha256(replacement);
					const operator = text(item.operator);
					if (
						!pythonFamilies.includes(operator) ||
						endOffset > source.source.length ||
						startOffset >= endOffset
					)
						return fail("schema", "Invalid Python candidate");
					return {
						id: sha256(`${row.path}\0${startOffset}\0${endOffset}\0${replacementSha256}`),
						path: row.path,
						sourceSha256: row.sha256,
						startOffset,
						endOffset,
						operator,
						replacement,
						replacementSha256,
						site: { start: number(site.start), end: number(site.end), mode },
					};
				})
				: [];
		enumerated.candidates.push(...candidates);
		row.operators = pythonFamilies.map((operator) => {
			const count = candidates.filter((candidate) => candidate.operator === operator).length;
			return {
				operator,
				candidates: count,
				reason: count
					? "enumerated"
					: row.syntax === "parsed"
						? "no-applicable-runtime-AST-site"
						: row.syntax,
			};
		});
	}
	return pythonCapability;
}

function selectedCandidates(options: Options, candidates: Candidate[]): Candidate[] {
	return candidates.filter((candidate) =>
		(!options.targets.length || options.targets.includes(candidate.path)) &&
		(!options.families.length || options.families.includes(candidate.operator)),
	).slice(0, options.pilot ? options.limit : undefined);
}
async function compilerBatch(
	candidates: Candidate[], start: number, selected: Set<string>,
	reach: Map<string, ProbeEvidence>, compiler: MutationCompilerWorker, temporary: string,
): Promise<Map<string, CompilerCheck>> {
	const path = candidates[start]?.path;
	const batch: Candidate[] = [];
	for (let index = start; index < candidates.length && batch.length < COMPILER_BATCH_SIZE; index++) {
		const candidate = candidates[index];
		if (!candidate || candidate.path !== path) break;
		if (selected.has(candidate.id) && reach.get(candidate.id)?.reached) batch.push(candidate);
	}
	const requests = batch.map((candidate) => {
		const source = mutationSource(join(temporary, "frozen"), candidate.path);
		const content = replace(source.source, candidate.startOffset, candidate.endOffset, candidate.replacement);
		return {
			executionTreeSha256: compiler.identity, candidateId: candidate.id, path: candidate.path,
			originalSha256: sha256(source.host), sourceSha256: sha256(content), content,
		};
	});
	return compiler.checkBatch(requests).then(
		(proofs) => new Map(proofs.map((proof) => [proof.candidateId, { proof }])),
		(error: Error) => new Map(batch.map((candidate) => [candidate.id, { failure: error.message }])),
	);
}

/** Longest wall-clock one test run over `tests` can hold: every package batch
 * is killed at max(suite timeout, per-test timeout x files). */
function testRunDeadline(root: string, tests: string[], options: Options): number {
	let total = 0;
	for (const selected of testGroups(root, tests).values())
		total += Math.max(options.suiteTimeout, options.timeout * selected.length);
	return total;
}
// Worst-case wall clock of one candidate, summed from every deadline on its
// path, so a candidate is dispatched only when it can settle inside the
// budget and the wrapper deadline never kills a run that honored its budget.
// A compiler request is bounded by one `--timeout` per contract project (the
// worker's deadline), and the worker's first request also pays its
// initialization under the same deadline. A Python candidate runs the compile
// and probe workers (one `--timeout` each), one compiler request, the probe
// test run and the mutant test run; a reached TS/JS candidate runs one compiler
// request and one test run; an unreached one runs nothing.
function candidateReserve(context: ExecutionContext, candidate: Candidate, tests: string[]): number {
	const { options, contract, compilerWorker, reachMap } = context;
	const python = candidate.operator.startsWith("py-");
	if (!python && !reachMap.get(candidate.id)?.reached) return 0;
	const testRun = testRunDeadline(options.root, tests, options);
	const compilerRequest = options.timeout * Math.max(1, contract.projects.length);
	const compiler = compilerWorker?.initialized ? compilerRequest : 2 * compilerRequest;
	return python
		? 2 * options.timeout + compiler + 2 * testRun
		: compiler + testRun;
}
function budgetAllows(context: ExecutionContext, candidate: Candidate, tests: string[]): boolean {
	return Date.now() - context.started + candidateReserve(context, candidate, tests) <= context.options.budget;
}
type ExecutionContext = {
	options: Options;
	compilerWorker: MutationCompilerWorker | null;
	contract: Contract;
	inventory: Inventory;
	temporary: string;
	executionTreeSha256: string;
	started: number;
	enumerated: ReturnType<typeof enumerate>;
	tests: string[];
	errors: string[];
	reachMap: Map<string, ProbeEvidence>;
};
async function executeSelection(context: ExecutionContext): Promise<Result[]> {
	const { options, compilerWorker, contract, temporary, enumerated, tests, errors, reachMap } = context;
	const results: Result[] = [];
	const selected = selectedCandidates(options, enumerated.candidates);
	if (!selected.length) errors.push("zero selected candidates");
	const selectedIds = new Set(selected.map((candidate) => candidate.id));
	let executed = 0;
	let checked = new Map<string, CompilerCheck>();
	for (const [index, candidate] of enumerated.candidates.entries()) {
		if (!selectedIds.has(candidate.id)) results.push(defaultResult(candidate, tests, false));
		else if (
			errors.length ||
			executed >= options.maxCandidates ||
			!budgetAllows(context, candidate, reachMap.get(candidate.id)?.tests ?? tests)
		)
			results.push(defaultResult(candidate, tests));
		else {
			console.error(`[mutation] mutant ${executed + 1}/${selected.length} start ${candidate.path}:${candidate.startOffset} ${candidate.operator}`);
			if (compilerWorker && !candidate.operator.startsWith("py-") && reachMap.get(candidate.id)?.reached && !checked.has(candidate.id))
				checked = await compilerBatch(enumerated.candidates, index, selectedIds, reachMap, compilerWorker, temporary);
			const result = await runCandidate(candidate, compilerWorker, checked.get(candidate.id), options, contract, temporary, reachMap.get(candidate.id)?.tests ?? tests, reachMap);
			results.push(result);
			checked.delete(candidate.id);
			executed++;
			console.error(`[mutation] mutant ${executed}/${selected.length} ${result.outcome}: ${result.reason}`);
		}
	}
	return results;
}

type CarriedResult = { candidateId: string; outcome: Outcome; sourceSha256: string; document: ObjectValue };
type ShardProgress = { carried: Map<string, CarriedResult>; proofs: ObjectValue[]; run: string };

function shardOutcome(value: Json | undefined): Outcome {
	const known: Outcome[] = ["killed", "survived", "noCoverage", "invalid", "infrastructure", "uncompleted"];
	return known.find((outcome) => outcome === value) ?? fail("progress", "Invalid recorded outcome");
}
function progressLine(row: object): string {
	return `${JSON.stringify(row, diagnosticField)}\n`;
}
function carriedResult(row: ObjectValue, carried: Map<string, CarriedResult>): void {
	const result = object(row.result);
	const candidateId = hash(text(row.candidateId));
	if (text(result.id) !== candidateId || result.selected !== true)
		fail("progress", "Recorded result does not match its candidate");
	const outcome = shardOutcome(result.outcome);
	// Environmental outcomes are re-executed on the next run instead of carried.
	if (outcome === "infrastructure" || outcome === "uncompleted") {
		carried.delete(candidateId);
		return;
	}
	if (result.restored !== true) fail("progress", "Recorded result without restoration proof");
	carried.set(candidateId, { candidateId, outcome, sourceSha256: hash(text(result.sourceSha256)), document: result });
}
function progressRows(parsed: (ObjectValue | null)[], inventoryHash: string): {
	proofs: Map<string, ObjectValue>;
	recorded: ObjectValue[];
} {
	const proofs = new Map<string, ObjectValue>();
	const recorded: ObjectValue[] = [];
	// A result row is carried only when a later proof row of the same run
	// attests that the original sources and the frozen execution copy were
	// still intact after it settled. Rows after a run's last proof, and every
	// row of a run that never proved, are re-executed; a proof never vouches
	// for another run's rows, and its `results` count must equal the rows of
	// its run carried so far, so a proof vouches for exactly the rows it
	// settled. The last proof of each run is listed in the receipt (a
	// completed run's final proof also attests cleanup).
	let unproven: ObjectValue[] = [];
	const provenByRun = new Map<string, number>();
	for (const row of parsed.slice(1)) {
		if (row === null) return fail("progress", "Malformed progress row");
		if (row.inventorySha256 !== inventoryHash)
			return fail("progress", "Progress row inventory mismatch");
		if (row.type === "result") unproven.push(row);
		else if (row.type !== "proof") return fail("progress", "Unrecognized progress row");
		else if (row.originalHashesVerified === true) {
			const run = text(row.run);
			const settled = unproven.filter((result) => result.run === run);
			const proven = (provenByRun.get(run) ?? 0) + settled.length;
			if (typeof row.results !== "number") return fail("progress", `Proof of run ${run} carries no results count`);
			if (number(row.results) !== proven)
				return fail("progress", `Proof of run ${run} claims ${number(row.results)} results but ${proven} rows precede it`);
			recorded.push(...settled);
			unproven = [];
			provenByRun.set(run, proven);
			proofs.set(run, row);
		}
	}
	return { proofs, recorded };
}
function loadShardProgress(options: Options): ShardProgress {
	const shard = options.shard ?? fail("arguments", "Shard progress requires shard options");
	const run = crypto.randomUUID();
	const header = {
		type: "shard-progress",
		version: 1,
		inventorySha256: options.inventoryHash,
		shardIndex: shard.index,
		shardCount: shard.count,
	};
	const fresh = (): ShardProgress => {
		mkdirSync(dirname(shard.progress), { recursive: true });
		writeFileSync(shard.progress, progressLine(header));
		return { carried: new Map(), proofs: [], run };
	};
	if (!existsSync(shard.progress)) return fresh();
	const lines = readFileSync(shard.progress, "utf8").split("\n").filter((line) => line.length);
	const parsed = lines.map((line) => {
		try { return object(decode(line)); }
		catch { return null; }
	});
	// A run killed mid-append leaves exactly one torn trailing line. Dropping
	// it is sound: a torn row never decodes, so it carries no restoration proof.
	if (parsed.length > 1 && parsed.at(-1) === null) {
		console.error("[mutation] dropping torn trailing progress line");
		lines.pop();
		parsed.pop();
		writeFileSync(shard.progress, lines.map((line) => `${line}\n`).join(""));
	}
	const head = parsed[0] ?? fail("progress", "Malformed progress header");
	if (head.type !== header.type || head.version !== header.version)
		fail("progress", "Malformed progress header");
	// A progress artifact from another inventory is useless but harmless: its
	// rows are never read, so discard it and start fresh instead of wedging
	// the campaign until a manual fresh_progress dispatch.
	if (head.inventorySha256 !== options.inventoryHash) {
		console.error(`[mutation] progress artifact for inventory ${String(head.inventorySha256)} discarded (current ${options.inventoryHash})`);
		return fresh();
	}
	// Same inventory but another slice's artifact is an operator error; mixing
	// slices must fail closed, never silently re-key.
	for (const key of ["shardIndex", "shardCount"] as const)
		if (head[key] !== header[key])
			fail("progress", `Progress artifact does not match this shard (${key}: ${JSON.stringify(head[key])} != ${JSON.stringify(header[key])})`);
	const { proofs, recorded } = progressRows(parsed, options.inventoryHash);
	const carried = new Map<string, CarriedResult>();
	// Each proven row also carries its own restoration proof (`restored`) and
	// source digest; `carriedResult` re-checks both before the row is kept.
	for (const row of recorded) carriedResult(row, carried);
	return { carried, proofs: [...proofs.values()], run };
}
function verifyCarried(progress: ShardProgress, slice: Candidate[]): void {
	const byId = new Map(slice.map((candidate) => [candidate.id, candidate]));
	for (const row of progress.carried.values()) {
		const candidate = byId.get(row.candidateId) ?? fail("progress", "Recorded result outside this shard slice");
		if (candidate.sourceSha256 !== row.sourceSha256) fail("progress", "Recorded result source drift");
	}
}
// A run-level proof attests that the original sources and the frozen
// execution copy still match their pinned digests after the results settled
// so far; `progressRows` carries a result row only when such a proof of the
// same run follows it. The end-of-run proof written by `emitShardReceipt`
// additionally attests cleanup.
function proofCheckpoint(context: ExecutionContext, progress: ShardProgress, results: number): void {
	const { options, inventory, temporary, executionTreeSha256 } = context;
	const shard = options.shard ?? fail("arguments", "Shard proof requires shard options");
	// Same attestation as the receipt's proof minus canonical verification,
	// which spawns the inventory tool and stays an end-of-run cost.
	verifySources(options.root, inventory);
	if (executionTreeHash(join(temporary, "frozen")) !== executionTreeSha256)
		fail("tamper", "Frozen execution copy changed");
	pinned(options.contract, options.contractHash);
	pinned(options.inventory, options.inventoryHash);
	pinned(options.decision, options.decisionHash);
	appendFileSync(shard.progress, progressLine({
		type: "proof",
		run: progress.run,
		inventorySha256: options.inventoryHash,
		executionTreeSha256,
		originalHashesVerified: true,
		results,
	}));
}
function deferCandidate(
	context: ExecutionContext,
	candidate: Candidate,
	reached: string[],
	shard: NonNullable<Options["shard"]>,
	alreadyDeferred: boolean,
): boolean {
	if (budgetAllows(context, candidate, reached)) return false;
	const reserve = candidateReserve(context, candidate, reached);
	if (!alreadyDeferred)
		console.error(`[mutation] shard ${shard.index}/${shard.count} deferring ${candidate.path}:${candidate.startOffset} ${candidate.operator}: reserve ${reserve} ms does not fit the remaining budget after ${Date.now() - context.started} ms of ${context.options.budget} ms${reserve > context.options.budget ? " (the reserve alone exceeds the whole budget)" : ""}`);
	return true;
}
async function executeShardSelection(
	context: ExecutionContext,
	pending: Candidate[],
	progress: ShardProgress,
): Promise<{ executed: Result[]; budgetExhausted: boolean }> {
	const { options, compilerWorker, contract, temporary, enumerated, tests, errors, reachMap } = context;
	const shard = options.shard ?? fail("arguments", "Shard execution requires shard options");
	const pendingIds = new Set(pending.map((candidate) => candidate.id));
	const executed: Result[] = [];
	let budgetExhausted = false;
	let deferred = 0;
	let checked = new Map<string, CompilerCheck>();
	for (const [index, candidate] of enumerated.candidates.entries()) {
		if (errors.length) break;
		if (!pendingIds.has(candidate.id)) continue;
		const reached = reachMap.get(candidate.id)?.tests ?? tests;
		// Keep scanning after a deferral: a cheaper candidate may still fit.
		if (deferCandidate(context, candidate, reached, shard, budgetExhausted)) {
			budgetExhausted = true;
			deferred++;
			continue;
		}
		console.error(`[mutation] shard ${shard.index}/${shard.count} mutant ${executed.length + 1}/${pending.length} start ${candidate.path}:${candidate.startOffset} ${candidate.operator}`);
		if (compilerWorker && !candidate.operator.startsWith("py-") && reachMap.get(candidate.id)?.reached && !checked.has(candidate.id))
			checked = await compilerBatch(enumerated.candidates, index, pendingIds, reachMap, compilerWorker, temporary);
		const result = await runCandidate(candidate, compilerWorker, checked.get(candidate.id), options, contract, temporary, reached, reachMap);
		checked.delete(candidate.id);
		appendFileSync(shard.progress, progressLine({ type: "result", run: progress.run, inventorySha256: options.inventoryHash, candidateId: candidate.id, result }));
		executed.push(result);
		console.error(`[mutation] shard ${shard.index}/${shard.count} mutant ${executed.length}/${pending.length} ${result.outcome}: ${result.reason}`);
		if (executed.length % options.checkpointResults === 0) proofCheckpoint(context, progress, executed.length);
	}
	if (!errors.length && executed.length % options.checkpointResults !== 0) proofCheckpoint(context, progress, executed.length);
	if (budgetExhausted) console.error(`[mutation] shard ${shard.index}/${shard.count} deferred ${deferred} of ${pending.length} pending candidates to the next run`);
	return { executed, budgetExhausted };
}
function shardRows(slice: Candidate[], executed: Result[], carried: Map<string, CarriedResult>) {
	const byId = new Map(executed.map((result) => [result.id, result]));
	const rows: Json[] = [];
	const counts = { killed: 0, survived: 0, noCoverage: 0, invalid: 0, infrastructure: 0, uncompleted: 0 };
	let restored = true;
	for (const candidate of slice) {
		const ran = byId.get(candidate.id);
		const kept = carried.get(candidate.id);
		if (ran) {
			rows.push(decode(JSON.stringify(ran, diagnosticField)));
			counts[ran.outcome]++;
			restored = restored && ran.restored;
		} else if (kept) {
			rows.push(kept.document);
			counts[kept.outcome]++;
		}
	}
	return { rows, counts, restored };
}

function shardPlan(candidates: Candidate[], shard: Options["shard"], progress: ShardProgress | null) {
	const slice = shard
		? candidates.filter((_, index) => index % shard.count === shard.index)
		: candidates;
	if (progress) verifyCarried(progress, slice);
	const pending = progress ? slice.filter((candidate) => !progress.carried.has(candidate.id)) : [];
	if (shard)
		console.error(`[mutation] shard ${shard.index}/${shard.count}: slice ${slice.length}, carried ${progress?.carried.size ?? 0}, pending ${pending.length}`);
	return { slice, pending, executionRequired: !progress || pending.length > 0 };
}
function campaignTests(options: Options, inventory: Inventory): string[] {
	const tests = options.tests.length
		? options.tests
		: inventory.files
			.filter(
				(file) =>
					file.category === "test" &&
					["typescript", "javascript"].includes(file.language) &&
					/\.(test|spec)\.[cm]?[jt]sx?$/.test(file.path),
			)
			.map((file) => file.path);
	for (const test of tests)
		if (!inventory.files.some((file) => file.path === test))
			return fail("incompleteInventory", `Test absent from inventory: ${test}`);
	return tests;
}
function campaignErrors(
	enumerated: ReturnType<typeof enumerate>,
	tests: string[],
	sourceDiagnostics: string[],
): string[] {
	const errors = [...enumerated.errors];
	if (!tests.length) errors.push("zero test selection");
	if (sourceDiagnostics.length)
		errors.push(`baseline compiler rejected ${sourceDiagnostics.length} diagnostics`);
	if (!enumerated.candidates.length) errors.push("zero eligible mutation candidates");
	return errors;
}
async function campaignBaseline(input: {
	frozen: string;
	base: string;
	tests: string[];
	options: Options;
	temporary: string;
	errors: string[];
	executionRequired: boolean;
}): Promise<TestSelectionReceipt | null> {
	const { frozen, base, tests, options, temporary, errors, executionRequired } = input;
	console.error(`[mutation] baseline execution copy (${tests.length} test files, ${errors.length} errors)`);
	if (!errors.length && executionRequired) {
		const { platform, hasPrlimit, execute: run } = options.testRuntime;
		await verifyMutantMemoryCap(options.mutantMemoryBytes, platform, hasPrlimit, run);
		copyExecution(frozen, base);
	}
	console.error("[mutation] baseline tests starting");
	const baseline = errors.length || !executionRequired
		? null
		: await runTests(base, tests, options.timeout, temporary, options.python, SELECTION_SUITE_TIMEOUT_MS, {}, 0, options.testRuntime);
	if (baseline && !green(baseline)) {
		const red = describeRedBaseline(baseline.batches);
		process.stderr.write(red.lines.map((line) => `[mutation] baseline red: ${line}\n`).join(""));
		errors.push(red.summary);
	}
	return baseline;
}
function campaignDocumentBase(context: {
	options: Options;
	executionTreeSha256: string;
	pythonCapability: Awaited<ReturnType<typeof enumeratePython>>;
	tests: string[];
	reachMap: ReachMap | null;
	sourceDiagnostics: string[];
}) {
	const { options, executionTreeSha256, pythonCapability, tests, reachMap, sourceDiagnostics } = context;
	return {
		executionTreeSha256,
		pythonCapability,
		testSelections: [{ id: sha256(JSON.stringify(tests)), paths: tests }],
		reachMap,
		sourceDiagnostics,
		sourceDiagnosticsSha256: sha256(JSON.stringify(sourceDiagnostics)),
		inventorySha256: options.inventoryHash,
		contractSha256: options.contractHash,
		decisionSha256: options.decisionHash,
		inventoryToolSha256: options.inventoryToolHash,
		runnerSha256: sha256(readFileSync(import.meta.path)),
		runtime: {
			version: Bun.version,
			path: process.execPath,
			sha256: sha256(readFileSync(process.execPath)),
			typescript: ts.version,
			compilerSha256: sha256(readFileSync(require.resolve("typescript"))),
		},
	};
}
function emitShardReceipt(context: {
	options: Options;
	shardOptions: NonNullable<Options["shard"]>;
	shardProgress: ShardProgress;
	shardExecution: { executed: Result[]; budgetExhausted: boolean };
	slice: Candidate[];
	errors: string[];
	cleanupVerified: boolean;
	executionTreeSha256: string;
	pythonCapability: Awaited<ReturnType<typeof enumeratePython>>;
	tests: string[];
	reachReceipt: ReachMap | null;
	sourceDiagnostics: string[];
	canonical: ProcessReceipt;
	baseline: TestSelectionReceipt | null;
	census: ReturnType<typeof enumerate>["census"];
}): number {
	const { options, shardOptions, shardProgress, shardExecution, slice, errors, cleanupVerified, executionTreeSha256, pythonCapability, tests, reachReceipt, sourceDiagnostics, canonical, baseline, census } = context;
	if (!errors.length)
		appendFileSync(shardOptions.progress, progressLine({
			type: "proof",
			run: shardProgress.run,
			inventorySha256: options.inventoryHash,
			executionTreeSha256,
			originalHashesVerified: true,
			cleanupVerified,
			results: shardExecution.executed.length,
		}));
	const { rows, counts, restored } = shardRows(slice, shardExecution.executed, shardProgress.carried);
	const sliceComplete = rows.length === slice.length;
	// A slice may legitimately be entirely compiler-invalid; the
	// valid-outcome sanity floor is enforced campaign-wide at join.
	const complete =
		sliceComplete &&
		errors.length === 0 &&
		counts.infrastructure === 0 &&
		counts.uncompleted === 0 &&
		restored &&
		cleanupVerified;
	// Errors win over incompleteness; an incomplete shard with no errors is
	// still a failed shard, never a green one.
	const exitCode = errors.length ? 2 : complete ? 0 : 1;
	console.error(`[mutation] shard ${shardOptions.index}/${shardOptions.count} finished: ${JSON.stringify({ recorded: rows.length, sliceSize: slice.length, executed: shardExecution.executed.length, budgetExhausted: shardExecution.budgetExhausted, complete, errors })}`);
	console.log(
		JSON.stringify({
			version: 1,
			algorithm: "d945-mutation@1",
			exitCode,
			full: false,
			complete,
			globalZero: false,
			mutationZero: false,
			counts,
			selectedCounts: counts,
			errors,
			shard: {
				index: shardOptions.index,
				count: shardOptions.count,
				sliceSize: slice.length,
				recorded: rows.length,
				executed: shardExecution.executed.length,
				budgetExhausted: shardExecution.budgetExhausted,
				sliceComplete,
				run: shardProgress.run,
				carriedProofs: shardProgress.proofs,
			},
			...campaignDocumentBase({ options, executionTreeSha256, pythonCapability, tests, reachMap: reachReceipt, sourceDiagnostics }),
			canonical,
			baseline,
			census,
			results: rows,
			originalHashesVerified: true,
			cleanupVerified,
		}, diagnosticField),
	);
	return exitCode;
}

function campaignOutcome(
	options: Options,
	enumerated: ReturnType<typeof enumerate>,
	results: Result[],
	errors: string[],
	cleanupVerified: boolean,
) {
	const counts = {
		killed: 0,
		survived: 0,
		noCoverage: 0,
		invalid: 0,
		infrastructure: 0,
		uncompleted: 0,
	};
	for (const result of results) counts[result.outcome]++;
	const selectedCounts = {
		killed: 0,
		survived: 0,
		noCoverage: 0,
		invalid: 0,
		infrastructure: 0,
		uncompleted: 0,
	};
	for (const result of results.filter((result) => result.selected))
		selectedCounts[result.outcome]++;
	const valid = counts.killed + counts.survived + counts.noCoverage;
	const complete =
		errors.length === 0 &&
		counts.infrastructure === 0 &&
		selectedCounts.uncompleted === 0 &&
		valid > 0 &&
		results.every((result) => result.restored) &&
		cleanupVerified;
	const exitCode = !complete ? 2 : counts.survived > 0 || counts.noCoverage > 0 ? 1 : 0;
	const full = !options.pilot && counts.uncompleted === 0 && enumerated.errors.length === 0;
	return { counts, selectedCounts, complete, exitCode, full };
}

function frozenCompilerInputs(options: Options) {
	pinned(options.contract, options.contractHash);
	pinned(options.inventory, options.inventoryHash);
	pinned(options.decision, options.decisionHash);
	const contract = contractAt(options.contract);
	const inventory = inventoryAt(options.inventory);
	for (const project of contract.projects)
		if (!inventory.configurations.some((file) => file.path === project))
			return fail(
				"incompleteInventory",
				`Compiler project is not hash-pinned in inventory: ${project}`,
			);
	const operators = operatorsAt(options.decision);
	return { contract, inventory, operators };
}

async function campaign(options: Options): Promise<number> {
	// The budget clock starts before any work so that input pinning, canonical
	// verification, snapshotting, analysis, baseline and reach all count.
	const started = Date.now();
	const { contract, inventory, operators } = frozenCompilerInputs(options);
	const shardProgress = options.shard ? loadShardProgress(options) : null;
	console.error("[mutation] verifying canonical inventory");
	const canonical = await canonicalVerification(options);
	verifySources(options.root, inventory);
	const temporary = mkdtempSync(join(tmpdir(), "omo-quality-mutation-"));
	let cleanupVerified = false;
	let compilerWorker: MutationCompilerWorker | null = null;
	try {
		const frozen = join(temporary, "frozen");
		console.error(`[mutation] creating frozen execution copy at ${frozen}`);
		snapshot(options, frozen);
		console.error("[mutation] hashing frozen execution copy");
		const executionTreeSha256 = executionTreeHash(frozen);
		const base = join(temporary, "baseline");
		console.error(`[mutation] enumerating and checking ${contract.projects.length} compiler projects sequentially`);
		const { enumerated, sourceDiagnostics } = analyze(frozen, contract, inventory, operators);
		Bun.gc(true); // Release compiler AST/checkers before test children run.
		console.error(`[mutation] enumerating Python candidates (${enumerated.candidates.length} TS/JS candidates)`);
		const pythonCapability = await enumeratePython(options, temporary, frozen, enumerated);
		enumerated.candidates.sort(compareCandidates);
		const shardOptions = options.shard;
		const { slice, pending, executionRequired } = shardPlan(enumerated.candidates, shardOptions, shardProgress);
		console.error(`[mutation] compiler analysis finished (${enumerated.candidates.length} candidates, ${sourceDiagnostics.length} diagnostics)`);
		const tests = campaignTests(options, inventory);
		const errors = campaignErrors(enumerated, tests, sourceDiagnostics);
		const baseline = await campaignBaseline({ frozen, base, tests, options, temporary, errors, executionRequired });
		console.error(`[mutation] baseline tests finished: ${JSON.stringify(baseline ? { tests: baseline.tests, failures: baseline.failures, exitCode: baseline.exitCode, processes: baseline.batches.map((batch) => ({ exitCode: batch.process.exitCode, signal: batch.process.signal, timedOut: batch.process.timedOut })) } : { errors })}`);
		const selected = selectedCandidates(options, enumerated.candidates);
		const reachPool = shardProgress ? pending : selected;
		const reachCandidates = reachPool.filter((candidate) => !candidate.operator.startsWith("py-"));
		const reach = errors.length || !baseline ? { map: new Map<string, ProbeEvidence>(), receipt: null } : await buildReachMap(options, frozen, temporary, reachCandidates, baseline.files, executionTreeSha256);
		removeExecution(join(temporary, "reach"));
		compilerWorker = errors.length || !executionRequired ? null : new MutationCompilerWorker(frozen, contract, inventory, executionTreeSha256, options.timeout * Math.max(1, contract.projects.length));
		const executionContext: ExecutionContext = {
			options, compilerWorker, contract, inventory, temporary, executionTreeSha256, started, enumerated, tests, errors, reachMap: reach.map,
		};
		const shardExecution = shardProgress
			? await executeShardSelection(executionContext, pending, shardProgress)
			: null;
		const results = shardExecution ? [] : await executeSelection(executionContext);
		if (compilerWorker) await compilerWorker.close();
		console.error("[mutation] verifying restoration and cleaning execution copies");
		verifySources(options.root, inventory);
		if (executionTreeHash(frozen) !== executionTreeSha256)
			return fail("tamper", "Frozen execution copy changed");
		await canonicalVerification(options);
		pinned(options.contract, options.contractHash);
		pinned(options.inventory, options.inventoryHash);
		pinned(options.decision, options.decisionHash);
		removeExecution(base);
		removeExecution(frozen);
		rmSync(temporary, { recursive: true, force: true });
		cleanupVerified = !existsSync(temporary);
		if (shardOptions && shardProgress && shardExecution)
			return emitShardReceipt({
				options, shardOptions, shardProgress, shardExecution, slice, errors, cleanupVerified,
				executionTreeSha256, pythonCapability, tests, reachReceipt: reach.receipt,
				sourceDiagnostics, canonical, baseline, census: enumerated.census,
			});
		const { counts, selectedCounts, complete, exitCode, full } = campaignOutcome(
			options, enumerated, results, errors, cleanupVerified,
		);
		console.error(`[mutation] campaign finished: ${JSON.stringify({ counts, selectedCounts, complete, errors })}`);
		console.log(
			JSON.stringify({
				version: 1,
				algorithm: "d945-mutation@1",
				exitCode,
				full,
				complete,
				globalZero: false,
				mutationZero: full && exitCode === 0,
				counts,
				selectedCounts,
				errors,
				...campaignDocumentBase({ options, executionTreeSha256, pythonCapability, tests, reachMap: reach.receipt, sourceDiagnostics }),
				canonical,
				baseline,
				census: enumerated.census,
				results,
				originalHashesVerified: true,
				cleanupVerified,
			}, diagnosticField),
		);
		return exitCode;
	} finally {
		if (compilerWorker) await compilerWorker.close();
		if (!cleanupVerified) {
			removeExecution(join(temporary, "candidate/source"));
			removeExecution(join(temporary, "reach"));
			removeExecution(join(temporary, "baseline"));
			removeExecution(join(temporary, "frozen"));
			rmSync(temporary, { recursive: true, force: true });
		}
	}
}
async function typecheckRoot(values: Map<string, string[]>): Promise<number> {
	const root = values.get("--typecheck-root")?.[0] ?? fail("arguments", "Missing typecheck root");
	const contract = values.get("--contract")?.[0] ?? fail("arguments", "Missing typecheck contract");
	const inventory = values.get("--inventory")?.[0] ?? fail("arguments", "Missing typecheck inventory");
	const errors = diagnostics(programs(root, contractAt(contract), inventoryAt(inventory)));
	console.log(JSON.stringify({
		kind: "typecheck",
		valid: errors.length === 0,
		diagnostics: errors,
		diagnosticsSha256: sha256(JSON.stringify(errors)),
	}));
	return errors.length ? 1 : 0;
}

export async function main(argv: string[] = Bun.argv.slice(2), testRuntime: TestRuntime = nativeTestRuntime()): Promise<number> {
	mutationFailure.current = null;
	setupProcessFailure = null;
	return dispatch(argv, testRuntime).catch(reportFailure);
}
async function dispatch(argv: string[], testRuntime: TestRuntime): Promise<number> {
	if (!["1.3.6", "1.4.1"].includes(Bun.version) || ts.version !== "5.9.2")
		return fail(
			"toolVersion",
			"Requires Bun 1.3.6 (or explicit current compatibility 1.4.1) and TypeScript 5.9.2",
	);
	const values = argumentsMap(argv);
	if (values.has("--typecheck-root")) return typecheckRoot(values);
	return await campaign(optionsFrom(values, testRuntime));
}
function reportFailure(error: Error | MutationError | string): number {
	const caught = error instanceof Error || error instanceof MutationError ? error.message : String(error);
	const prior = mutationFailure.current;
	mutationFailure.current = { code: prior?.code ?? (error instanceof MutationError ? error.code : "infrastructure"), message: `${prior?.message ?? ""}${prior?.message ? "; " : ""}${caught}` };
	console.log(
		JSON.stringify({
			version: 1,
			exitCode: 2,
			full: false,
			complete: false,
			globalZero: false,
			error: {
				...(mutationFailure.current ?? {
					code: "infrastructure",
					message: "Unhandled filesystem, compiler or process failure",
				}),
				...(setupProcessFailure ? { process: setupProcessFailure } : {}),
				...(error instanceof MutationError && error.reach ? { reach: error.reach } : {}),
			},
		}, diagnosticField),
	);
	return 2;
}
if (import.meta.main) process.exitCode = await main();
