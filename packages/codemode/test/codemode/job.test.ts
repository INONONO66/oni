import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMachineHost } from "../../../machines/test/helpers/native";
import { attachMclient, mclientBinary, mclientEnrollment } from "../../../machines/test/helpers/mclient";
import { eventCollector } from "../../../machines/test/helpers/events";
import { createCodemode } from "./helpers/native";

const root = mkdtempSync(join(tmpdir(), "oc-job-"));
beforeAll(mclientBinary, 300_000);
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

test("a named job survives its Python handle and is read through a new handle", async () => {
  const socket = join(tmpdir(), `oc-job-${crypto.randomUUID()}.sock`);
  const events = eventCollector();
  let mode: ReturnType<typeof createCodemode>;
  const host = await createMachineHost({
    listen: { unix: socket },
    enrollment: (machineId) => mclientEnrollment(machineId),
    events: events.sink, now: () => Date.now(),
    callTool: (call) => mode.callTool(call),
  });
  mode = createCodemode({ machines: host, self: "worker" });
  const daemon = await attachMclient({ host, events, machineId: "worker", root });
  try {
    const started = await mode.cell.run(
      `m = machine('worker')\njob = m.job("printf 'finished-job\\\\n'; exit 7", ${JSON.stringify(root)})\nname = job['name']\ndel m\njob`,
      "owner",
    );
    expect(started.status).toBe("completed");
    expect(started.status === "completed" ? started.value : "").toContain("'machineId': 'worker'");
    const finished = await mode.cell.run(
      [
        "m = machine('worker')",
        "result = m.job_wait(name, 10)",
        "view = m.job_read(name)",
        "assert result['status'] == 'completed' and result['exitCode'] == 7",
        "assert b'finished-job' in view['data']",
        "assert result['name'] == view['name'] == name",
        "m.pty(name).close()",
        "assert m.job_read(name)['status'] == 'lost'",
        "assert m.job_wait(name, 0)['status'] == 'lost'",
        `waiting = m.job("printf '__job_done_decoy:0__\\\\n'; read gate; printf 'done\\\\n'", ${JSON.stringify(root)})`,
        "timeout = m.job_wait(waiting['name'], 0)",
        "assert timeout['status'] == 'timed_out' and 'data' not in timeout",
        "m.pty(waiting['name']).write('go\\r')",
        "done = m.job_wait(waiting['name'], 10)",
        "assert done['status'] == 'completed' and done['exitCode'] == 0",
        "assert b'__job_done_decoy:0__' in m.job_read(waiting['name'])['data']",
        "m.pty(waiting['name']).close()",
        "result['machineId']",
      ].join("\n"),
      "owner",
    );
    expect(finished).toMatchObject({ status: "completed", value: "'worker'" });
  } finally {
    await mode.close();
    await daemon.stop();
    await host.close();
  }
}, 30_000);
