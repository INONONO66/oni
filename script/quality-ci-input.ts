import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	buildInventory, readContract, digest, decodeJson, jsonObject, type Json,
} from "./quality-inventory";
import { qualitySource } from "./quality-source";

export function readDocument(path: string): Json {
	return decodeJson(readFileSync(path, "utf8"));
}
export function fingerprint(root: string, contract: string) {
	const inventory = buildInventory(root, readContract(resolve(root, contract)));
	const paths = inventory.files.map((row) => row.path).filter(qualitySource);
	return {
		inventory,
		inventoryHash: digest(JSON.stringify(inventory)),
		contractHash: inventory.contractHash,
		paths,
		schemaPaths: [...inventory.files.filter((row) => row.language === "sql" && row.category === "migration").map((row) => row.path), "sqlite_schema"],
		typescript: inventory.files.filter((row) =>
			qualitySource(row.path) && row.language === "typescript").map((row) => row.path),
	};
}
export function recordObject(path: string) {
	return jsonObject(readDocument(path));
}
