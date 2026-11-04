import { YAML } from "bun";
import { expect, test } from "bun:test";
import { z } from "zod";

const Step = z.object({
  name: z.string().optional(),
  uses: z.string().optional(),
  run: z.string().optional(),
  if: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  with: z.record(z.string(), z.union([z.string(), z.boolean(), z.number()])).optional(),
});
const Job = z.object({
  needs: z.array(z.string()).optional(),
  permissions: z.object({ contents: z.string() }).optional(),
  strategy: z.object({ matrix: z.object({ include: z.array(z.object({ platform: z.string(), runner: z.string() })) }) }).optional(),
  steps: z.array(Step),
});
const Workflow = z.object({
  name: z.string(),
  on: z.object({ push: z.object({ tags: z.array(z.string()) }) }),
  permissions: z.object({ contents: z.string() }),
  jobs: z.object({ build: Job, release: Job }),
});
const path = new URL("../.github/workflows/release-mclient.yml", import.meta.url);
const workflow = Workflow.parse(YAML.parse(await Bun.file(path).text()));

test("mclient releases build every platform on a mclient-v tag and publish the digests beside the archives", () => {
  expect(workflow.on.push.tags).toEqual(["mclient-v*"]);
  expect(workflow.permissions.contents).toBe("read");
  expect(workflow.jobs.build.strategy?.matrix.include.map((entry) => entry.platform).sort())
    .toEqual(["darwin-universal", "linux-arm64", "linux-x86_64"]);
  expect(workflow.jobs.release.needs).toEqual(["build"]);
  expect(workflow.jobs.release.permissions?.contents).toBe("write");
  const steps = workflow.jobs.release.steps;
  const packaged = steps.findIndex((step) => step.run?.includes("script/build-clients-release.ts"));
  const verified = steps.findIndex((step) => step.run?.includes("sha256sum -c SHA256SUMS"));
  const published = steps.findIndex((step) => step.run?.startsWith("gh release create"));
  expect(packaged).toBeGreaterThanOrEqual(0);
  expect(verified).toBeGreaterThan(packaged);
  expect(published).toBeGreaterThan(verified);
  for (const asset of ["clients/release.json", "clients/SHA256SUMS", "clients/mclient-*.tar.gz", "clients/mclient-*.tar.gz.sha256"]) {
    expect(steps[published]?.run).toContain(asset);
  }
});

test("signing uses the certificate only when its secrets exist and never fails without them", () => {
  const signing = workflow.jobs.build.steps.find((step) => step.name?.startsWith("Sign"));
  expect(signing?.if).toBe("matrix.platform == 'darwin-universal'");
  expect(signing?.env).toEqual({
    SIGNING_P12: ["$", "{{ secrets.MCLIENT_SIGNING_P12 }}"].join(""),
    SIGNING_PASSWORD: ["$", "{{ secrets.MCLIENT_SIGNING_PASSWORD }}"].join(""),
  });
  const run = signing?.run ?? "";
  expect(run).toContain('if [[ -z "$SIGNING_P12" || -z "$SIGNING_PASSWORD" ]]; then');
  const withoutSecrets = run.slice(run.indexOf("then") + "then".length, run.indexOf("else"));
  expect(withoutSecrets).toContain("::notice::");
  expect(withoutSecrets).toContain("codesign --force --sign - --identifier ai.oni.mclient out/mclient");
  expect(withoutSecrets).not.toContain("exit");
});

test("actionlint accepts the workflow when it is on PATH", () => {
  const actionlint = Bun.which("actionlint");
  if (actionlint === null) return;
  const result = Bun.spawnSync([actionlint, "-no-color", Bun.fileURLToPath(path)]);
  expect(result.stdout.toString() + result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
});
