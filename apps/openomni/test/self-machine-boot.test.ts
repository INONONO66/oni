import { composedHolder } from "./helpers/bundle-fixture";
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect } from "effect";
import * as Machines from "@openomni/machines";
import { Machine } from "@openomni/protocol";
import { startOpenOmni } from "../src/index";
import * as Gateway from "../src/gateway";
import { SelfAttachError } from "../src/composition/self-machine";
import type { OpenOmniConfig } from "../src/config";
import { acquireEffect, runEffect } from "./helpers/effect";
import { socketPath } from "./helpers/socket-path";
import { testIds } from "./helpers/test-entropy";
import { attachConfiguredMachine } from "../src/cli/machine";
import { testSelfMachine } from "./helpers/self-machine";
import { testBus } from "../../../packages/agent/test/helpers/isolated";

function fixtureConfig(machines: OpenOmniConfig["machines"]): OpenOmniConfig {
  return {
    host: "127.0.0.1",
    wsPort: 0,
    kek: { kind: "locked", reason: "no vault key in this fixture" },
    model: { provider: "fake", id: "fixture", apiKey: "fixture" },
    ...(machines === undefined ? {} : { machines }),
  };
}

const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

function track<S extends { mockRestore(): void }>(spy: S): S {
  spies.push(spy);
  return spy;
}

test("a config without a machines block refuses boot with machines_required and opens no listener (#1271 r1 M4)", async () => {
  const createHost = Machines.createMachineHost;
  const hostSpy = track(
    spyOn(Machines, "createMachineHost").mockImplementation((options) => createHost(options)),
  );
  const failed = startOpenOmni({ config: fixtureConfig(undefined) });
  await expect(failed).rejects.toThrow(
    expect.objectContaining({
      name: "OpenOmniConfigurationError",
      data: expect.objectContaining({ code: "machines_required" }),
    }),
  );
  expect(hostSpy.mock.calls.length).toBe(0);
});

test("boot reaches the attached self state before any tool port exists", async () => {
  const seen: string[][] = [];
  const original = Gateway.toolPorts;
  track(
    spyOn(Gateway, "toolPorts").mockImplementation((runtime, ports) => {
      seen.push(ports.machines === undefined ? [] : ports.machines.host.list().map((m) => m.machineId));
      return original(runtime, ports);
    }),
  );
  const app = await startOpenOmni({
    config: fixtureConfig({ self: testSelfMachine(), listen: { unix: socketPath() }, enrolled: [] }),
  });
  try {
    expect(seen).toEqual([["self"]]);
  } finally {
    await app.stop();
  }
});

test("a listener that cannot bind fails boot with self_attach_failed", async () => {
  const failed = startOpenOmni({
    config: fixtureConfig({
      self: testSelfMachine(),
      listen: { unix: join(tmpdir(), "om-self-missing-dir", "nested", "machines.sock") },
      enrolled: [],
    }),
  });
  await expect(failed).rejects.toBeInstanceOf(SelfAttachError);
  await expect(failed).rejects.toMatchObject({
    data: { code: "self_attach_failed" },
  });
  await failed.catch((error: SelfAttachError) => {
    expect(error.data.cause).toContain("host listener failed");
  });
});

test("a refused self attachment fails boot closed instead of selecting a local path", async () => {
  track(
    spyOn(Machines, "attachMachineDaemon").mockImplementation(() =>
      Effect.succeed({
        attachment: { status: "refused", reason: "machine_not_enrolled" } as const,
        closed: Effect.void,
        close: () => Effect.void,
      }),
    ),
  );
  const failed = startOpenOmni({
    config: fixtureConfig({ self: testSelfMachine(), listen: { unix: socketPath() }, enrolled: [] }),
  });
  await expect(failed).rejects.toMatchObject({
    data: { code: "self_attach_failed", cause: "machine.attach refused: machine_not_enrolled" },
  });
});

test("missing self exports in an injected config fail boot with self_attach_failed", async () => {
  const failed = startOpenOmni({
    config: fixtureConfig({
      self: { capabilities: ["fs.read"], exports: [] },
      listen: { unix: socketPath() },
      enrolled: [],
    }),
  });
  await expect(failed).rejects.toBeInstanceOf(SelfAttachError);
  await failed.catch((error: SelfAttachError) => {
    expect(error.data.cause).toContain("machine configuration invalid");
  });
});

test("a self daemon that dies during boot fails closed before tool ports publish", async () => {
  const real = Machines.attachMachineDaemon;
  // Silence the lifecycle report; the after-boot test asserts its shape.
  track(spyOn(console, "error").mockImplementation(() => undefined));
  track(
    spyOn(Machines, "attachMachineDaemon").mockImplementation((options) =>
      real(options).pipe(Effect.tap((daemon) => daemon.close())),
    ),
  );
  const failed = startOpenOmni({
    config: fixtureConfig({ self: testSelfMachine(), listen: { unix: socketPath() }, enrolled: [] }),
  });
  await expect(failed).rejects.toBeInstanceOf(SelfAttachError);
  await failed.catch((error: SelfAttachError) => {
    expect(error.data.cause).toContain("self machine disconnected during boot");
  });
});

test("a capability-poor self still boots: a typed refusal proves liveness", async () => {
  const app = await startOpenOmni({
    config: fixtureConfig({
      self: { capabilities: ["shell.exec"], exports: testSelfMachine().exports },
      listen: { unix: socketPath() },
      enrolled: [],
    }),
  });
  await app.stop();
});

test("a self daemon closing after boot detaches the handle and surfaces the typed refusal", async () => {
  const bus = testBus();
  // The typed lifecycle surface (r1 M1): the host's Detached event is the
  // observable contract for a post-boot self daemon close.
  const detached = new Promise<{ machineId: string }>((resolve, reject) => {
    bus.observe((observation) => {
      if (observation.name === Machine.Events.Detached.name)
        resolve(observation.data as { machineId: string });
    });
    AbortSignal.timeout(15_000).addEventListener("abort", () =>
      reject(new Error("timed out waiting for detach")),
    );
  });
  const real = Machines.attachMachineDaemon;
  let daemon: Machines.MachineDaemon | undefined;
  track(
    spyOn(Machines, "attachMachineDaemon").mockImplementation((options) =>
      real(options).pipe(Effect.tap((attached) => Effect.sync(() => { daemon = attached; }))),
    ),
  );
  const createHost = Machines.createMachineHost;
  let host: Machines.MachineHost | undefined;
  track(
    spyOn(Machines, "createMachineHost").mockImplementation((options) =>
      createHost(options).pipe(Effect.tap((created) => Effect.sync(() => { host = created; }))),
    ),
  );
  const root = testSelfMachine();
  const app = await startOpenOmni({
    runtime: Gateway.gatewayRuntime({ composed: composedHolder(), observations: bus }),
    config: fixtureConfig({ self: root, listen: { unix: socketPath() }, enrolled: [] }),
  });
  try {
    if (daemon === undefined || host === undefined) throw new Error("self plane was not captured");
    await runEffect(daemon.close());
    expect((await detached).machineId).toBe("self");
    const exportPath = root.exports[0]?.path ?? "/";
    const refusal = await runEffect(Effect.flip(host.get("self").fs.stat(exportPath)));
    expect(refusal).toMatchObject({ _tag: "MachineRefusalError", reason: "disconnected" });
  } finally {
    await app.stop();
    bus.close();
  }
});

test("a second offer for machineId self on the real socket is refused already_attached (#1271 r1 M3)", async () => {
  const createHost = Machines.createMachineHost;
  let host: Machines.MachineHost | undefined;
  track(
    spyOn(Machines, "createMachineHost").mockImplementation((options) =>
      createHost(options).pipe(Effect.tap((created) => Effect.sync(() => { host = created; }))),
    ),
  );
  const socket = socketPath();
  const root = testSelfMachine();
  const app = await startOpenOmni({
    config: fixtureConfig({ self: root, listen: { unix: socket }, enrolled: [] }),
  });
  try {
    const impostor = await acquireEffect(
      Machines.attachMachineDaemon({
        socketPath: socket,
        id: testIds("impostor"),
        dispatcherBound: 8,
        offer: {
          machineId: "self",
          daemonVersion: "impostor",
          platform: `${process.platform}-${process.arch}`,
          offeredAt: 2,
          offeredCapabilities: ["fs.read", "fs.write", "shell.exec"],
          exports: root.exports.map((entry) => ({ name: entry.name, path: entry.path })),
        },
      }),
    );
    expect(impostor.attachment).toEqual({ status: "refused", reason: "already_attached" });
    // The incumbent in-process self daemon still serves the plane.
    if (host === undefined) throw new Error("host was not captured");
    const exportPath = root.exports[0]?.path ?? "/";
    const stat = await runEffect(host.get("self").fs.stat(exportPath));
    expect(stat).toMatchObject({ op: "stat", kind: "dir" });
  } finally {
    await app.stop();
  }
});

test("openomni machine attach: a second daemon attaches alongside self and negotiates capabilities", async () => {
  const createHost = Machines.createMachineHost;
  let host: Machines.MachineHost | undefined;
  track(
    spyOn(Machines, "createMachineHost").mockImplementation((options) =>
      createHost(options).pipe(Effect.tap((created) => Effect.sync(() => { host = created; }))),
    ),
  );
  const socket = socketPath();
  const remoteRoot = realpathSync(mkdtempSync(join(tmpdir(), "om-remote-")));
  const self = testSelfMachine();
  const app = await startOpenOmni({
    config: fixtureConfig({
      self,
      listen: { unix: socket },
      enrolled: [
        {
          machineId: "node-1",
          name: "second",
          allowedCapabilities: ["fs.read"],
          allowedExports: ["data"],
          publicKey: "ab".repeat(32),
          enrolledAt: 1,
        },
      ],
    }),
  });
  const configPath = join(mkdtempSync(join(tmpdir(), "om-attach-")), "machine.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      socketPath: socket,
      offer: {
        machineId: "node-1",
        daemonVersion: "test",
        platform: `${process.platform}-${process.arch}`,
        offeredAt: 1,
        // shell.exec is offered but not enrolled: negotiation must intersect it away.
        offeredCapabilities: ["fs.read", "shell.exec"],
        exports: [{ name: "data", path: remoteRoot }],
      },
    }),
  );
  const daemon = await acquireEffect(attachConfiguredMachine(configPath, testIds("remote-cli")));
  try {
    expect(daemon.attachment).toMatchObject({
      status: "attached",
      effectiveCapabilities: ["fs.read"],
      effectiveExports: ["data"],
    });
    if (host === undefined) throw new Error("host was not captured");
    expect(host.list().map((machine) => machine.machineId).sort()).toEqual(["node-1", "self"]);
    // Both attachments serve requests side by side.
    expect((await runEffect(host.get("node-1").fs.stat(remoteRoot))).kind).toBe("dir");
    const exportPath = self.exports[0]?.path ?? "/";
    expect((await runEffect(host.get("self").fs.stat(exportPath))).kind).toBe("dir");
  } finally {
    await runEffect(daemon.close());
    await app.stop();
  }
});
