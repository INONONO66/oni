import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { processOutput } from "./helpers/process-output";

test("967-U1 teardown rejection fails the real assertion-failure cleanup test", async () => {
  // Given the real app fixture with a rejection injected only AFTER real cleanup resolves.
  const child = Bun.spawn(
    [
      process.execPath,
      "test",
      "--timeout",
      "15000",
      "--preload",
      fileURLToPath(new URL("./helpers/cleanup-rejection.preload.ts", import.meta.url)),
      fileURLToPath(new URL("./e2e.test.ts", import.meta.url)),
      "-t",
      "967-U1 closes owned sockets",
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, 25_000);
  try {
    // When the deliberate test failure and the different teardown failure both occur.
    const [exit, stdout, stderr] = await processOutput(child);
    console.log(stdout, stderr);
    // Then real cleanup happened, and the test runner rejects the cleanup error.
    expect(timedOut).toBe(false);
    expect(stdout).toContain("U1_REAL_CLEANUP_RESOLVED");
    expect(exit).toBe(1);
    expect(stderr).toContain("U1_TEARDOWN_REJECTION");
  } finally {
    clearTimeout(timer);
    child.kill();
    await child.exited;
  }
}, 30_000);
