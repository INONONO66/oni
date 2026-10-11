import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  digest,
  jsonArray,
  jsonChoice,
  jsonNumber,
  jsonObject,
  jsonString,
  type Json,
} from "./quality-inventory";
import { fingerprint } from "./quality-ci-input";
import { qualitySource } from "./quality-source";
import {
  completeDocument,
  mergeMeasurements,
  requireMeasurement,
  sameMembers,
  type Identity,
  type Measurement,
} from "./quality-ci-receipt";
import { nativeJson } from "./quality-native-process";

/** One test selection under one mutant may run this long before the runner
 * kills it and records the mutant as killed by non-termination. */
const SUITE_TIMEOUT_MS = 300_000;
/** The runner child is killed at this deadline whatever its budget says. */
const RUNNER_TIMEOUT_MS = 21_000_000;
/** Wall-clock the runner needs after its budget stops dispatching mutants:
 * compiler-worker disposal, original-tree restoration, cleanup and receipts.
 * A budget is accepted only when budget + settle fits the runner deadline, so
 * the deadline never kills a run that honored its budget. The runner's budget
 * clock starts before setup, baseline and reach selection, which therefore
 * count against the budget. */
const RUNNER_SETTLE_MS = 600_000;
const MAX_BUDGET_MS = RUNNER_TIMEOUT_MS - RUNNER_SETTLE_MS;

export function normalizeMutation(value: Json, identity: Identity, root: string): Measurement {
  const row = completeDocument(value);
  requireMeasurement(
    row.version === 1 && row.full === true,
    "full mutation receipt required; pilot is not convergence",
  );
  requireMeasurement(row.inventorySha256 === identity.inventoryHash, "stale mutation inventory");
  requireMeasurement(
    row.originalHashesVerified === true && row.cleanupVerified === true,
    "unverified mutation restoration",
  );
  requireMeasurement(
    jsonArray(row.errors, jsonObject).length === 0,
    "mutation infrastructure errors",
  );
  const results = jsonArray(row.results, jsonObject);
  requireMeasurement(results.length > 0, "empty mutation campaign");
  const census = jsonArray(row.census, jsonObject);
  const owned = [...identity.paths, ...(identity.embedded ?? []).map((source) => source.path)];
  sameMembers(
    census.map((source) => jsonString(source.path)).filter((path) => owned.includes(path)),
    owned,
  );
  const candidates = census
    .flatMap((source) => jsonArray(source.operators, jsonObject))
    .reduce((total, operator) => total + jsonNumber(operator.candidates), 0);
  requireMeasurement(candidates === results.length, "missing enumerated mutation candidates");
  const counts = jsonObject(row.counts);
  for (const outcome of [
    "killed",
    "survived",
    "noCoverage",
    "invalid",
    "infrastructure",
    "uncompleted",
  ])
    requireMeasurement(
      counts[outcome] === results.filter((result) => result.outcome === outcome).length,
      "mutation count mismatch",
    );
  const findings = results.flatMap((result) => {
    requireMeasurement(
      result.selected === true && result.restored === true,
      "incomplete mutation candidate",
    );
    const outcome = jsonChoice(result.outcome, ["killed", "survived", "noCoverage", "invalid"]);
    const sourcePath = jsonString(result.path);
    const virtual = identity.embedded?.find((entry) => entry.path === sourcePath);
    const path = virtual?.hostPath ?? sourcePath;
    if (!qualitySource(path)) return [];
    requireMeasurement(identity.paths.includes(path), "mutant outside source inventory");
    const source = virtual?.text ?? readFileSync(resolve(root, path), "utf8");
    requireMeasurement(result.sourceSha256 === digest(source), "stale mutant source");
    if (["killed", "invalid"].includes(outcome)) return [];
    const offset = jsonNumber(result.startOffset);
    requireMeasurement(
      Number.isSafeInteger(offset) && offset >= 0 && offset < source.length,
      "invalid mutation offset",
    );
    return [
      {
        gate: "mutation" as const,
        path,
        line: (virtual?.lineOffset ?? 0) + source.slice(0, offset).split("\n").length,
        symbol: `${virtual ? "PYTHON_DRIVER:" : ""}${jsonString(result.operator)}:${jsonString(result.replacementSha256)}:${source.slice(offset, jsonNumber(result.endOffset))}`,
        value: 1,
      },
    ];
  });
  return { analyzed: ["mutation"], findings };
}
/** Records the complete campaign as one measurement receipt (`current.json`)
 * beside the native document. Survivors are findings in that receipt and drive
 * the exit code; there is no baseline to ratchet against (#945 measures the
 * literal-zero DoD from the receipt). */
export function recordMutationMeasurement(context: {
  document: Json;
  identity: Identity;
  root: string;
  contract: string;
  directory: string;
  driftMessage: string;
}): number {
  const { document, identity, root, contract, directory, driftMessage } = context;
  const measurement = normalizeMutation(document, identity, root);
  requireMeasurement(fingerprint(root, contract).inventoryHash === identity.inventoryHash, driftMessage);
  const merged = mergeMeasurements(identity.paths, [measurement]);
  writeFileSync(resolve(directory, "current.json"), JSON.stringify(merged), { flag: "wx" });
  console.error(`[mutation] campaign complete: ${merged.findings.length} surviving mutants recorded`);
  return merged.findings.length > 0 ? 1 : 0;
}
function mutationArguments(values: {
  limit?: string;
  target?: string;
  pilot: boolean;
  shard?: string;
  "shard-count"?: string;
  progress?: string;
  "budget-minutes"?: string;
}): { shardMode: boolean; budgetMs: number } {
  requireMeasurement(!(values.limit || values.target) || values.pilot, "--limit/--target require --pilot");
  const shardValues = [values.shard, values["shard-count"], values.progress];
  const shardMode = shardValues.some((value) => value !== undefined);
  requireMeasurement(
    !shardMode || shardValues.every((value) => value !== undefined),
    "sharded execution requires --shard, --shard-count and --progress",
  );
  requireMeasurement(!(shardMode && values.pilot), "--shard is incompatible with --pilot");
  const budgetMinutes = values["budget-minutes"] === undefined ? null : Number(values["budget-minutes"]);
  requireMeasurement(
    budgetMinutes === null || (Number.isSafeInteger(budgetMinutes) && budgetMinutes >= 1),
    "invalid --budget-minutes",
  );
  const budgetMs = budgetMinutes === null ? MAX_BUDGET_MS : budgetMinutes * 60_000;
  requireMeasurement(
    budgetMs <= MAX_BUDGET_MS,
    `--budget-minutes exceeds the runner deadline (maximum ${MAX_BUDGET_MS / 60_000})`,
  );
  return { shardMode, budgetMs };
}
export async function mutationMain(argv = Bun.argv.slice(2)): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      root: { type: "string", default: process.cwd() },
      contract: { type: "string", default: "script/conformance/quality-contract.json" },
      decision: { type: "string", default: "script/conformance/quality-mutation-contract.json" },
      output: { type: "string", default: "quality-mutation-results" },
      pilot: { type: "boolean", default: false },
      limit: { type: "string" },
      target: { type: "string" },
      shard: { type: "string" },
      "shard-count": { type: "string" },
      progress: { type: "string" },
      "budget-minutes": { type: "string" },
      "mutant-memory-mb": { type: "string", default: "6144" },
    },
  });
  const { shardMode, budgetMs } = mutationArguments(values);
  console.error(`[mutation] fingerprinting source inventory (pilot=${values.pilot})`);
  const root = resolve(values.root),
    directory = resolve(root, values.output);
  const identity = fingerprint(root, values.contract);
  mkdirSync(directory);
  const inventory = resolve(directory, "inventory.json");
  writeFileSync(inventory, JSON.stringify(identity.inventory), { flag: "wx" });
  const contract = resolve(root, values.contract),
    decision = resolve(root, values.decision);
  const inventoryTool = resolve(root, "script/quality-inventory.ts");
  const result = await nativeJson({
    cwd: root,
    receipt: resolve(directory, "process.json"),
    timeout: RUNNER_TIMEOUT_MS,
    onStderr: (chunk) => { process.stderr.write(chunk); },
    command: [
      process.execPath,
      "--smol",
      resolve(root, "script/run-quality-mutations.ts"),
      "--root",
      root,
      "--contract",
      contract,
      "--contract-sha256",
      digest(readFileSync(contract)),
      "--inventory",
      inventory,
      "--inventory-sha256",
      identity.inventoryHash,
      "--decision",
      decision,
      "--decision-sha256",
      digest(readFileSync(decision)),
      "--inventory-tool",
      inventoryTool,
      "--inventory-tool-sha256",
      digest(readFileSync(inventoryTool)),
      "--dependencies",
      resolve(root, "node_modules"),
      "--python",
      process.env.D945_PYTHON ?? "python3",
      "--max-candidates",
      "1000000",
      "--budget",
      String(budgetMs),
      "--suite-timeout",
      String(SUITE_TIMEOUT_MS),
      "--mutant-memory-mb",
      values["mutant-memory-mb"],
      ...(values.pilot ? ["--pilot", "--limit", values.limit ?? "5"] : []),
      ...(values.target ? ["--target", values.target] : []),
      ...(shardMode
        ? ["--shard", values.shard ?? "", "--shard-count", values["shard-count"] ?? "", "--progress", resolve(values.progress ?? "")]
        : []),
      "--failure-output",
      resolve(directory, "reach-failure.json"),
    ],
  });
  writeFileSync(resolve(directory, "native.json"), JSON.stringify(result), { flag: "wx" });
  if (shardMode) {
    const document = jsonObject(result.document);
    requireMeasurement(document.full === false, "shard run must not claim full convergence");
    const shard = jsonObject(document.shard);
    console.error(
      `[mutation] shard ${jsonNumber(shard.index)}/${jsonNumber(shard.count)} recorded ${jsonNumber(shard.recorded)}/${jsonNumber(shard.sliceSize)} complete=${document.complete === true}`,
    );
    return result.exitCode;
  }
  if (values.pilot) {
    const pilot = completeDocument(result.document);
    requireMeasurement(pilot.full === false, "pilot must not claim full convergence");
    console.error(`[mutation] pilot complete: ${JSON.stringify(pilot.selectedCounts)}`);
    return result.exitCode;
  }
  return recordMutationMeasurement({
    document: result.document,
    identity,
    root,
    contract: values.contract,
    directory,
    driftMessage: "sources changed during mutation",
  });
}
if (import.meta.main) process.exitCode = await mutationMain();
