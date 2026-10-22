import { expect, test } from "bun:test";
import { Machine } from "@oni/protocol";
import { attachMachineDaemon, createMachineHost } from "./helpers/native";
import { scriptedTmux } from "./helpers/scripted-tmux";
import { socketPath } from "./helpers/socket-path";

/**
 * #1603 r1: the daemon resolves the screen-snapshot clock AFTER spreading
 * `options.pty`, so an explicit `pty: { now: undefined }` falls back to the
 * heartbeat clock (`report.now`) instead of silently dropping it, while an
 * explicit `pty.now` still wins. Scripted tmux: no binary, no sockets.
 */
const enrollment = (machineId: string): Machine.Enrollment => ({
  machineId,
  name: machineId,
  allowedCapabilities: [Machine.WellKnownCapability.ptySession],
  allowedExports: ["root"],
  publicKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  enrolledAt: 1,
});
/** `pty.open` confines `cwd` to an fs export (the exec rule), so each daemon exports `/` as `root`. */
const fsExports = new Map([["root", "/"]]);
const offer = (machineId: string): Omit<Machine.Offer, "peer" | "generation"> => ({
  machineId,
  daemonVersion: "test",
  platform: "linux-x64",
  offeredCapabilities: [Machine.WellKnownCapability.ptySession],
  exports: [{ name: "root", path: "/" }],
  offeredAt: 2,
});
const silent = { publish: () => undefined };
const idleScheduler = { schedule: () => () => undefined };
const probe = { resources: () => ({ cpus: 1, memoryBytes: 1024 }), load: () => ({ loadAvg1: 0, memoryAvailableBytes: 512 }) };

test("an explicit undefined pty.now falls back to the heartbeat clock, and an explicit pty.now wins over it", async () => {
  const unix = socketPath();
  const host = await createMachineHost({ listen: { unix }, enrollment, events: silent, now: () => 3 });
  const fallback = scriptedTmux(["3 1 0 4242 node"]);
  const explicit = scriptedTmux(["0 0 0 7 zsh"]);
  const viaReport = await attachMachineDaemon({
    socketPath: unix,
    offer: offer("via-report"),
    commands: fallback.runner,
    fsExports,
    report: { scheduler: idleScheduler, now: () => 1_700_000_000_123, probe },
    pty: { control: fallback.control, now: undefined },
  });
  const viaPty = await attachMachineDaemon({
    socketPath: unix,
    offer: offer("via-pty"),
    commands: explicit.runner,
    fsExports,
    report: { scheduler: idleScheduler, now: () => 1, probe },
    pty: { control: explicit.control, now: () => 2 },
  });
  try {
    expect(viaReport.attachment).toMatchObject({ status: "attached", effectiveCapabilities: ["pty.session"] });
    expect(viaPty.attachment).toMatchObject({ status: "attached", effectiveCapabilities: ["pty.session"] });

    const reportClocked = host.get("via-report").pty;
    expect(await reportClocked.open("qa", "/")).toMatchObject({ status: "ok" });
    expect(await reportClocked.screen("qa")).toEqual({
      status: "ok",
      rows: ["snapshot"],
      cursor: { x: 3, y: 1 },
      occupant: { pid: 4242, command: "node" },
      observedAt: 1_700_000_000_123,
    });
    // The two-command host budget (#1603 r1) carries resize over the same wire.
    expect(await reportClocked.resize("qa", 100, 30)).toEqual({ status: "ok" });
    expect(fallback.lines.slice(-2)).toEqual(["set-option -w -t =qa: window-size manual", "resize-window -t =qa: -x 100 -y 30"]);

    const ptyClocked = host.get("via-pty").pty;
    expect(await ptyClocked.open("qa", "/")).toMatchObject({ status: "ok" });
    expect(await ptyClocked.screen("qa")).toEqual({
      status: "ok",
      rows: ["snapshot"],
      cursor: { x: 0, y: 0 },
      occupant: { pid: 7, command: "zsh" },
      observedAt: 2,
    });
  } finally {
    await viaReport.close();
    await viaPty.close();
    await host.close();
  }
});
