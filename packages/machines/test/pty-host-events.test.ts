import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Machine } from "@openomni/protocol";
import { attachMachineDaemon, createMachineHost } from "./helpers/native";
import { eventCollector } from "./helpers/events";

const socketName = `openomni-pty-fact-${process.pid}`;
afterAll(() => {
  Bun.spawnSync(["tmux", "-L", socketName, "kill-server"]);
});

test("a host terminal read publishes byte count and cursor without output bytes", async () => {
  const root = mkdtempSync(join(tmpdir(), "om-pty-fact-"));
  const events = eventCollector();
  const socket = join(tmpdir(), `om-pty-fact-${crypto.randomUUID()}.sock`);
  const host = await createMachineHost({
    listen: { unix: socket },
    enrollment: (machineId) => ({
      machineId, name: machineId, allowedCapabilities: [Machine.WellKnownCapability.ptySession],
      allowedExports: ["work"], publicKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      enrolledAt: 1,
    }),
    events: events.sink, now: () => 42,
  });
  const daemon = await attachMachineDaemon({
    socketPath: socket,
    offer: {
      machineId: "worker", platform: `${process.platform}-${process.arch}`, daemonVersion: "test",
      offeredCapabilities: [Machine.WellKnownCapability.ptySession], offeredAt: 2,
      exports: [{ name: "work", path: root }],
    },
    fsExports: new Map([["work", root]]), pty: { socketName },
  });
  try {
    const terminal = host.get("worker").pty;
    const opened = await terminal.open("output-fact", root);
    expect(opened.status).toBe("ok");
    if (opened.status !== "ok") throw new Error(opened.reason);
    expect(await terminal.write("output-fact", Buffer.from("printf 'wire-fact\\n'\r"))).toEqual({ status: "ok" });
    const fact = events.next(Machine.Events.PtyOutput.name);
    const view = await terminal.read("output-fact", { cursor: opened.cursor, waitMs: 10_000 });
    expect(view.status).toBe("ok");
    if (view.status !== "ok") throw new Error(view.reason);
    expect(view.data.length).toBeGreaterThan(0);
    expect((await fact).payload).toEqual({
      machineId: "worker", time: 42, name: "output-fact", bytes: view.data.length, cursor: view.cursor,
    });
    await terminal.close("output-fact");
  } finally {
    await daemon.close();
    host.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
