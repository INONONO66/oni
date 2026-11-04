import { YAML } from "bun";
import { expect, test } from "bun:test";
import { z } from "zod";

const Step = z.object({ run: z.string().optional() });
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

/** The release assets `/machine/release` resolves: the manifest, the digest list, and one archive plus digest per platform. */
const HOST_CONTRACT_ASSETS = ["clients/release.json", "clients/SHA256SUMS", "clients/mclient-*.tar.gz", "clients/mclient-*.tar.gz.sha256"];

class ActionlintMissing extends Error {
  override readonly name = "ActionlintMissing";
  constructor() {
    super("actionlint is not on PATH; install it (brew install actionlint, or go install github.com/rhysd/actionlint/cmd/actionlint@latest)");
  }
}

test("mclient releases build every platform on a mclient-v tag and publish the assets the host contract resolves", () => {
  expect(workflow.on.push.tags).toEqual(["mclient-v*"]);
  expect(workflow.permissions.contents).toBe("read");
  expect(workflow.jobs.build.strategy?.matrix.include.map((entry) => entry.platform).sort())
    .toEqual(["darwin-universal", "linux-arm64", "linux-x86_64"]);
  expect(workflow.jobs.release.needs).toEqual(["build"]);
  expect(workflow.jobs.release.permissions?.contents).toBe("write");
  const publishing = workflow.jobs.release.steps.filter((step) => HOST_CONTRACT_ASSETS.every((asset) => step.run?.includes(asset)));
  expect(publishing).toHaveLength(1);
});

test("actionlint accepts the workflow; a missing binary is a typed refusal, not a silent pass", () => {
  const actionlint = Bun.which("actionlint");
  if (actionlint === null) throw new ActionlintMissing();
  const result = Bun.spawnSync([actionlint, "-no-color", Bun.fileURLToPath(path)]);
  expect(result.stdout.toString() + result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
});
