import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareBenchmarks, main, readBenchmarkHistory, regressionThreshold } from "./check-benchmark-regression";
import { EXPECTED_BENCHMARK_NAMES } from "./summarize-benchmark-runs";
import { z } from "zod";
import { decodeJson } from "./quality-json";

const metrics = (value: number) => EXPECTED_BENCHMARK_NAMES.map((name: string) => ({ name, unit: "ns/op", value, p50: value, runs: 5 }));
const commit = (index: number) => index.toString(16).padStart(40, "a");
const history = (...values: number[]) => ({ entries: { "Oni Benchmarks": values.map((value, index) => ({ commit: { id: commit(index) }, tool: "customSmallerIsBetter", benches: metrics(value) })) } });

test("gate uses repeated-run median, latest accepted reference and strict percent boundary", () => {
  expect(compareBenchmarks(metrics(120), history(100)).failed).toBe(false);
  expect(compareBenchmarks(metrics(121), history(100)).failed).toBe(true);
  expect(compareBenchmarks(metrics(90), history(100)).failed).toBe(false);
  expect(compareBenchmarks(metrics(121), history(100), 25).failed).toBe(false);
  const current = metrics(100).map((metric) => ({ ...metric, value: 999, mean: 999 }));
  expect(compareBenchmarks(current, history(100)).failed).toBe(false);
  const result = compareBenchmarks(metrics(121), history(99, 100));
  expect(result.referenceCommit).toBe(commit(1));
  expect(result.comparisons[0]?.reference).toBe(100);
  expect(result.failed).toBe(true);
});

test("a single regression fails, and a zero reference cannot hide growth", () => {
  const current = metrics(100);
  const first = current[0];
  if (!first) throw new Error("Missing test metric");
  first.p50 = 121;
  const result = compareBenchmarks(current, history(100));
  expect(result.failed).toBe(true);
  expect(result.comparisons.filter((metric) => metric.regressed)).toHaveLength(1);
  expect(compareBenchmarks(metrics(0), history(0)).failed).toBe(false);
  expect(compareBenchmarks(metrics(1), history(0)).failed).toBe(true);
});

test("regression must also exceed two historical sample standard deviations", () => {
  const noisy = history(50, 150, 100);
  expect(compareBenchmarks(metrics(121), noisy).failed).toBe(false);
  expect(compareBenchmarks(metrics(200), noisy).failed).toBe(false);
  const result = compareBenchmarks(metrics(201), noisy);
  expect(result.comparisons[0]?.noiseBand).toBe(100);
  expect(result.failed).toBe(true);
  expect(compareBenchmarks(metrics(121), history(10000, ...Array.from({ length: 20 }, () => 100))).failed).toBe(true);
});

test.each([Number.NaN, Number.POSITIVE_INFINITY, -1])("invalid metric value %s fails closed", (value) => {
  expect(() => compareBenchmarks(metrics(value), history(100))).toThrow();
});

test("invalid input and malformed references fail closed", () => {
  for (const input of ["", "0", "-1", "NaN", "Infinity", "20%"])
    expect(() => regressionThreshold(input)).toThrow();
  expect(regressionThreshold()).toBe(20);
  expect(regressionThreshold("12.5")).toBe(12.5);
  expect(() => compareBenchmarks([], history(100))).toThrow();
  expect(() => compareBenchmarks([...metrics(100), ...metrics(100)], history(100))).toThrow();
  expect(() => compareBenchmarks(metrics(100), history())).toThrow();

  const duplicate = history(100);
  duplicate.entries["Oni Benchmarks"][0]?.benches.push(...metrics(100));
  expect(() => compareBenchmarks(metrics(100), duplicate)).toThrow();
  const wrongUnit = metrics(100).map((metric) => ({ ...metric, unit: "ms/op" }));
  expect(() => compareBenchmarks(wrongUnit, history(100))).toThrow();
});

test("accepted history rejects unexpected metrics and malformed commit identities", () => {
  const extra = history(100);
  extra.entries["Oni Benchmarks"][0]?.benches.push({ name: "unexpected", unit: "ns/op", value: 100, p50: 100, runs: 5 });
  expect(() => compareBenchmarks(metrics(100), extra)).toThrow();
  for (const id of ["", "main", "d6df4980", "g".repeat(40), `${"a".repeat(40)}\n`, "--detach"]) {
    const malformed = history(100);
    const entry = malformed.entries["Oni Benchmarks"][0];
    if (!entry) throw new Error("Missing test reference");
    entry.commit.id = id;
    expect(() => compareBenchmarks(metrics(100), malformed)).toThrow();
  }
});

test("head-only metrics are reported without gating while shared regressions fail", () => {
  const reference = history(100);
  reference.entries["Oni Benchmarks"].forEach((entry) => { entry.benches = entry.benches.slice(0, 14); });
  const current = metrics(100).map((metric, index) => index < 14 ? metric : { ...metric, p50: 1_000_000 });
  const result = compareBenchmarks(current, reference);
  expect(result.failed).toBe(false);
  expect(result.comparisons).toHaveLength(22);
  expect(result.comparisons.slice(14)).toEqual(current.slice(14).map((metric) => ({
    name: metric.name, median: metric.p50, reference: null, noiseBand: null,
    limit: null, regressed: false, status: "new (no reference)",
  })));
  const regressed = current.map((metric, index) => index === 0 ? { ...metric, p50: 121 } : metric);
  expect(compareBenchmarks(regressed, reference).comparisons.filter((metric) => metric.regressed)).toHaveLength(1);
  expect(compareBenchmarks(regressed, reference).failed).toBe(true);
});

test("reference-only metrics fail structurally even when the reference name is in the head contract", () => {
  expect(() => compareBenchmarks(metrics(100).slice(1), history(100))).toThrow(z.ZodError);
  const reference = history(100);
  reference.entries["Oni Benchmarks"].forEach((entry) => {
    entry.benches.push({ name: "reference-only", unit: "ns/op", value: 100, p50: 100, runs: 5 });
  });
  expect(() => compareBenchmarks(metrics(100), reference)).toThrow(z.ZodError);
});

test("paired CLI admits host-speed shifts but rejects real regressions and invalid references", async () => {
  const root = mkdtempSync(join(tmpdir(), "benchmark-paired-"));
  const cwd = process.cwd(), env = { ...process.env };
  try {
    process.chdir(root);
    process.env.BENCHMARK_REGRESSION_PERCENT = "20";
    process.env.GITHUB_STEP_SUMMARY = "bench-results/summary.md";
    const acceptedHistory = history(50, 150, 100);
    acceptedHistory.entries["Oni Benchmarks"].forEach((entry) => { entry.benches = entry.benches.slice(0, 14); });
    // Retired older metric sets do not replace or invalidate the latest reference.
    acceptedHistory.entries["Oni Benchmarks"][0]?.benches.pop();
    const accepted = `window.BENCHMARK_DATA = ${JSON.stringify(acceptedHistory)};\n`;
    const referenceMetrics = metrics(180).slice(0, 14);
    const fresh = JSON.stringify(referenceMetrics.map((metric) => ({ ...metric, value: 999 })));
    await Bun.write("bench-results/accepted.js", accepted);
    await Bun.write("bench-results/reference/statistics.json", fresh);
    const prepare = ["--prepare-reference", "bench-results/reference/statistics.json", "bench-results/accepted.js", commit(2), commit(3)];
    expect(await main(prepare)).toBe(0);
    const referenceSource = await Bun.file("bench-results/reference.json").text();
    const reference = decodeJson(referenceSource);
    const hash = (source: string) => createHash("sha256").update(source).digest("hex");
    expect(reference).toMatchObject({
      entries: { "Oni Benchmarks": [{ commit: { id: commit(2) }, benches: referenceMetrics.map(({ name, unit, p50 }) => ({ name, unit, value: p50 })) }] },
      paired: { headCommit: commit(3), referenceCommit: commit(2), acceptedHistorySha256: hash(accepted), referenceStatisticsSha256: hash(fresh) },
    });
    expect(compareBenchmarks(metrics(180), history(100)).failed).toBe(true);
    for (const { value, exit } of [{ value: 180, exit: 0 }, { value: 216, exit: 0 }, { value: 217, exit: 1 }]) {
      const current = JSON.stringify(metrics(value));
      await Bun.write("bench-results/statistics.json", current);
      expect(await main(["bench-results/statistics.json", "bench-results/reference.json"])).toBe(exit);
      const result = decodeJson(await Bun.file("bench-results/regression.json").text());
      expect(result).toMatchObject({ failed: exit === 1, referenceCommit: commit(2), threshold: 20, statisticsSha256: hash(current), historySha256: hash(referenceSource) });
      const comparisons = compareBenchmarks(metrics(value), reference).comparisons;
      expect(comparisons.slice(0, 14).every((metric) => metric.noiseBand === 0)).toBe(true);
      expect(comparisons.slice(14).every((metric) => metric.status === "new (no reference)")).toBe(true);
      const summary = await Bun.file("bench-results/summary.md").text();
      for (const metric of comparisons.slice(14)) {
        expect(summary).toContain(`| ${metric.name} | ${metric.median} | - | - | ${metric.status} |`);
      }
    }
    expect(await main(["--accepted-commit", "bench-results/accepted.js"])).toBe(0);
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "check-benchmark-regression.ts"), "--accepted-commit", "bench-results/accepted.js"], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: `${commit(2)}\n`, stderr: "" });
    await expect(main(["--prepare-reference", "bench-results/reference/statistics.json", "bench-results/accepted.js", commit(1), commit(3)])).rejects.toThrow("Measured reference commit does not match accepted history");
    await expect(main([...prepare.slice(0, 4), "main"])).rejects.toThrow();
    for (const invalid of [[], [...metrics(180), ...metrics(180)], [...metrics(180), { name: "unexpected", unit: "ns/op", value: 180, p50: 180, runs: 5 }]]) {
      await Bun.write("bench-results/reference/statistics.json", JSON.stringify(invalid));
      await expect(main(prepare)).rejects.toThrow();
    }
    await Bun.write("bench-results/reference/statistics.json", JSON.stringify(metrics(180).slice(1, 14)));
    await expect(main(prepare)).rejects.toThrow("Measured reference metrics do not match accepted history");
    for (const benches of [[], [...metrics(100), ...metrics(100)]]) {
      const invalid = history(100, 100);
      const latest = invalid.entries["Oni Benchmarks"].at(-1);
      if (!latest) throw new Error("Missing test reference");
      latest.benches = benches;
      await Bun.write("bench-results/accepted.js", JSON.stringify(invalid));
      await expect(main(["--accepted-commit", "bench-results/accepted.js"])).rejects.toThrow();
    }
    await expect(main(["--accepted-commit", "absent.js"])).rejects.toThrow();
    await Bun.write("bench-results/accepted.js", JSON.stringify(history()));
    await expect(main(["--accepted-commit", "bench-results/accepted.js"])).rejects.toThrow();
    const malformed = history(100);
    const entry = malformed.entries["Oni Benchmarks"][0];
    if (!entry) throw new Error("Missing test reference");
    entry.commit.id = "main";
    await Bun.write("bench-results/accepted.js", JSON.stringify(malformed));
    await expect(main(["--accepted-commit", "bench-results/accepted.js"])).rejects.toThrow();
    expect(await Bun.file("bench-results/reference.json").text()).toBe(referenceSource);
  } finally {
    process.chdir(cwd);
    process.env = env;
    rmSync(root, { recursive: true, force: true });
  }
});

test("gh-pages wrapper is parsed as data, never evaluated", () => {
  const data = history(100);
  expect(readBenchmarkHistory(`window.BENCHMARK_DATA = ${JSON.stringify(data)};\n`)).toEqual(data);
  expect(readBenchmarkHistory(JSON.stringify(data))).toEqual(data);
  expect(() => readBenchmarkHistory("window.BENCHMARK_DATA = process.exit(0)")).toThrow();
  expect(() => readBenchmarkHistory("window.BENCHMARK_DATA = {}; process.exit(0)")).toThrow();
  expect(() => readBenchmarkHistory('window.BENCHMARK_DATA = {"entries":{},"entries":{}}')).toThrow();
});

test("CLI exposes failing status, artifact and job summary without changing the reference", async () => {
  const root = mkdtempSync(join(tmpdir(), "benchmark-gate-"));
  const cwd = process.cwd(), env = { ...process.env };
  try {
    process.chdir(root);
    mkdirSync(join(root, "bench-results"));
    const reference = `window.BENCHMARK_DATA = ${JSON.stringify(history(100))}`;
    await Bun.write(join(root, "bench-results/reference.js"), reference);
    await Bun.write(join(root, "bench-results/statistics.json"), JSON.stringify(metrics(121)));
    const summary = join(root, "summary.md");
    const cli = join(import.meta.dir, "check-benchmark-regression.ts");
    process.env.GITHUB_STEP_SUMMARY = summary;
    expect(await main(["--validate-input"])).toBe(0);
    for (const [threshold, exit] of [["20", 1], ["25", 0]] as const) {
      const child = Bun.spawn([process.execPath, cli], { cwd: root, env: { ...process.env, BENCHMARK_REGRESSION_PERCENT: threshold, GITHUB_STEP_SUMMARY: summary }, stdout: "ignore", stderr: "pipe" });
      const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect(stderr).toBe("");
      expect(code).toBe(exit);
      process.env.BENCHMARK_REGRESSION_PERCENT = threshold;
      expect(await main([])).toBe(exit);
      const result = decodeJson(await Bun.file(join(root, "bench-results/regression.json")).text());
      expect(result).toMatchObject({ failed: exit === 1, referenceCommit: commit(0) });
    }
    expect(await Bun.file(summary).exists()).toBe(true);
    expect(await Bun.file(join(root, "bench-results/reference.js")).text()).toBe(reference);
    const validate = Bun.spawn([process.execPath, cli, "--validate-input"], { cwd: root, env: { ...process.env, BENCHMARK_REGRESSION_PERCENT: "20" }, stdout: "ignore", stderr: "pipe" });
    expect(await validate.exited).toBe(0);
  } finally {
    process.chdir(cwd);
    process.env = env;
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);

test("owner baseline acceptance is explicit and remains structurally validated", async () => {
  const root = mkdtempSync(join(tmpdir(), "benchmark-acceptance-"));
  const cwd = process.cwd(), env = { ...process.env };
  try {
    process.chdir(root);
    mkdirSync(join(root, "bench-results"));
    await Bun.write(join(root, "bench-results/reference.js"), JSON.stringify(history(100)));
    await Bun.write(join(root, "bench-results/statistics.json"), JSON.stringify(metrics(121)));
    const summary = join(root, "summary.md");
    process.env.BENCHMARK_REGRESSION_PERCENT = "20";
    process.env.GITHUB_STEP_SUMMARY = summary;

    process.env.BENCHMARK_ACCEPT_BASELINE = "true";
    expect(await main([])).toBe(0);
    expect(await Bun.file(summary).text()).toContain("Baseline reset accepted by Owner (BENCHMARK_ACCEPT_BASELINE=true)");
    expect(await Bun.file(summary).text()).toContain("ACCEPTED");

    for (const value of ["1", "yes"] as const) {
      process.env.BENCHMARK_ACCEPT_BASELINE = value;
      expect(await main([])).toBe(1);
      expect(await Bun.file(summary).text()).toContain("FAIL");
    }

    process.env.BENCHMARK_ACCEPT_BASELINE = "true";
    await Bun.write(join(root, "bench-results/statistics.json"), JSON.stringify([]));
    await expect(main([])).rejects.toThrow();
    await Bun.write(join(root, "bench-results/statistics.json"), JSON.stringify(metrics(121)));
    await Bun.write(join(root, "bench-results/reference.js"), JSON.stringify(history()));
    await expect(main([])).rejects.toThrow();
  } finally {
    process.chdir(cwd);
    process.env = env;
    rmSync(root, { recursive: true, force: true });
  }
});
