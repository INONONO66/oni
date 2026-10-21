import { describe, expect, test } from "bun:test";
import { Exit } from "effect";
import { systemCommandRunner } from "../src/commands";
import { exit as runExit } from "./helpers/effect";
import { run } from "./ipc/helpers/effects";

describe("systemCommandRunner", () => {
  test("reports the exit code and both output streams", async () => {
    const result = await run(
      systemCommandRunner().run(["/bin/sh", "-c", "printf out; printf err 1>&2; exit 3"]),
    );
    expect(result).toEqual({ exitCode: 3, stdout: "out", stderr: "err" });
  });

  test("a missing binary fails with SpawnFailure", async () => {
    const outcome = await runExit(systemCommandRunner().run(["/nonexistent/oni-binary"]));
    expect(Exit.isFailure(outcome)).toBe(true);
    expect(JSON.stringify(outcome)).toContain("SpawnFailure");
  });
});
