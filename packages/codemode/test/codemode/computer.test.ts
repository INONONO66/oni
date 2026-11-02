import { beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { CaptureOutputs, type CaptureOutputStore } from "@oni/machines";
import type { Machine } from "@oni/protocol";
import { createMachineHost } from "../../../machines/test/helpers/native";
import { run } from "../../../machines/test/ipc/helpers/effects";
import { attachMclient, mclientBinary, mclientEnrollment } from "../../../machines/test/helpers/mclient";
import { eventCollector } from "../../../machines/test/helpers/events";
import { createCodemode } from "./helpers/native";

beforeAll(mclientBinary, 300_000);

function memoryCaptureOutputs(): CaptureOutputStore & { readonly stored: Map<string, Uint8Array> } {
  const stored = new Map<string, Uint8Array>();
  return {
    stored,
    put: (write) => { stored.set(write.outputId, write.bytes); },
    get: (outputId) => { const bytes = stored.get(outputId); return bytes === undefined ? undefined : { bytes }; },
  };
}

type Fixture = {
  readonly mode: ReturnType<typeof createCodemode>;
  readonly outputs: ReturnType<typeof memoryCaptureOutputs>;
  /** Every host op a cell issued, with the keys of each `codemode.screen` answer. */
  readonly seen: { name: string; keys?: string[] }[];
  readonly screen: () => Promise<Awaited<ReturnType<ReturnType<ReturnType<typeof createCodemode>["getMachine"]>["screen"]>>>;
};

async function fixture(body: (fixture: Fixture) => Promise<void>) {
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
  const outputs = memoryCaptureOutputs();
  const seen: Fixture["seen"] = [];
  mode = createCodemode({
    machines: host, self: "A", captureOutputs: () => outputs,
    boundary: () => async (call: Machine.ToolCall, next) => {
      const result = await next();
      seen.push({ name: call.name, ...(call.name === "codemode.screen" && result.status === "completed" ? { keys: Object.keys(result.value as object).sort() } : {}) });
      return result;
    },
  });
  const client = await attachMclient({
    host, events, machineId: "A", root, computer: { layout, recorder: join(root, "input.jsonl") },
  });
  try {
    await body({
      mode, outputs, seen,
      screen: () => run(mode.native.getMachine("A").screen({}).pipe(Effect.provideService(CaptureOutputs, outputs))),
    });
  } finally {
    await mode.close();
    await client.stop();
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test("SDK handles route screen and input to the attached client", async () => {
  await fixture(async ({ mode, outputs, screen }) => {
    const shot = await screen();
    if (shot.status !== "ok") throw new Error(`screen refused: ${shot.reason}`);
    expect(shot.capture).toMatchObject({ captureId: shot.captureId, display: 1, width: 32, height: 16, format: "png", bytes: shot.png.byteLength });
    expect(outputs.stored.get(`sha256:${shot.capture.sha256}`)).toEqual(new Uint8Array(shot.png));
    expect(await mode.getMachine("A").input({ captureId: "bogus", actions: [{ click: { x: 1, y: 1 } }] }))
      .toEqual({ status: "refused", reason: "stale_capture" });
  });
}, 20_000);

test("Python input without a prior capture raises a ToolError", async () => {
  await fixture(async ({ mode }) => {
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

test("Python cells read PNG bytes back while the recorded screen answer carries only the envelope", async () => {
  await fixture(async ({ mode, outputs, seen, screen }) => {
    const direct = await screen();
    if (direct.status !== "ok") throw new Error(`screen refused: ${direct.reason}`);
    const result = await mode.cell.run(
      [
        "shot = machine('A').screen()",
        "[shot['status'], shot['png'][:4] == b'\\x89PNG', shot['width'], shot['sha256'] == shot['sha256'].lower()]",
      ].join("\n"),
      "tenant",
    );
    expect(result).toMatchObject({ status: "completed", value: "['ok', True, 32, True]" });
    expect(seen.map((entry) => entry.name)).toEqual(["codemode.screen", "capture_data"]);
    expect(seen[0]?.keys).toEqual(["bytes", "captureId", "capturedAtUs", "display", "format", "height", "scale", "sha256", "status", "width"]);
    expect(outputs.stored.size).toBe(1);
    expect(outputs.stored.has(`sha256:${direct.capture.sha256}`)).toBe(true);
  });
}, 20_000);
