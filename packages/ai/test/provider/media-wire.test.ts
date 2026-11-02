import { expect, test } from "bun:test";

test("real SDK conversion and candidate fallback preserve media contracts", async () => {
  // Other suites replace the ai module; a child keeps this wire test on the real SDK.
  const child = Bun.spawn([process.execPath, "test", new URL("../fixtures/media-wire.ts", import.meta.url).pathname, "--timeout", "15000"], {
    stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  expect({ code, output: stdout + stderr }).toMatchObject({ code: 0 });
});
