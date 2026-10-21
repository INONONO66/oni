import { expect, test } from "bun:test";
import { createComputerUse } from "../src/computer-use";
import { systemCommandRunner } from "../src/commands";
import { PNG_MAGIC } from "./helpers/fake-commands";
import { run } from "./ipc/helpers/effects";

/**
 * Opt-in real-surface check (#1274): exercises the actual screencapture/sips
 * pipeline, so it needs Screen Recording permission for the test terminal.
 * Enable with ONI_REAL_SCREEN=1; CI never sets it.
 */
const enabled = process.env.ONI_REAL_SCREEN === "1";

test.skipIf(!enabled)("captures the real screen within the byte cap", async () => {
  let n = 0;
  const computer = createComputerUse({ runner: systemCommandRunner(), id: () => `real-${++n}` });
  const offered = await run(computer.offeredCapabilities(["screen.read"]));
  expect(offered).toContain("screen.read");
  const result = await run(computer.screenRead({}));
  if (result.status !== "ok") throw new Error(`screen refused: ${result.reason}`);
  const bytes = Buffer.from(result.png, "base64");
  expect(bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)).toBe(true);
  expect(bytes.length).toBeGreaterThan(1024);
});
