import {
	InventoryError, jsonArray, jsonBoolean, jsonChoice, jsonLiteral, jsonNumber,
	jsonObject, jsonString, type Json,
} from "./quality-inventory";
import { origins, type Origin } from "./check-types-census";
export const gates = ["type", "publisher", "export", "store", "cyclomatic", "cognitive", "halstead", "crap", "productionClones", "testClones", "coverage", "mutation"] as const;
export type Gate = typeof gates[number];
export type Finding = {
	gate: Gate;
	path: string;
	line: number;
	symbol: string;
	value: number;
	endLine?: number;
	/** Type census only: whether the top type is attributable to owned source. */
	origin?: Origin;
};
export type Receipt = {
	version: 1;
	complete: true;
	analyzed: Gate[];
	inventory: string[];
	findings: Finding[];
	/** Source-map executable lines used to detect absent native LCOV proof. */
	executableLines?: { path: string; lines: number[] }[];
};
export type Identity = {
	inventoryHash: string;
	contractHash: string;
	paths: string[];
	typescript: string[];
};
export type Measurement = { analyzed: Gate[]; findings: Finding[] };

export function requireMeasurement(condition: boolean, message: string): void {
	if (!condition) throw new InventoryError("measurement", "", message);
}
export function sameMembers(actual: string[], expected: string[]): void {
	requireMeasurement(new Set(actual).size === actual.length, "duplicate source identity");
	requireMeasurement(
		JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort()),
		"incomplete source or gate membership",
	);
}
export function completeDocument(value: Json) {
	const row = jsonObject(value);
	requireMeasurement(jsonBoolean(row.complete), "incomplete native receipt");
	return row;
}
function nativeIdentity(value: Json, identity: Identity) {
	const row = completeDocument(value);
	jsonLiteral(row.version, 1);
	requireMeasurement(row.inventoryHash === identity.inventoryHash, "stale inventory hash");
	requireMeasurement(jsonArray(row.errors, jsonObject).length === 0, "native analyzer errors");
	return row;
}
export function location(value: Json) {
	const row = jsonObject(value);
	const path = jsonString(row.path), line = jsonNumber(row.line);
	const symbol = jsonString(row.symbol);
	requireMeasurement(Boolean(path && symbol), "missing finding identity");
	requireMeasurement(Number.isSafeInteger(line) && line > 0, "invalid finding line");
	return { path, line, symbol };
}
export function normalizeTypes(value: Json, identity: Identity): Measurement {
	const row = nativeIdentity(value, identity);
	jsonLiteral(row.tool, "typescript@5.9.2");
	sameMembers(jsonArray(row.measured, jsonString), identity.typescript);
	sameMembers(jsonArray(row.semanticMeasured, jsonString), identity.typescript);
	return {
		analyzed: ["type"],
		findings: jsonArray(row.violations, (entry) => {
			const violation = jsonObject(entry);
			const site = location(entry);
			return {
				...site, gate: "type", symbol: `${jsonString(violation.kind)}:${site.symbol}`, value: 1,
				origin: jsonChoice(violation.origin, origins),
			};
		}),
	};
}
export function normalizeCensus(
	value: Json, identity: Identity, gate: "publisher" | "export" | "store",
): Measurement {
	const row = nativeIdentity(value, identity);
	jsonLiteral(row.class, gate);
	requireMeasurement(row.contractHash === identity.contractHash, "stale contract hash");
	sameMembers(jsonArray(row.analyzedClasses, jsonString), [gate]);
	const findings = jsonArray(row.findings, (entry): Finding => {
		jsonLiteral(jsonObject(entry).class, gate);
		return { ...location(entry), gate, value: 1 };
	});
	requireMeasurement(jsonNumber(jsonObject(row.counts)[gate]) === findings.length, "census count mismatch");
	return { analyzed: [gate], findings };
}
export function mergeMeasurements(
	inventory: string[],
	measurements: Measurement[],
	executableLines?: { path: string; lines: number[] }[],
): Receipt {
	const analyzed = measurements.flatMap((row) => row.analyzed);
	const findings = measurements.flatMap((row) => row.findings);
	requireMeasurement(inventory.length > 0 && analyzed.length > 0, "empty measurement");
	sameMembers(analyzed, [...new Set(analyzed)]);
	sameMembers(inventory, [...new Set(inventory)]);
	for (const row of findings) {
		requireMeasurement(inventory.includes(row.path), `finding outside inventory: ${row.path}`);
		requireMeasurement(analyzed.includes(row.gate), "finding outside measured gates");
	}
	return {
		version: 1, complete: true, analyzed, inventory, findings,
		...(executableLines === undefined ? {} : { executableLines }),
	};
}
