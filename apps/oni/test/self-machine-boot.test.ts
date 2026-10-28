import { validateMachinePlane, type OniConfig } from "../src/config";
import { afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Effect, Exit, Scope } from "effect";
import * as Machines from "@oni/machines";
import { Machine } from "@oni/protocol";
import { startOni } from "../src/index";
import * as Gateway from "../src/gateway";
import { attachSelfMachine, SelfAttachError, selfEnrollment } from "../src/composition/self-machine";
import * as SelfMachineComposition from "../src/composition/self-machine";
import { writeMclientSettings } from "../src/composition/mclient";
import { acquireEffect, closeAcquiredEffects, runEffect } from "./helpers/effect";
import { socketPath } from "./helpers/socket-path";
import { testIds } from "./helpers/test-entropy";
import { testSelfMachine } from "./helpers/self-machine";
import { testBus } from "../../../packages/agent/test/helpers/isolated";
import { refusingToolPort } from "./helpers/tool-port";
import { mclientBinary, spawnAttachedMclient } from "./helpers/mclient";
import { connectIpcClient } from "../../../packages/machines/test/ipc/helpers/native";

const roots: string[] = [];
const spies: Array<{ mockRestore(): void }> = [];
beforeAll(mclientBinary, 180_000);
afterEach(async () => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  await closeAcquiredEffects();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function directory() {
  const root = realpathSync(mkdtempSync("/tmp/oni-self-"));
  roots.push(root);
  return root;
}

function fixtureConfig(machines: OniConfig["machines"]): OniConfig {
  const root = directory();
  return {
    catalogPath: join(root, "catalog.sqlite"), sessionsDir: join(root, "sessions"),
    machines, machineGenerationsPath: join(root, "generations.json"),
    host: "127.0.0.1", wsPort: 0,
    kek: { kind: "locked", reason: "no vault key in this fixture" },
    model: { provider: "fake", id: "resident-test", apiKey: "test-key" },
  };
}

const selfSettings = (root: string, id: string) =>
  join(root, "self", createHash("sha256").update(id).digest("hex"), "client.json");

async function selfFixture(enrolled = true, machineId = "self", root = directory()) {
  const events = testBus();
  const scope = await runEffect(Scope.make());
  const plane = validateMachinePlane({
    self: { ...testSelfMachine(root), id: machineId }, listen: { unix: socketPath() }, enrolled: [],
  });
  const host = await acquireEffect(Machines.createMachineHost({
    listen: { unix: socketPath() }, id: testIds("self-host"), now: () => 1,
    dispatcherBound: 32, generations: Machines.createMemoryGenerationStore(),
    enrollment: () => enrolled ? selfEnrollment(plane, 1) : undefined,
    events, callTool: refusingToolPort, neverSupersede: [plane.self.id],
  }));
  const closed = Promise.withResolvers<SelfAttachError>();
  const options = {
    host, plane, events, stateDir: root, binary: await mclientBinary(),
    socketPath: host.endpoints.unix ?? "", attachTimeoutMs: 5000,
    onClose: closed.resolve,
  };
  return {
    root, host, plane, options, closed,
    attach: (overrides: Partial<typeof options> = {}) =>
      runEffect(Scope.provide(attachSelfMachine({ ...options, ...overrides }), scope)),
    async close() { await runEffect(Scope.close(scope, Exit.void)); events.close(); },
  };
}

test("a config without machines refuses before opening a listener", async () => {
  const createHost = Machines.createMachineHost;
  const hostSpy = spyOn(Machines, "createMachineHost").mockImplementation(createHost);
  spies.push(hostSpy);
  await expect(startOni({ config: fixtureConfig(undefined) })).rejects.toMatchObject({
    name: "OniConfigurationError", data: { code: "machines_required" },
  });
  expect(hostSpy).not.toHaveBeenCalled();
});

test("boot admits the Rust self peer before publishing tool ports", async () => {
  const seen: Machines.MachineInfo[][] = [];
  const original = Gateway.toolPorts;
  spies.push(spyOn(Gateway, "toolPorts").mockImplementation((runtime, ports) => {
    seen.push(ports.machines?.host.list() ?? []);
    return original(runtime, ports);
  }));
  const app = await startOni({
    config: fixtureConfig({ self: testSelfMachine(), listen: { unix: socketPath() }, enrolled: [] }),
  });
  try {
    expect(seen).toMatchObject([[{ machineId: "self", peer: { kind: "client" }, generation: 1 }]]);
  } finally { await app.stop(); }
});

test("a remote attach records excess capabilities in the boot catalog before listing", async () => {
  const listen = socketPath();
  const enrollment: Machine.Enrollment = {
    machineId: "remote", name: "Remote", allowedCapabilities: ["fs.read"],
    publicKey: "a".repeat(64), enrolledAt: 1,
  };
  let host: Machines.MachineHost | undefined;
  const original = Gateway.toolPorts;
  spies.push(spyOn(Gateway, "toolPorts").mockImplementation((runtime, ports) => {
    host = ports.machines?.host;
    return original(runtime, ports);
  }));
  const app = await startOni({ config: fixtureConfig({
    self: testSelfMachine(), listen: { unix: listen }, enrolled: [enrollment],
  }) });
  const peer = await connectIpcClient(listen);
  try {
    expect(await peer.call(Machine.WireMethod.Attach, {
      machineId: "remote", offeredCapabilities: ["fs.read", "screen.read"],
      daemonVersion: "test", platform: "darwin-arm64", offeredAt: 2,
      peer: { kind: "client", contractVersion: Machine.contractVersion },
    })).toMatchObject({ status: "attached", effectiveCapabilities: ["fs.read"] });
    expect(host?.list().find((row) => row.machineId === "remote")).toMatchObject({
      machineId: "remote", pendingCapabilities: ["screen.read"], capabilities: ["fs.read"],
    });
  } finally { await peer.close(); await app.stop(); }
});

test("boot creates a private inbox and self settings before serving files", async () => {
  const fixture = await selfFixture();
  const inbox = join(fixture.root, "inbox");
  try {
    const self = await fixture.attach({ plane: {
      ...fixture.plane, inbox,
      self: { ...fixture.plane.self, exports: [{ name: "workspace", path: fixture.root }] },
    } });
    await runEffect(self.ready);
    writeFileSync(join(inbox, "ordinary.txt"), "inbox-data");
    expect(statSync(inbox).mode & 0o777).toBe(0o700);
    expect(statSync(selfSettings(fixture.root, "self")).mode & 0o777).toBe(0o600);
    const file = await runEffect(fixture.host.get("self").fs.read(join(inbox, "ordinary.txt")));
    expect(new TextDecoder().decode(file.data)).toBe("inbox-data");
  } finally { await fixture.close(); }
});

test("a listener that cannot bind fails boot with self_attach_failed", async () => {
  await expect(startOni({ config: fixtureConfig({
    self: testSelfMachine(), listen: { unix: join(directory(), "missing", "machines.sock") }, enrolled: [],
  }) })).rejects.toMatchObject({
    data: { code: "self_attach_failed", cause: expect.stringContaining("host listener failed") },
  });
});

test("a bad socket fails with a typed bounded self attachment error", async () => {
  const fixture = await selfFixture();
  try {
    await expect(fixture.attach({
      socketPath: join(fixture.root, "missing.sock"), attachTimeoutMs: 100,
    })).rejects.toBeInstanceOf(SelfAttachError);
  } finally { await fixture.close(); }
});

test("an unenrolled self fails closed at the injected attachment deadline", async () => {
  const fixture = await selfFixture(false);
  try {
    await expect(fixture.attach({ attachTimeoutMs: 100 })).rejects.toMatchObject({
      data: { code: "self_attach_failed", cause: expect.stringContaining("deadline exceeded") },
    });
    expect(fixture.host.list()).toEqual([]);
  } finally { await fixture.close(); }
});

test("a real mclient exiting before attachment fails typed", async () => {
  const fixture = await selfFixture();
  // An invalid persisted generation makes the real client exit, rather than redial.
  const settings = selfSettings(fixture.root, "self");
  writeMclientSettings(settings, {
    machineId: "self", name: "self", host: "localhost", unix: fixture.options.socketPath,
    exports: fixture.plane.self.exports, tags: [], memoryBudgetMb: 96,
  });
  writeFileSync(join(settings, "..", "state.json"), '{"generation":0}');
  try {
    await expect(fixture.attach()).rejects.toMatchObject({
      data: { code: "self_attach_failed", cause: expect.stringContaining("exited before attachment: 2") },
    });
  } finally { await fixture.close(); }
});

test("changing the self machine id attaches with independent persisted generation", async () => {
  const first = await selfFixture();
  try {
    const self = await first.attach();
    await runEffect(self.ready);
    expect(first.host.list()).toMatchObject([{ machineId: "self", generation: 1 }]);
  } finally { await first.close(); }

  const second = await selfFixture(true, "replacement", first.root);
  try {
    const self = await second.attach();
    await runEffect(self.ready);
    expect(second.host.list()).toMatchObject([{ machineId: "replacement", generation: 1 }]);
    expect(statSync(selfSettings(first.root, "self")).isFile()).toBe(true);
    expect(statSync(selfSettings(first.root, "replacement")).isFile()).toBe(true);
  } finally { await second.close(); }
});

test("missing self exports fail before starting a child", async () => {
  await expect(startOni({ config: fixtureConfig({
    self: { capabilities: ["fs.read"], exports: [] }, listen: { unix: socketPath() }, enrolled: [],
  }) })).rejects.toMatchObject({
    data: { code: "self_attach_failed", cause: expect.stringContaining("machine configuration invalid") },
  });
});

test("a capability-poor self boots because a typed refusal proves liveness", async () => {
  const app = await startOni({ config: fixtureConfig({
    self: { capabilities: ["shell.exec"], exports: testSelfMachine().exports },
    listen: { unix: socketPath() }, enrolled: [],
  }) });
  await app.stop();
});

test("unexpected child exit reaches onClose and fails the liveness probe", async () => {
  const fixture = await selfFixture();
  try {
    const self = await fixture.attach();
    const kill = spyOn(process, "kill");
    spies.push(kill);
    const detached = Promise.withResolvers<void>();
    const unsubscribe = fixture.options.events.subscribe(Machine.Events.Detached, () => detached.resolve());
    const timeout = setTimeout(() => detached.reject(new Error("detach deadline")), 5000);
    try {
      process.kill(self.pid, "SIGKILL");
      await detached.promise;
      expect(await fixture.closed.promise).toBeInstanceOf(SelfAttachError);
      await expect(runEffect(self.ready)).rejects.toMatchObject({
        data: { code: "self_attach_failed", cause: expect.stringContaining("disconnected during boot") },
      });
      await fixture.close();
      expect(kill.mock.calls.filter(([pid]) => pid === -self.pid)).toEqual([[-self.pid, "SIGKILL"]]);
    } finally { clearTimeout(timeout); unsubscribe(); }
  } finally { await fixture.close(); }
});

test("a self client dying between admission and the boot probe publishes no tool ports", async () => {
  const original = SelfMachineComposition.attachSelfMachine;
  spies.push(spyOn(SelfMachineComposition, "attachSelfMachine").mockImplementation((options) =>
    original(options).pipe(Effect.map((self) => ({
      ...self,
      ready: Effect.gen(function* () {
        const detached = Promise.withResolvers<void>();
        const unsubscribe = options.events.subscribe(Machine.Events.Detached, ({ machineId }) => {
          if (machineId === self.machineId) detached.resolve();
        });
        try {
          process.kill(self.pid, "SIGKILL");
          yield* Effect.promise(() => detached.promise);
          yield* self.ready;
        } finally { unsubscribe(); }
      }),
    }))),
  ));
  const ports = spyOn(Gateway, "toolPorts");
  spies.push(ports);
  await expect(startOni({ config: fixtureConfig({
    self: testSelfMachine(), listen: { unix: socketPath() }, enrolled: [],
  }) })).rejects.toMatchObject({
    data: { code: "self_attach_failed", cause: expect.stringContaining("disconnected during boot") },
  });
  expect(ports).not.toHaveBeenCalled();
});

test("closing the scope reaps the child without reporting an unexpected close", async () => {
  const fixture = await selfFixture();
  let closed = false;
  const self = await fixture.attach({ onClose: () => { closed = true; } });
  await fixture.close();
  expect(() => process.kill(self.pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
  expect(closed).toBe(false);
});

test("a second real client cannot replace the protected self attachment", async () => {
  const fixture = await selfFixture();
  try {
    const self = await fixture.attach();
    const path = join(fixture.root, "impostor", "client.json");
    writeMclientSettings(path, {
      machineId: "self", name: "self", host: "localhost", unix: fixture.options.socketPath,
      exports: fixture.plane.self.exports, tags: [], memoryBudgetMb: 96,
    });
    // A stale generation is terminal; it cannot displace the incumbent.
    writeFileSync(join(fixture.root, "impostor", "state.json"), '{"generation":999}');
    const pending = spawnAttachedMclient({
      configPath: path, host: fixture.host, events: fixture.options.events, machineId: "self",
    });
    await expect(pending).rejects.toThrow("mclient exited before attachment: 3");
    expect(fixture.host.list()[0]?.generation).toBe(1);
    await runEffect(self.ready);
  } finally { await fixture.close(); }
});
