import { expect, test } from "bun:test";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodeJson, jsonArray, jsonNumber, jsonObject } from "./quality-inventory";
import { joinMain, joinShardDocuments } from "./quality-mutation-join";
import { mutationFixture, record } from "./quality-mutation-fixture";
import { mutationMain } from "./quality-native-mutation";
import { fingerprint } from "./quality-ci-input";
import { decode, execute, main, sha256 } from "./run-quality-mutations";

const { fixture, tool, decision, dependencies, runner } = mutationFixture("shard");

type Fixture = { root: string; inventory: string };
/** The wrapper hashes JSON.stringify(inventory) without the CLI's trailing
 * newline; align the fixture file so raw-runner and wrapper runs share one
 * inventory hash and therefore one progress stream. */
function canonicalizeInventory(input: Fixture): void {
  writeFileSync(input.inventory, JSON.stringify(decodeJson(readFileSync(input.inventory, "utf8"))));
}
function runnerArgv(input: Fixture): string[] {
  const paths = { contract: join(input.root, "contract.json"), inventory: input.inventory, decision, "inventory-tool": tool };
  const base = ["--root", input.root, "--dependencies", dependencies];
  for (const [key, path] of Object.entries(paths)) base.push(`--${key}`, path, `--${key}-sha256`, sha256(readFileSync(path)));
  base.push("--python", process.env.QUALITY_MUTATION_PYTHON ?? process.env.D945_PYTHON ?? "python3");
  return base;
}
/** Run the campaign runner in this process so coverage observes the shard
 * paths; capture the receipt the CLI would print. */
async function runnerMain(argv: string[]): Promise<{ exitCode: number; document: ReturnType<typeof record>; shard: ReturnType<typeof record>; stderr: string }> {
  const logs: string[] = [];
  const errs: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...values: string[]) => { logs.push(values.join(" ")); };
  console.error = (...values: string[]) => { errs.push(values.join(" ")); };
  try {
    const exitCode = await main(argv);
    const document = record(decode(logs.at(-1) ?? "{}"));
    return { exitCode, document, shard: typeof document.shard === "object" ? record(document.shard) : {}, stderr: errs.join("\n") };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}
function shardDocument(root: string, output: string) {
  const native = jsonObject(decodeJson(readFileSync(join(root, output, "native.json"), "utf8")));
  const document = jsonObject(native.document);
  return { document, shard: jsonObject(document.shard) };
}
function configureDemoProject(root: string): void {
  cpSync(join(root, "src/tsconfig.json"), join(root, "packages/demo/tsconfig.json"));
  const contractPath = join(root, "contract.json");
  const contract = jsonObject(decodeJson(readFileSync(contractPath, "utf8")));
  writeFileSync(contractPath, JSON.stringify({
    ...contract, roots: ["src", "packages"], projects: ["src/tsconfig.json", "packages/demo/tsconfig.json"],
  }));
}

test("shard slices resume append-only progress and join into the single full receipt", async () => {
  // Mutants live only under packages/ (expression body, no statement sites in
  // test files), so every outcome is behavioral: killed/survived/invalid.
  const input = await fixture("", "", {
    "src/a.test.ts": 'import "../support/assertion";',
    "packages/demo/src/main.ts": "export const run = (value: number) => value > 1;",
    "support/assertion.ts":
      'import {test,expect} from "bun:test";import {run} from "../packages/demo/src/main";test("behavior",()=>{expect(run(2)).toBe(true);expect(run(0)).toBe(false);});',
  });
  configureDemoProject(input.root);
  const regenerated = await execute([process.execPath, tool, "--root", input.root, "--contract", join(input.root, "contract.json")], input.root, 15000);
  expect(regenerated.exitCode).toBe(0);
  writeFileSync(input.inventory, JSON.stringify(decodeJson(regenerated.stdout)));
  cpSync(import.meta.dir, join(input.root, "script"), { recursive: true });
  cpSync(dependencies, join(input.root, "node_modules"), { recursive: true, dereference: true });
  const progress0 = join(input.root, "progress", "shard-0.jsonl");
  const shard0 = ["--shard", "0", "--shard-count", "2", "--progress", progress0];
  // Budget-exhausted first run: clean partial stop, exit 1, nothing executed.
  // An incomplete shard with zero errors is a failure, never a green exit.
  const partial = await runnerMain([...runnerArgv(input), ...shard0, "--budget", "1"]);
  expect(partial.exitCode).toBe(1);
  expect(partial.document.full).toBe(false);
  expect(partial.document.complete).toBe(false);
  expect(partial.shard.budgetExhausted).toBe(true);
  expect(partial.shard.executed).toBe(0);
  expect(partial.shard.sliceComplete).toBe(false);
  const headerOf = (path: string) => record(decode(readFileSync(path, "utf8").split("\n")[0] ?? "null"));
  const inventoryHash = String(headerOf(progress0).inventorySha256);
  // The one spawned run of the runner CLI: same partial resume, real exit code.
  const spawned = await execute([process.execPath, runner, ...runnerArgv(input), ...shard0, "--budget", "1"], input.root, 120000);
  expect(spawned.exitCode).toBe(1);
  expect(record(record(decode(spawned.stdout)).shard).budgetExhausted).toBe(true);
  // A test selection outside the frozen inventory fails closed.
  const absentTest = await runnerMain([...runnerArgv(input), "--test", "missing.test.ts", "--budget", "1"]);
  expect(absentTest.exitCode).toBe(2);
  expect(record(absentTest.document.error).code).toBe("incompleteInventory");
  expect(String(record(absentTest.document.error).message)).toContain("Test absent from inventory");
  // Same inventory, another slice's artifact: mixing must fail closed.
  const misSharded = await runnerMain([...runnerArgv(input), "--shard", "1", "--shard-count", "2", "--progress", progress0, "--budget", "1"]);
  expect(misSharded.exitCode).toBe(2);
  const misShardedError = record(misSharded.document.error);
  expect(misShardedError.code).toBe("progress");
  expect(String(misShardedError.message)).toContain("shardIndex");
  // A different inventory's artifact is discarded (logged) and overwritten:
  // the campaign self-heals across commits instead of wedging red.
  const foreign = await fixture("export const run = () => true;", "expect(run()).toBe(true);");
  canonicalizeInventory(foreign);
  const foreignProgress = join(foreign.root, "foreign-progress.jsonl");
  cpSync(progress0, foreignProgress);
  const discarded = await runnerMain([...runnerArgv(foreign), "--shard", "0", "--shard-count", "2", "--progress", foreignProgress, "--budget", "1"]);
  expect(discarded.exitCode).toBe(1);
  expect(discarded.stderr).toContain("progress artifact for inventory");
  expect(discarded.stderr).toContain("discarded (current ");
  const staleHash = headerOf(progress0).inventorySha256;
  const rewritten = readFileSync(foreignProgress, "utf8").split("\n").filter((line) => line.length).map((line) => record(decode(line)));
  expect(rewritten.length).toBeGreaterThan(0);
  for (const row of rewritten) expect(row.inventorySha256).not.toBe(staleHash);
  // An existing but unparseable header stays a hard refusal.
  const malformed = join(foreign.root, "malformed-progress.jsonl");
  writeFileSync(malformed, "not json\n");
  const refused = await runnerMain([...runnerArgv(foreign), "--shard", "0", "--shard-count", "2", "--progress", malformed, "--budget", "1"]);
  expect(refused.exitCode).toBe(2);
  expect(record(refused.document.error).code).toBe("progress");
  // A parseable header with the wrong type or version is refused, not adopted.
  const badVersion = join(input.root, "bad-version-progress.jsonl");
  writeFileSync(badVersion, `${JSON.stringify({ ...headerOf(progress0), version: 2 })}\n`);
  const versionRefused = await runnerMain([...runnerArgv(input), "--shard", "0", "--shard-count", "2", "--progress", badVersion, "--budget", "1"]);
  expect(versionRefused.exitCode).toBe(2);
  expect(String(record(versionRefused.document.error).message)).toContain("Malformed progress header");
  // A row recorded against another inventory under a matching header is refused.
  const mixedRows = join(input.root, "mixed-rows-progress.jsonl");
  writeFileSync(mixedRows, `${JSON.stringify(headerOf(progress0))}\n${JSON.stringify({ type: "result", run: "x", inventorySha256: "0".repeat(64) })}\n`);
  const mixedRefused = await runnerMain([...runnerArgv(input), "--shard", "0", "--shard-count", "2", "--progress", mixedRows, "--budget", "1"]);
  expect(mixedRefused.exitCode).toBe(2);
  expect(String(record(mixedRefused.document.error).message)).toContain("Progress row inventory mismatch");
  // An unrecognized row type is refused, never skipped.
  const unknownRows = join(input.root, "unknown-rows-progress.jsonl");
  writeFileSync(unknownRows, `${JSON.stringify(headerOf(progress0))}\n${JSON.stringify({ type: "weird", run: "x", inventorySha256: inventoryHash })}\n`);
  const unknownRefused = await runnerMain([...runnerArgv(input), "--shard", "0", "--shard-count", "2", "--progress", unknownRows, "--budget", "1"]);
  expect(unknownRefused.exitCode).toBe(2);
  expect(String(record(unknownRefused.document.error).message)).toContain("Unrecognized progress row");
  // An unparseable line that is not final also stays a hard refusal.
  const tornMiddle = join(foreign.root, "torn-middle-progress.jsonl");
  const [progressHead, ...progressTail] = readFileSync(progress0, "utf8").split("\n").filter((line) => line.length);
  expect(progressTail.length).toBeGreaterThan(0);
  writeFileSync(tornMiddle, [progressHead, '{"type":"result","run":"torn', ...progressTail].map((line) => `${line}\n`).join(""));
  const tornRefused = await runnerMain([...runnerArgv(input), "--shard", "0", "--shard-count", "2", "--progress", tornMiddle, "--budget", "1"]);
  expect(tornRefused.exitCode).toBe(2);
  expect(record(tornRefused.document.error).code).toBe("progress");
  // Resumed in-process run completes shard 0 within its budget.
  const first = await runnerMain([...runnerArgv(input), ...shard0]);
  expect(first.exitCode).toBe(0);
  expect(first.document.full).toBe(false);
  expect(first.document.complete).toBe(true);
  expect(first.shard.sliceComplete).toBe(true);
  const sliceSize = jsonNumber(first.shard.sliceSize);
  expect(sliceSize).toBeGreaterThan(0);
  expect(jsonNumber(first.shard.recorded)).toBe(sliceSize);
  expect(jsonNumber(first.shard.executed)).toBe(sliceSize);
  const progressRows = readFileSync(progress0, "utf8").split("\n").filter((line) => line.length).map((line) => record(decode(line)));
  const sample = progressRows.find((row) => row.type === "result") ?? {};
  // A proven row whose recorded result contradicts its candidate is refused.
  const mismatch = join(input.root, "mismatch-progress.jsonl");
  cpSync(progress0, mismatch);
  appendFileSync(mismatch, `${JSON.stringify({ ...sample, run: "mismatch-run", result: { ...record(sample.result), id: "0".repeat(64) } })}\n`);
  appendFileSync(mismatch, `${JSON.stringify({ type: "proof", run: "mismatch-run", inventorySha256: inventoryHash, originalHashesVerified: true, cleanupVerified: true })}\n`);
  const mismatched = await runnerMain([...runnerArgv(input), "--shard", "0", "--shard-count", "2", "--progress", mismatch, "--budget", "1"]);
  expect(mismatched.exitCode).toBe(2);
  expect(String(record(mismatched.document.error).message)).toContain("does not match its candidate");
  // A result row is carried only when a later proof row of the same run
  // attests that the originals and the frozen execution copy were still
  // intact. A run killed before its first proof (or one that failed its
  // tamper checks, which never proves) has every row re-executed.
  const firstRun = String(sample.run);
  const [header, ...rows] = readFileSync(progress0, "utf8").split("\n").filter((line) => line.length);
  const resultRows = rows.filter((line) => line.includes('"type":"result"'));
  // Earlier partial runs proved with zero results; take the first run's own proof.
  const checkpoint = rows.find((line) => line.includes('"type":"proof"') && line.includes(firstRun)) ?? "";
  expect(resultRows).toHaveLength(sliceSize);
  expect(record(decode(checkpoint)).run).toBe(firstRun);
  const unproven = join(input.root, "unproven-progress.jsonl");
  writeFileSync(unproven, [header, ...resultRows].map((line) => `${line}\n`).join(""));
  const afterKill = await runnerMain([...runnerArgv(input), "--shard", "0", "--shard-count", "2", "--progress", unproven]);
  expect(afterKill.exitCode).toBe(0);
  expect(afterKill.document.complete).toBe(true);
  expect(jsonNumber(afterKill.shard.executed)).toBe(sliceSize);
  expect(jsonNumber(afterKill.shard.recorded)).toBe(sliceSize);
  expect(record(afterKill.document.counts)).toEqual(record(first.document.counts));
  // Rows after a run's last proof are re-executed; the rows it covers carry.
  const [provenRow, ...laterRows] = resultRows;
  const afterProof = join(input.root, "after-proof-progress.jsonl");
  writeFileSync(afterProof, [header, provenRow, checkpoint, ...laterRows].map((line) => `${line}\n`).join(""));
  const partlyProven = await runnerMain([...runnerArgv(input), "--shard", "0", "--shard-count", "2", "--progress", afterProof]);
  expect(partlyProven.exitCode).toBe(0);
  expect(jsonNumber(partlyProven.shard.executed)).toBe(sliceSize - 1);
  expect(jsonNumber(partlyProven.shard.recorded)).toBe(sliceSize);
  expect(record(partlyProven.document.counts)).toEqual(record(first.document.counts));
  // A proof never vouches for another run's rows, so a later unproven
  // duplicate cannot override the proven result it contradicts.
  const foreignProof = join(input.root, "foreign-proof-progress.jsonl");
  cpSync(progress0, foreignProof);
  appendFileSync(foreignProof, `${JSON.stringify({ ...sample, run: "unproven-run", result: { ...record(sample.result), outcome: "survived" } })}\n`);
  appendFileSync(foreignProof, `${JSON.stringify({ type: "proof", run: "other-run", inventorySha256: inventoryHash, originalHashesVerified: true, cleanupVerified: true })}\n`);
  const notOverridden = await runnerMain([...runnerArgv(input), "--shard", "0", "--shard-count", "2", "--progress", foreignProof]);
  expect(notOverridden.exitCode).toBe(0);
  expect(jsonNumber(notOverridden.shard.executed)).toBe(0);
  expect(record(notOverridden.document.counts)).toEqual(record(first.document.counts));
  // The shard reserve check: a budget that fits the run's setup but not one
  // candidate's reserve (compiler request plus the 60-minute suite deadline)
  // defers every candidate, appends no result row, and names the reserve.
  const deferred = join(input.root, "deferred-progress.jsonl");
  const deferredRun = await runnerMain([...runnerArgv(input), "--shard", "0", "--shard-count", "2", "--progress", deferred, "--budget", "600000", "--suite-timeout", "3600000"]);
  expect(deferredRun.exitCode).toBe(1);
  expect(deferredRun.shard.budgetExhausted).toBe(true);
  expect(jsonNumber(deferredRun.shard.executed)).toBe(0);
  expect(deferredRun.stderr).toContain("deferring");
  expect(deferredRun.stderr).toContain("exceeds the whole budget");
  expect(deferredRun.stderr).toContain(`deferred ${sliceSize} of ${sliceSize} pending candidates`);
  expect(readFileSync(deferred, "utf8").split("\n").filter((line) => line.includes('"type":"result"'))).toHaveLength(0);
  // A proven row without its restoration proof is refused rather than carried.
  const unrestored = join(input.root, "unrestored-progress.jsonl");
  cpSync(progress0, unrestored);
  appendFileSync(unrestored, `${JSON.stringify({ ...sample, run: "unrestored-run", result: { ...record(sample.result), restored: false } })}\n`);
  appendFileSync(unrestored, `${JSON.stringify({ type: "proof", run: "unrestored-run", inventorySha256: inventoryHash, originalHashesVerified: true, cleanupVerified: true })}\n`);
  const unrestoredRun = await runnerMain([...runnerArgv(input), "--shard", "0", "--shard-count", "2", "--progress", unrestored]);
  expect(unrestoredRun.exitCode).toBe(2);
  expect(String(record(unrestoredRun.document.error).message)).toContain("without restoration proof");
  // A proven environmental outcome displaces the carried behavioral result
  // of its candidate, which is then re-executed; its run's proof is what
  // admits the row and is listed in the receipt.
  appendFileSync(progress0, `${JSON.stringify({ ...sample, run: "env-run", result: { ...record(sample.result), outcome: "infrastructure" } })}\n`);
  appendFileSync(progress0, `${JSON.stringify({ type: "proof", run: "env-run", inventorySha256: inventoryHash, originalHashesVerified: true, cleanupVerified: true })}\n`);
  // A job killed mid-append leaves a torn trailing line; the next run drops
  // exactly that line with a warning and repairs the artifact.
  appendFileSync(progress0, '{"type":"result","run":"torn');
  // Resuming carries every recorded behavioral result and re-executes only
  // the candidate whose latest outcome was environmental.
  const resumed = await runnerMain([...runnerArgv(input), ...shard0]);
  expect(resumed.exitCode).toBe(0);
  expect(resumed.stderr).toContain("dropping torn trailing progress line");
  expect(resumed.document.complete).toBe(true);
  expect(jsonNumber(resumed.shard.executed)).toBe(1);
  expect(jsonNumber(resumed.shard.recorded)).toBe(sliceSize);
  expect(record(resumed.document.counts)).toEqual(record(first.document.counts));
  // The receipt lists one proof per earlier run (the zero-result partial
  // runs included), the first run's and env-run's among them, in artifact order.
  const carriedRuns = jsonArray(resumed.shard.carriedProofs, (proof) => record(proof).run);
  expect(carriedRuns.slice(-2)).toEqual([firstRun, "env-run"]);
  expect(new Set(carriedRuns).size).toBe(carriedRuns.length);
  const repaired = readFileSync(progress0, "utf8");
  expect(repaired).not.toContain('"run":"torn');
  for (const line of repaired.split("\n").filter((piece) => piece.length)) decode(line);
  // Re-running the complete shard through the wrapper carries every result and
  // executes none.
  const base = ["--root", input.root, "--contract", "contract.json", "--decision", decision];
  const shardBase = [...base, ...shard0];
  expect(await mutationMain([...shardBase, "--output", "shard-0-c"])).toBe(0);
  const carried = shardDocument(input.root, "shard-0-c");
  expect(carried.document.complete).toBe(true);
  expect(jsonNumber(carried.shard.executed)).toBe(0);
  expect(jsonNumber(carried.shard.recorded)).toBe(sliceSize);
  expect(record(carried.document.counts)).toEqual(record(first.document.counts));
  const lines = readFileSync(progress0, "utf8").split("\n").filter((line) => line.length).map((line) => record(decode(line)));
  expect(lines[0]?.type).toBe("shard-progress");
  // sliceSize recorded rows plus the environmental duplicate (kept in the
  // artifact) and the re-executed row.
  expect(lines.filter((line) => line.type === "result")).toHaveLength(sliceSize + 2);
  expect(lines.filter((line) => line.type === "proof").length).toBeGreaterThanOrEqual(4);
  // Second shard completes its disjoint slice.
  expect(await mutationMain([...base, "--shard", "1", "--shard-count", "2", "--progress", join(input.root, "progress", "shard-1.jsonl"), "--output", "shard-1"])).toBe(0);
  const second = shardDocument(input.root, "shard-1");
  expect(second.document.complete).toBe(true);
  // Join: all shards complete -> the existing full receipt shape plus one measurement receipt.
  const joinDir = join(input.root, "join-shards");
  for (const [index, output] of [["0", "shard-0-c"], ["1", "shard-1"]] as const) {
    mkdirSync(join(joinDir, `quality-mutation-shard-${index}`), { recursive: true });
    cpSync(join(input.root, output, "native.json"), join(joinDir, `quality-mutation-shard-${index}`, "native.json"));
  }
  const joinCode = joinMain(["--root", input.root, "--contract", "contract.json", "--shards", joinDir, "--output", "joined"]);
  const joined = jsonObject(jsonObject(decodeJson(readFileSync(join(input.root, "joined", "native.json"), "utf8"))).document);
  expect(joined.full).toBe(true);
  expect(joined.complete).toBe(true);
  const results = joined.results;
  expect(Array.isArray(results) && results.length).toBe(sliceSize + jsonNumber(second.shard.sliceSize));
  const merged = jsonObject(decodeJson(readFileSync(join(input.root, "joined", "current.json"), "utf8")));
  expect(merged.analyzed).toEqual(["mutation"]);
  const survivors = jsonNumber(jsonObject(joined.counts).survived);
  expect(Array.isArray(merged.findings) && merged.findings.length).toBe(survivors);
  expect(joinCode).toBe(survivors > 0 ? 1 : 0);
  // Join with a partial shard document: incomplete summary, exit 1, no receipt.
  const partialDir = join(input.root, "join-partial");
  mkdirSync(join(partialDir, "quality-mutation-shard-1"), { recursive: true });
  cpSync(join(joinDir, "quality-mutation-shard-1", "native.json"), join(partialDir, "quality-mutation-shard-1", "native.json"));
  mkdirSync(join(partialDir, "quality-mutation-shard-0"), { recursive: true });
  writeFileSync(join(partialDir, "quality-mutation-shard-0", "native.json"), JSON.stringify({ command: ["runner"], exitCode: partial.exitCode, document: partial.document }));
  expect(joinMain(["--root", input.root, "--contract", "contract.json", "--shards", partialDir, "--output", "joined-partial"])).toBe(1);
  expect(existsSync(join(input.root, "joined-partial"))).toBe(false);
  // Stale identity fails closed inside the real join function.
  expect(() =>
    joinShardDocuments([first.document], { inventoryHash: "0".repeat(64), contractHash: "0".repeat(64), paths: [], typescript: [] }),
  ).toThrow("stale shard inventory");
  // Spawned exit codes for the join entry point.
  const script = join(import.meta.dir, "quality-mutation-join.ts");
  const incomplete = Bun.spawnSync([process.execPath, script, "--root", input.root, "--contract", "contract.json", "--shards", partialDir, "--output", "joined-spawn"], { timeout: 120000 });
  expect(incomplete.exitCode).toBe(1);
  expect(incomplete.stderr.toString()).toContain("campaign incomplete: shards 1/2 complete");
  expect(incomplete.stderr.toString()).toContain("incomplete campaign is a failure");
  const missingBaseline = Bun.spawnSync([process.execPath, script], { timeout: 120000 });
  expect(missingBaseline.exitCode).toBe(1);
}, 600000);

test("shard arguments are validated before any campaign work starts", async () => {
  await expect(mutationMain(["--shard", "0"])).rejects.toThrow("sharded execution requires");
  await expect(
    mutationMain(["--pilot", "--shard", "0", "--shard-count", "2", "--progress", "p.jsonl"]),
  ).rejects.toThrow("--shard is incompatible with --pilot");
  await expect(
    mutationMain(["--shard", "0", "--shard-count", "2", "--progress", "p.jsonl", "--budget-minutes", "0"]),
  ).rejects.toThrow("invalid --budget-minutes");
  // The runner itself refuses incomplete or piloted shard selections.
  const incomplete = await runnerMain(["--shard", "0"]);
  expect(incomplete.exitCode).toBe(2);
  expect(record(incomplete.document.error).code).toBe("arguments");
  expect(String(record(incomplete.document.error).message)).toContain("Sharded execution requires");
  const piloted = await runnerMain(["--shard", "0", "--shard-count", "2", "--progress", "p.jsonl", "--pilot"]);
  expect(piloted.exitCode).toBe(2);
  expect(String(record(piloted.document.error).message)).toContain("incompatible with pilot");
  expect(() => joinMain([])).toThrow("shard documents directory required");
});

test("an all-invalid slice completes per shard while the join enforces campaign validity", async () => {
  const input = await fixture("", "", {
    "src/a.test.ts": 'import "../support/assertion";',
    "packages/demo/src/main.ts": "export const value: true = true;",
    "support/assertion.ts":
      'import {test,expect} from "bun:test";import {value} from "../packages/demo/src/main";test("behavior",()=>{expect(value).toBe(true);});',
  });
  configureDemoProject(input.root);
  cpSync(import.meta.dir, join(input.root, "script"), { recursive: true });
  cpSync(dependencies, join(input.root, "node_modules"), { recursive: true, dereference: true });
  const progress = join(input.root, "progress", "shard-0.jsonl");
  expect(
    await mutationMain(["--root", input.root, "--contract", "contract.json", "--decision", decision, "--shard", "0", "--shard-count", "1", "--progress", progress, "--output", "shard-only"]),
  ).toBe(0);
  const only = shardDocument(input.root, "shard-only");
  const counts = jsonObject(only.document.counts);
  expect(jsonNumber(counts.invalid)).toBeGreaterThan(0);
  expect(jsonNumber(counts.killed) + jsonNumber(counts.survived) + jsonNumber(counts.noCoverage)).toBe(0);
  expect(only.document.complete).toBe(true);
  expect(only.shard.sliceComplete).toBe(true);
  // The valid-outcome sanity floor moved to the campaign level: the join
  // refuses to mint a receipt from a campaign with zero valid outcomes.
  const identity = fingerprint(input.root, "contract.json");
  expect(() => joinShardDocuments([only.document], identity)).toThrow("no valid outcomes across shards");
}, 300000);
