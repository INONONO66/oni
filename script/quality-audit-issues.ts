import { z } from "zod";
import { aggregateFiles, auditCommand, type Audit, findingKinds, totalsSchema } from "./quality-audit";

const issueSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().nullable(),
  state: z.enum(["open", "closed"]),
  labels: z.array(z.object({ name: z.string() })),
});
type Issue = z.infer<typeof issueSchema>;
/** Historical summaries can predate the cyclomatic/Halstead/CRAP dimensions.
 * Decoding accepts version-1 totals without them: an absent dimension means
 * "not previously measured", never an invented historical zero. Current-output
 * validation stays on the full totalsSchema in quality-audit.ts. */
const previousTotalsSchema = totalsSchema.partial({
  cyclomatic: true,
  halstead: true,
  crap: true,
});
const previousSchema = z.object({
  version: z.literal(1),
  head: z.string().regex(/^[a-f0-9]{40}$/),
  totals: previousTotalsSchema,
});
type Previous = z.infer<typeof previousSchema>;
const SUMMARY = "quality: audit summary";
const LABEL = "quality-debt";
/** The audit owns exactly one issue: the rolling summary. Per-file and
 * per-regression issues were noise that every run reopened after a hand close,
 * so the publisher never reads, writes, or closes any other issue. */
type Operation = {
  action: "create" | "update";
  title: string;
  body: string;
  labels: string[];
  number?: number;
};
type Gh = (args: readonly string[], input?: string) => Promise<string>;

export function previousAudit(body: string): Previous {
  const block = /<!-- quality-audit:v1 -->\s*```json\s*([\s\S]*?)\s*```/.exec(body);
  if (!block) throw new Error("Summary has no quality-audit totals; refusing to reset history");
  return previousSchema.parse(JSON.parse(block[1] ?? ""));
}

export function regressions(previous: Previous, audit: Audit) {
  return findingKinds.flatMap((kind) => {
    const measured = previous.totals[kind];
    return measured !== undefined && audit.totals[kind] > measured
      ? [{ kind, previous: measured, current: audit.totals[kind] }]
      : [];
  });
}

function cell(text: string) {
  return text.replaceAll("|", "\\|").replaceAll("\n", " ").replaceAll("\r", " ");
}

function upsert(body: string, issues: readonly Issue[]): Operation {
  const existing =
    issues.find((issue) => issue.title === SUMMARY && issue.state === "open") ??
    issues.find((issue) => issue.title === SUMMARY);
  return {
    action: existing ? "update" : "create",
    title: SUMMARY,
    body,
    labels: [...new Set([...(existing?.labels.map((label) => label.name) ?? []), LABEL])],
    ...(existing ? { number: existing.number } : {}),
  };
}

function summaryBody(audit: Audit, previous: Previous | undefined) {
  const files = aggregateFiles(audit.findings);
  const increased = previous ? regressions(previous, audit) : [];
  return [
    `Audit: ${audit.runUrl}`,
    `Commit: ${audit.head}`,
    `Complete: ${audit.complete}; first run: ${!previous}`,
    "",
    "| Kind | Previous | Current |",
    "| --- | ---: | ---: |",
    ...findingKinds.map(
      (kind) => `| ${kind} | ${previous?.totals[kind] ?? "-"} | ${audit.totals[kind]} |`,
    ),
    "",
    previous
      ? `Regressions since ${previous.head}: ${
          increased.length
            ? increased.map((row) => `${row.kind} ${row.previous} -> ${row.current}`).join(", ")
            : "none"
        }.`
      : "No previous audit to compare against.",
    "",
    `Mutation: see [quality-mutation.yml](${audit.runUrl.split("/").slice(0, 5).join("/")}/actions/workflows/quality-mutation.yml).`,
    "",
    "Totals count uncovered executable lines (or one missing-file record), complex functions, clone endpoints, and type sites.",
    "Coverage denominators and all findings are in the quality-audit.json run artifact. Missing source records are not zero coverage debt.",
    "",
    "## Highest finding counts",
    "| File | Count |",
    "| --- | ---: |",
    ...files.slice(0, 50).map((file) => `| ${cell(file.path)} | ${file.count} |`),
    "",
    "<!-- quality-audit:v1 -->",
    "```json",
    JSON.stringify({ version: 1, head: audit.head, totals: audit.totals }),
    "```",
  ].join("\n");
}

export function planIssues(audit: Audit, issues: readonly Issue[]) {
  const summary = issues.find((issue) => issue.title === SUMMARY);
  const previous = summary ? previousAudit(summary.body ?? "") : undefined;
  return { firstRun: !summary, operation: upsert(summaryBody(audit, previous), issues) };
}

export async function ghCommand(args: readonly string[], input?: string, executable = "gh") {
  return auditCommand([executable, ...args], [0], input, process.cwd());
}

async function apply(operation: Operation, endpoint: string, run: Gh) {
  const target = operation.number ? `${endpoint}/${operation.number}` : endpoint;
  const result = await run(
    ["api", "--method", operation.number ? "PATCH" : "POST", target, "--input", "-"],
    JSON.stringify({
      title: operation.title,
      body: operation.body,
      labels: operation.labels,
      ...(operation.number ? { state: "open" } : {}),
    }),
  );
  z.object({ number: z.number().int().positive() }).parse(JSON.parse(result));
}

export async function publishAudit(
  audit: Audit,
  run: Gh = ghCommand,
  repository = process.env.GITHUB_REPOSITORY ?? "",
) {
  if (!audit.complete) throw new Error("Refusing to publish incomplete audit");
  const repo =
    repository ||
    z
      .object({ nameWithOwner: z.string() })
      .parse(JSON.parse(await run(["repo", "view", "--json", "nameWithOwner"]))).nameWithOwner;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("Invalid repository");
  const endpoint = `repos/${repo}/issues`;
  const response = await run([
    "api",
    "--paginate",
    "--slurp",
    `${endpoint}?state=all&labels=${LABEL}&per_page=100`,
  ]);
  const issues = z.array(z.array(issueSchema)).parse(JSON.parse(response)).flat();
  const plan = planIssues(audit, issues);
  await run(["label", "create", LABEL, "--repo", repo, "--color", "D4C5F9", "--force"]);
  await apply(plan.operation, endpoint, run);
  return plan;
}
