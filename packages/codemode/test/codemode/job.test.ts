import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Machine } from "@openomni/protocol";
import { attachMachineDaemon, createMachineHost } from "../../../machines/test/helpers/native";
import { createCodemode } from "./helpers/native";

const root = mkdtempSync(join(tmpdir(), "oc-job-"));
const tmuxSocket = `openomni-job-test-${process.pid}`;
const capabilities = [Machine.WellKnownCapability.pythonKernel, Machine.WellKnownCapability.ptySession];
afterAll(() => {
  Bun.spawnSync(["tmux", "-L", tmuxSocket, "kill-server"]);
  rmSync(root, { recursive: true, force: true });
});

test("a named job survives its Python handle and is read through a new handle", async () => {
  const socket = join(tmpdir(), `oc-job-${crypto.randomUUID()}.sock`);
  let mode: ReturnType<typeof createCodemode>;
  const host = await createMachineHost({
    listen: { unix: socket },
    enrollment: (machineId) => ({
      machineId, name: machineId, allowedCapabilities: capabilities, allowedExports: ["work"],
      publicKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", enrolledAt: 1,
    }),
    events: { publish: () => undefined }, now: () => 2,
    callTool: (call) => mode.callTool(call),
  });
  mode = createCodemode({ machines: host });
  const kernel = createCodemode();
  const daemon = await attachMachineDaemon({
    socketPath: socket,
    offer: {
      machineId: "worker", platform: `${process.platform}-${process.arch}`, daemonVersion: "test",
      offeredCapabilities: capabilities, offeredAt: 2, exports: [{ name: "work", path: root }],
    },
    fsExports: new Map([["work", root]]), runner: kernel.runner, pty: { socketName: tmuxSocket },
  });
  try {
    const started = await mode.cell.run(
      `m = codemode.getMachine('worker')\njob = m.job("printf 'finished-job\\\\n'; exit 7", ${JSON.stringify(root)})\nname = job['name']\ndel m\njob`,
      "owner",
    );
    expect(started.status).toBe("completed");
    expect(started.status === "completed" ? started.value : "").toContain("'machineId': 'worker'");
    const finished = await mode.cell.run(
      [
        "m = codemode.getMachine('worker')",
        "result = m.job_wait(name, 10)",
        "view = m.job_read(name)",
        "assert result['status'] == 'completed' and result['exitCode'] == 7",
        "assert b'finished-job' in result['data'] and b'finished-job' in view['data']",
        "assert result['name'] == view['name'] == name",
        "m.pty(name).close()",
        "result['machineId']",
      ].join("\n"),
      "owner",
    );
    expect(finished).toMatchObject({ status: "completed", value: "'worker'" });
  } finally {
    await mode.close();
    await daemon.close();
    host.close();
  }
}, 30_000);
