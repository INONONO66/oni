import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachMachineDaemon, createMachineHost } from "../../../machines/test/helpers/native";
import { fakeMac } from "../../../machines/test/helpers/fake-commands";
import { createCodemode } from "./helpers/native";

const silent = { publish() { return; } };
const capabilities = ["kernel.py", "screen.read", "input.write"];

/** One machine whose computer-use shell surface is the recorded fake (#1274). */
async function fixture(
  run: (context: {
    mode: ReturnType<typeof createCodemode>;
    fake: ReturnType<typeof fakeMac>;
  }) => Promise<void>,
) {
  const socketPath = join(tmpdir(), `oc-computer-${crypto.randomUUID()}.sock`);
  const fake = fakeMac();
  let mode: ReturnType<typeof createCodemode>;
  const host = await createMachineHost({
    listen: { unix: socketPath },
    enrollment: (id) => ({
      machineId: id,
      name: id,
      tags: [id],
      allowedCapabilities: capabilities,
      publicKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      enrolledAt: 1,
    }),
    events: silent,
    now: () => 2,
    callTool: (call) => mode.callTool(call),
  });
  mode = createCodemode({ machines: host, self: "A" });
  const daemon = await attachMachineDaemon({
    socketPath,
    offer: {
      machineId: "A",
      daemonVersion: "test",
      platform: `${process.platform}-${process.arch}`,
      offeredAt: 2,
      offeredCapabilities: capabilities,
    },
    commands: fake.runner,
    runner: createCodemode().runner,
  });
  try {
    await run({ mode, fake });
  } finally {
    await mode.close();
    await daemon.close();
    host.close();
  }
}

test("SDK handles expose screen and input through the machine handle", async () => {
  await fixture(async ({ mode, fake }) => {
    const machine = mode.getMachine("A");
    const shot = await machine.screen({});
    if (shot.status !== "ok") throw new Error(`screen refused: ${shot.reason}`);
    expect(Buffer.from(shot.png).equals(fake.behavior.capturePng)).toBe(true);
    expect(await machine.input({ captureId: "bogus", actions: [{ click: { x: 1, y: 1 } }] }))
      .toEqual({ status: "refused", reason: "stale_capture" });
    expect(await machine.input({ captureId: shot.captureId, actions: [{ click: { x: 1, y: 1 } }] }))
      .toEqual({ status: "ok" });
  });
}, 15000);

test("Python cells drive m.screen() and m.input() with an implicit capture anchor", async () => {
  await fixture(async ({ mode, fake }) => {
    const result = await mode.cell.run(
      [
        "m = machine('A')",
        "shot = m.screen()",
        "ok = shot['status'] == 'ok' and shot['png'][:4] == b'\\x89PNG'",
        "pressed = m.input([{'click': {'x': 10, 'y': 20}}, {'type': {'text': 'nonce-7'}}])",
        "(ok, pressed['status'])",
      ].join("\n"),
      "tenant",
    );
    expect(result).toMatchObject({ status: "completed", value: "(True, 'ok')" });
    expect(fake.invocations("cliclick").at(-1)?.slice(1)).toEqual(["c:10,20", "t:nonce-7"]);
  });
}, 20000);

test("Python input without a prior capture raises a ToolError", async () => {
  await fixture(async ({ mode, fake }) => {
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
    expect(fake.invocations("cliclick")).toHaveLength(0);
  });
}, 20000);
