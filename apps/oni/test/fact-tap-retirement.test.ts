import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { processOutput } from "./helpers/process-output";

test("967 actual provider stream and app SQLite reply survive fact tap retirement", async () => {
  // Given: an isolated process, so other suites' global SDK mocks cannot replace the provider.
  const child = Bun.spawn(
    [process.execPath, fileURLToPath(new URL("./helpers/fact-tap-surface.ts", import.meta.url))],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  const timer = setTimeout(() => child.kill(), 10_000);
  try {
    // When: the runnable fixture drives the actual SDK and app/WebSocket/SQLite composition.
    const [exit, stdout, stderr] = await processOutput(child);
    console.log(stdout, stderr);
    // Then: every fixture assertion and owned-resource cleanup succeeded.
    expect(exit).toBe(0);
  } finally {
    clearTimeout(timer);
    child.kill();
    await child.exited;
  }
});
