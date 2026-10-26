/**
 * Runs the shipped permission module (the exact bytes mclient installs) on
 * its own, without a built client: the Clients Rust CI job runs this file.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MODULE, permissionModule } from "./permission.js";

function check(condition: boolean, message: string): asserts condition {
  expect(condition, message).toBe(true);
}

async function script(path: string, text: string): Promise<void> {
  const writer = Bun.spawn(["/bin/sh", "-c", 'cat > "$1" && chmod 700 "$1"', "sh", path], {
    stdin: new Blob([text]),
    stderr: "pipe",
  });
  expect(await writer.exited, await new Response(writer.stderr).text()).toBe(0);
}

test("the installed permission module lets only an exit-0 verdict through", async () => {
  const embedded = readFileSync(join(import.meta.dir, "../../../clients/machine-client/src/agent/launcher.rs"), "utf8");
  expect(embedded).toContain('include_str!("permission.ts")');
  expect(MODULE.endsWith("clients/machine-client/src/agent/permission.ts")).toBe(true);
  const scratch = mkdtempSync(join(tmpdir(), "oni-permission-"));
  const recorded: string[] = [];
  try {
    await permissionModule({ check, record: (line) => recorded.push(line), script }, scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  expect(recorded).toHaveLength(1);
  expect(recorded[0]).toContain("timeout");
});
