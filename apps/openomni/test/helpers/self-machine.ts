import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenOmniConfig } from "../../src/config";
import { socketPath } from "./socket-path";

/**
 * Default export roots created by this helper; removed when the owning process
 * exits (r1 L4). An exit hook — not bun:test afterAll — because this module is
 * also imported by plain child-process fixtures outside any test runner.
 */
const createdRoots: string[] = [];
process.on("exit", () => {
  for (const root of createdRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function defaultRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "om-self-"));
  createdRoots.push(root);
  return root;
}

/**
 * A minimal valid self machine for boot fixtures (#1271): one canonical
 * tmp-dir export and the full filesystem/shell capability set.
 */
export function testSelfMachine(
  root: string = defaultRoot(),
): NonNullable<OpenOmniConfig["machines"]>["self"] {
  return {
    capabilities: ["fs.read", "fs.write", "shell.exec"],
    exports: [{ name: "workspace", path: realpathSync(root) }],
  };
}

export function testKernelSelfMachine(
  root?: string,
): NonNullable<OpenOmniConfig["machines"]>["self"] {
  const self = testSelfMachine(root);
  return { ...self, capabilities: [...self.capabilities, "kernel.py"] };
}

/** A full boot-ready machine plane (#1271): self on a fresh unix socket, nothing enrolled. */
export function testMachinesPlane(): NonNullable<OpenOmniConfig["machines"]> {
  return { self: testSelfMachine(), listen: { unix: socketPath() }, enrolled: [] };
}
