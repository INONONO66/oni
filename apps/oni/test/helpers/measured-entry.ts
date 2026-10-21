import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bounded } from "./protected-dispatch";

/** Run the actual import.meta.main module as a Bun test entry to obtain native child LCOV. */
export async function measuredEntry(entry: URL, env: Record<string, string>, input?: string) {
  const parent = process.env.ONI_CHILD_COVERAGE_DIR ?? tmpdir();
  mkdirSync(parent, { recursive: true });
  const coverage = mkdtempSync(join(parent, "oni-entry-coverage-"));
  const child = Bun.spawn(
    [
      process.execPath,
      "test",
      entry.pathname,
      "--coverage",
      "--coverage-reporter=lcov",
      `--coverage-dir=${coverage}`,
    ],
    {
      cwd: new URL("../../", import.meta.url).pathname,
      env,
      stdin: input === undefined ? "ignore" : "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  try {
    if (input !== undefined && child.stdin !== undefined) {
      child.stdin.write(input);
      child.stdin.end();
    }
    const exitCode = await bounded(child.exited);
    return { exitCode, stdout: await bounded(stdout), stderr: await bounded(stderr) };
  } finally {
    if (child.exitCode === null) child.kill();
    await bounded(child.exited);
    if (process.env.ONI_CHILD_COVERAGE_DIR === undefined)
      rmSync(coverage, { recursive: true, force: true });
  }
}
