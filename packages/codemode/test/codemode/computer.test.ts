import { beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMachineHost } from "../../../machines/test/helpers/native";
import { attachMclient, mclientBinary, mclientEnrollment } from "../../../machines/test/helpers/mclient";
import { eventCollector } from "../../../machines/test/helpers/events";
import { createCodemode } from "./helpers/native";

beforeAll(mclientBinary, 300_000);

async function fixture(run: (mode: ReturnType<typeof createCodemode>) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "oc-computer-"));
  const layout = join(root, "layout.json");
  writeFileSync(layout, JSON.stringify({
    displays: [{ id: 1, x: 0, y: 0, width: 32, height: 16, scale: 1, primary: true }],
  }));
  const events = eventCollector();
  let mode: ReturnType<typeof createCodemode>;
  const host = await createMachineHost({
    listen: { unix: join(root, "host.sock") },
    enrollment: (id) => mclientEnrollment(id),
    events: events.sink,
    now: () => Date.now(),
    callTool: (call) => mode.callTool(call),
  });
  mode = createCodemode({ machines: host, self: "A" });
  const client = await attachMclient({
    host, events, machineId: "A", root, computer: { layout, recorder: join(root, "input.jsonl") },
  });
  try {
    await run(mode);
  } finally {
    await mode.close();
    await client.stop();
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test("SDK handles route screen and input to the attached client", async () => {
  await fixture(async (mode) => {
    const machine = mode.getMachine("A");
    const shot = await machine.screen({});
    expect(shot.status).toBe("ok");
    expect(await machine.input({ captureId: "bogus", actions: [{ click: { x: 1, y: 1 } }] }))
      .toEqual({ status: "refused", reason: "stale_capture" });
  });
}, 20_000);

test("Python input without a prior capture raises a ToolError", async () => {
  await fixture(async (mode) => {
    const result = await mode.cell.run(
      [
        "try:",
        "    machine('A').input([{'click': {'x': 1, 'y': 1}}])",
        "    message = 'no error'",
        "except ToolError as error:",
        "    message = str(error)",
        "message",
      ].join("\n"),
      "tenant",
    );
    expect(result).toMatchObject({
      status: "completed",
      value: "'input requires a prior screen() capture or an explicit capture_id'",
    });
  });
}, 20_000);

test("Python cells route screen reads through the attached client", async () => {
  await fixture(async (mode) => {
    const direct = await mode.getMachine("A").screen({});
    const result = await mode.cell.run("machine('A').screen()['status']", "tenant");
    expect(result).toMatchObject({
      status: "completed",
      value: JSON.stringify(direct.status).replaceAll('"', "'"),
    });
  });
}, 20_000);
