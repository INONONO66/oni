import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { z } from "zod";
import { decodeJson, type Json } from "./quality-json";
import { EXPECTED_BENCHMARK_NAMES } from "./summarize-benchmark-runs";

const Commit = z.string().regex(/^[0-9a-f]{40}$/).length(40);
const Metric = z.object({ name: z.string(), unit: z.literal("ns/op"), value: z.number().nonnegative() });
function completeMetricSet(metrics: readonly { name: string }[]): boolean {
  const names = metrics.map((metric) => metric.name).sort();
  const expected = [...EXPECTED_BENCHMARK_NAMES].sort();
  return names.length === expected.length && names.every((name, index) => name === expected[index]);
}
function referenceMetricSet(metrics: readonly { name: string }[]): boolean {
  const expected = new Set<string>(EXPECTED_BENCHMARK_NAMES);
  const names = metrics.map((metric) => metric.name);
  return names.length > 0 && new Set(names).size === names.length && names.every((name) => expected.has(name));
}
const Statistic = Metric.extend({ p50: z.number().nonnegative(), runs: z.number().int().positive() });
const Statistics = z.array(Statistic)
  .refine(completeMetricSet, "Current benchmark metric set is incomplete, unexpected or duplicated");
const ReferenceStatistics = z.array(Statistic).refine(referenceMetricSet, "Reference benchmark metric set is empty, unexpected or duplicated");
const ReferenceMetrics = z.array(Metric).refine(referenceMetricSet, "Reference benchmark metric set is empty, unexpected or duplicated");
const History = z.object({ entries: z.object({ "Oni Benchmarks": z.array(z.object({
  commit: z.object({ id: Commit }),
  tool: z.literal("customSmallerIsBetter"),
  benches: z.array(Metric),
})).nonempty() }) });

export function regressionThreshold(input = "20"): number {
  return z.coerce.number().positive().parse(input);
}

/** data.js is JSON with a fixed assignment wrapper, never executable input. */
export function readBenchmarkHistory(source: string): Json {
  return decodeJson(source.replace(/^\s*window\.BENCHMARK_DATA\s*=\s*/, "").replace(/;\s*$/, ""));
}

function standardDeviation(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1));
}

function compareMetric(metric: z.infer<typeof Statistic>, reference: z.infer<typeof Metric> | undefined, values: readonly number[], percent: number) {
  if (!reference) return {
    name: metric.name, median: metric.p50, reference: null, noiseBand: null,
    limit: null, regressed: false, status: "new (no reference)",
  };
  const noiseBand = 2 * standardDeviation(values);
  const delta = metric.p50 - reference.value;
  const regressed = delta > reference.value * percent / 100 && delta > noiseBand;
  return {
    name: metric.name, median: metric.p50, reference: reference.value, noiseBand,
    limit: Math.max(reference.value * (1 + percent / 100), reference.value + noiseBand),
    regressed, status: regressed ? "FAIL" : "PASS",
  };
}

export function compareBenchmarks(statistics: Json, history: Json, threshold = 20) {
  const percent = regressionThreshold(String(threshold));
  const current = Statistics.parse(statistics);
  const accepted = History.parse(history).entries["Oni Benchmarks"].slice(-20);
  const latest = accepted[accepted.length - 1];
  if (!latest) throw new Error("Missing accepted main benchmark reference");
  ReferenceMetrics.parse(latest.benches);
  const comparisons = current.map((metric) => {
    const reference = latest.benches.find((entry) => entry.name === metric.name);
    const values = accepted.flatMap((entry) => entry.benches.filter((bench) => bench.name === metric.name).map((bench) => bench.value));
    return compareMetric(metric, reference, values, percent);
  });
  return { referenceCommit: latest.commit.id, threshold: percent, comparisons, failed: comparisons.some((metric) => metric.regressed) };
}

function sha256(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

async function prepareReference(args: string[]): Promise<void> {
  const [, statisticsPath, historyPath, measuredCommit, headCommit] = z.tuple([z.literal("--prepare-reference"), z.string(), z.string(), Commit, Commit]).parse(args);
  const statisticsSource = await Bun.file(statisticsPath).text();
  const historySource = await Bun.file(historyPath).text();
  const statistics = ReferenceStatistics.parse(decodeJson(statisticsSource));
  const accepted = acceptedReference(readBenchmarkHistory(historySource));
  const referenceCommit = accepted.commit.id;
  const expectedNames = metricNames(accepted.benches);
  if (metricNames(statistics) !== expectedNames) throw new Error("Measured reference metrics do not match accepted history");
  if (measuredCommit !== referenceCommit) throw new Error("Measured reference commit does not match accepted history");
  const reference = {
    entries: { "Oni Benchmarks": [{
      commit: { id: referenceCommit }, tool: "customSmallerIsBetter",
      benches: statistics.map(({ name, unit, p50 }) => ({ name, unit, value: p50 })),
    }] },
    paired: { referenceCommit, headCommit, acceptedHistorySha256: sha256(historySource), referenceStatisticsSha256: sha256(statisticsSource) },
  };
  await Bun.write("bench-results/reference.json", `${JSON.stringify(reference, null, 2)}\n`);
}

function metricNames(metrics: readonly { readonly name: string }[]): string {
  return metrics.map((metric) => metric.name).sort().join("\n");
}

function acceptedReference(history: Json) {
  const latest = History.parse(history).entries["Oni Benchmarks"].at(-1);
  if (!latest) throw new Error("Missing accepted main benchmark reference");
  ReferenceMetrics.parse(latest.benches);
  return latest;
}

const BaselineAcceptance = z.literal("true");

function acceptsBaseline(value: string | undefined): boolean {
  return BaselineAcceptance.safeParse(value).success;
}

function rowVerdict(exceeds: boolean, accept: boolean): "ACCEPTED" | "FAIL" {
  return exceeds && accept ? "ACCEPTED" : "FAIL";
}

export async function main(args = Bun.argv.slice(2)): Promise<number> {
  const acceptBaseline = acceptsBaseline(process.env.BENCHMARK_ACCEPT_BASELINE);
  const threshold = regressionThreshold(process.env.BENCHMARK_REGRESSION_PERCENT);
  if (args[0] === "--validate-input") return 0;
  if (args[0] === "--accepted-commit") {
    const [, path] = z.tuple([z.literal("--accepted-commit"), z.string()]).parse(args);
    console.log(acceptedReference(readBenchmarkHistory(await Bun.file(path).text())).commit.id);
    return 0;
  }
  if (args[0] === "--prepare-reference") {
    await prepareReference(args);
    return 0;
  }
  const statisticsSource = await Bun.file(args[0] ?? "bench-results/statistics.json").text();
  const historySource = await Bun.file(args[1] ?? "bench-results/reference.js").text();
  const result = {
    ...compareBenchmarks(decodeJson(statisticsSource), readBenchmarkHistory(historySource), threshold),
    statisticsSha256: sha256(statisticsSource), historySha256: sha256(historySource),
  };
  const summary = [
    acceptBaseline ? "## Baseline reset accepted by Owner (BENCHMARK_ACCEPT_BASELINE=true)" : "## Benchmark regression gate", "",
    `Accepted main reference: ${result.referenceCommit}. Fail above both ${threshold}% and two sample standard deviations of the latest 20 accepted medians (zero band with fewer than two samples).`, "",
    "| Benchmark | Head p50 ns/op | Reference ns/op | Limit ns/op | Result |",
    "| --- | ---: | ---: | ---: | --- |",
    ...result.comparisons.map((metric) => `| ${metric.name} | ${metric.median} | ${metric.reference ?? "-"} | ${metric.limit ?? "-"} | ${metric.regressed ? rowVerdict(metric.regressed, acceptBaseline) : metric.status} |`), "",
  ].join("\n");
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  await Bun.write("bench-results/regression.json", `${JSON.stringify(result, null, 2)}\n`);
  return result.failed && !acceptBaseline ? 1 : 0;
}

if (import.meta.main) process.exitCode = await main();
